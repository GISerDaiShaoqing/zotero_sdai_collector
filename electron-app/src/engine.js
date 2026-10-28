// 流水线引擎：捕获 → 抓取 → 查重 → LLM 分类 → 论文匹配 → 写入 Zotero / 待确认。
// 事件驱动：'update'（状态+记录快照，发给主面板）、'hud'（右下角卡片）。
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const store = require('./store');
const zotero = require('./zotero');
const extract = require('./extract');
const classify = require('./classify');
const paper = require('./paper');
const feishu = require('./feishu');

const DUP_WINDOW = 600000; // 同一链接 10 分钟内重复捕获忽略
const TREE_CACHE = path.join(store.DATA_DIR, 'collections_cache.json');

function kindOf(url) {
  if (/mp\.weixin\.qq\.com/i.test(url)) return 'wechat';
  if (extract.isPaperUrl(url)) return 'paper';
  return 'unknown';
}

class Engine extends EventEmitter {
  constructor() {
    super();
    this.tree = [];
    this.queue = [];
    this.busy = false;
    this.paused = false;
    this.recentCopies = new Map(); // url -> ts
    this.lastSel = null;           // 最近一次探测到的选中集合 { id, name, at }
    this._retryTimer = null;
  }

  log(msg) {
    try {
      fs.appendFileSync(path.join(store.DATA_DIR, 'app.log'),
        `${new Date().toISOString().slice(0, 19).replace('T', ' ')} ${msg}\n`, 'utf8');
    } catch {}
  }

  async init() {
    await this.loadTree();
    this._retryTimer = setInterval(() => this._retryPendingWrites(), 300000);
  }

  async loadTree() {
    try {
      this.tree = await zotero.getCollections();
    } catch (e) {
      try {
        this.tree = JSON.parse(fs.readFileSync(TREE_CACHE, 'utf8'));
        this.log(`集合树用缓存（Zotero 不可用：${e.message}）`);
      } catch {
        this.tree = this.tree || [];
      }
    }
    if (this.tree.length) {
      try { fs.writeFileSync(TREE_CACHE, JSON.stringify(this.tree), 'utf8'); } catch {}
    }
    this._broadcast();
    return this.tree.length;
  }

  status() {
    const cfg = store.getConfig();
    return {
      listening: !this.paused,
      nCollections: this.tree.length,
      llm: cfg.llmBaseUrl ? (cfg.llmModel || '默认') : '未配置',
      feishu: feishu.isRunning(),
      nPending: store.byStatus('pending').length,
      processing: this.busy,
    };
  }

  syncFeishu() {
    const c = store.getConfig();
    if (c.feishuAppId && c.feishuAppSecret) {
      const r = feishu.start(c.feishuAppId, c.feishuAppSecret, (url, hints) => {
        this.log(`飞书收到链接：${url}${hints && hints.length ? `（指定：${hints.join('、')}）` : ''}`);
        this.enqueueUrl(url, hints);
      });
      this.log(`飞书监听：${r.ok ? '已启动' : '启动失败 ' + (r.reason || '')}`);
    } else {
      feishu.stop();
    }
  }

  _broadcast() {
    this.emit('update', { status: this.status(), events: store.recent(60) });
  }

  // 当前"用户停留的集合"：实时探测；读不到（如开着文章标签页）时用 5 分钟内最近停留的集合兜底
  async _currentSelection() {
    if (store.getConfig().followZoteroSelection === false) return null;
    try {
      const sel = await zotero.getSelectedCollection();
      if (sel) {
        this.lastSel = { ...sel, at: Date.now() };
        return sel;
      }
    } catch {}
    if (this.lastSel && Date.now() - this.lastSel.at < 300000) {
      return { id: this.lastSel.id, name: this.lastSel.name };
    }
    return null;
  }

  hud(payload) {
    this.emit('hud', payload);
  }

  // ---- 消息指定分类的匹配 ----
  // 提示词的候选变体：原文 → 剥箭头/冒号 → 剥"存/进/到…"等引导词 → 再剥箭头 → 剥尾缀"里/中/内"
  _hintVariants(s) {
    const out = [s];
    let cur = s.replace(/^[→\-=▶>»~～:：]+/, '').trim();
    if (cur) out.push(cur);
    cur = cur.replace(/^(?:帮我|麻烦)?(?:依次|分别)?(?:存|进|放|到|入|归|分类|存入|放入|加入|收藏|扔|丢)[于到入为里]?(?:这|那)?(?:个|里)?/, '').trim();
    if (cur) out.push(cur);
    cur = cur.replace(/^[→\-=▶>»~～:：]+/, '').trim();
    if (cur) out.push(cur);
    cur = cur.replace(/(?:里|中|内)$/, '').trim();
    if (cur) out.push(cur);
    return out;
  }

  // 归一化编辑距离相似度（0~1）；196 个集合、短串，DP 开销可忽略
  _sim(a, b) {
    const m = a.length, n = b.length;
    if (!m || !n) return 0;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return 1 - prev[n] / Math.max(m, n);
  }

  // 集合树匹配（三级，逐级回退）：①全等 ②包含（提示词/集合名一方含另一方）③近似拼写（相似度≥0.8）。
  // 大小写与空格/连字符/下划线不敏感；任一级命中多个都只报歧义列候选，绝不静默猜一个。
  _resolveHints(hints) {
    const norm = (s) => String(s).toLowerCase().replace(/[\s\-_]+/g, '');
    const resolved = [], missed = [], ambiguous = [];
    for (const h0 of hints || []) {
      const h = String(h0).trim();
      if (!h) continue;
      let done = false;
      for (const v of this._hintVariants(h).filter(Boolean)) {
        const nv = norm(v);
        if (!nv) continue;
        const hasCjk = /[\u4e00-\u9fff]/.test(nv);
        let hits = this.tree.filter((c) => norm(c.name) === nv || norm(c.path) === nv);
        // 包含级：纯 ASCII 短词（如 "RS"）不参与，避免泛匹配刷屏
        if (!hits.length && (nv.length >= 3 || (hasCjk && nv.length >= 2))) {
          hits = this.tree.filter((c) => {
            const nn = norm(c.name), np = norm(c.path);
            return nn.includes(nv) || nv.includes(nn) || np.includes(nv) || nv.includes(np);
          });
        }
        // 近似级：名字较长才启用（短词编辑距离容易乱命中）
        if (!hits.length && nv.length >= 5) {
          hits = this.tree.filter((c) => this._sim(nv, norm(c.name)) >= 0.8 || this._sim(nv, norm(c.path)) >= 0.8);
        }
        if (hits.length === 1) { resolved.push(hits[0]); done = true; break; }
        if (hits.length > 1) {
          // 同名/包含命中去重后列候选；同名靠父路径消歧
          const optKeys = [...new Set(hits.map((c) => c.key))];
          ambiguous.push({ hint: v, options: optKeys.map((k) => this.tree.find((c) => c.key === k).path) });
          done = true;
          break;
        }
      }
      if (!done) missed.push(h);
    }
    const uniq = resolved.filter((c, i) => resolved.findIndex((x) => x.key === c.key) === i);
    return { resolved: uniq, missed, ambiguous };
  }

  // 确认卡上的说明文字；resolved 为空时头部一次列全（未命中+歧义），避免与 notes 重复
  _hintReason(hint, embeddedPaper = false) {
    const { resolved, missed, ambiguous } = hint;
    if (!resolved.length && !missed.length && !ambiguous.length) return '';
    const notes = [];
    for (const a of ambiguous) notes.push(`「${a.hint}」同名多个：${a.options.join(' / ')}（写 父路径/名字 可消歧）`);
    if (resolved.length && missed.length) notes.push(`未命中：${missed.join('、')}`);
    if (embeddedPaper) notes.push('内嵌论文已识别，确认后一并保存');
    const head = resolved.length
      ? `按消息指定：${resolved.map((c) => c.path).join('、')}`
      : `消息指定未命中：${[...missed, ...ambiguous.map((a) => a.hint)].join('、')}`;
    return `${head}${notes.length ? ` ｜ ${notes.join(' ｜ ')}` : ''}`;
  }

  // ---- 入口 ----
  enqueueUrl(url, hints = []) {
    const now = Date.now();
    if (now - (this.recentCopies.get(url) || 0) < DUP_WINDOW) {
      const prev = store.recent(50).slice().reverse().find((e) => e.url === url);
      // 已挂起等待确认时补发指定 → 改判该条目的分类并重弹卡
      if (prev && prev.status === 'pending' && hints.length) {
        const hint = this._resolveHints(hints);
        if (hint.resolved.length) {
          this.recentCopies.set(url, now);
          this._applyHintToPending(prev.id, hint, hints);
          return;
        }
      }
      // 上次处理失败/被忽略的链接允许重发（否则首次粘错后 10 分钟内怎么发都进不来）
      if (!(prev && (prev.status === 'failed' || prev.status === 'ignored'))) {
        this.log(`重复捕获忽略：${url}`);
        return;
      }
      this.log(`上次失败/忽略，允许重发：${url}`);
    }
    this.recentCopies.set(url, now);
    this.queue.push({ type: 'url', url, hints: hints || [] });
    this._drain();
  }

  // 给已挂起（pending）的条目改判分类：确认卡重弹，指定集合预选
  _applyHintToPending(id, hint, rawHints) {
    const row = store.recent(200).find((e) => e.id === id);
    if (!row || !row.payload) return;
    let p;
    try { p = JSON.parse(row.payload); } catch { return; }
    const cls = {
      ...(p.classification || {}),
      paths: hint.resolved.map((c) => c.path),
      keys: hint.resolved.map((c) => c.key),
      confidence: 1, note: 'hint',
    };
    store.updateEvent(id, { status: 'pending', confidence: 1, paths: cls.paths, keys: cls.keys, payload: JSON.stringify({ ...p, classification: cls }) });
    this.log(`按消息指定改判分类：${cls.paths.join('、')} (#${id})`);
    this.hud({
      type: 'confirm', id,
      title: row.title || row.url, blogTitle: row.blogTitle || '', date: row.publishDate || '',
      paths: cls.paths,
      reason: `${this._hintReason(hint, row.kind !== 'paper' && !!p.meta)}${hint.missed.length ? `（原提示：${rawHints.join('、')}）` : ''}`,
    });
    this._broadcast();
  }

  confirmChoose(id, paths) {
    this.queue.push({ type: 'confirm', id, paths });
    this._drain();
  }

  ignore(id) {
    store.updateEvent(id, { status: 'ignored' });
    this._broadcast();
  }

  reconfirmPending() {
    for (const row of store.byStatus('pending')) {
      let p = {};
      try { p = JSON.parse(row.payload || '{}'); } catch {}
      const cls = p.classification || {};
      this.hud({
        type: 'confirm', id: row.id,
        title: row.title || row.url, blogTitle: row.blogTitle || '', date: row.publishDate || '',
        paths: cls.paths || [],
        reason: cls.note === 'hint' ? '按消息指定' : (cls.confidence ? `置信度 ${Number(cls.confidence).toFixed(2)} 低于阈值` : '（无自动分类建议）'),
      });
    }
  }

  async _drain() {
    if (this.busy) return;
    this.busy = true;
    this._broadcast();
    while (this.queue.length) {
      const job = this.queue.shift();
      try {
        if (job.type === 'url') {
          const kind = kindOf(job.url);
          if (kind === 'paper') await this._processPaperUrl(job.url, job.hints);
          else await this._processUrl(job.url, job.hints);
        }
        else if (job.type === 'confirm') await this._writePending(job.id, job.paths, job.via);
      } catch (e) {
        this.log(`任务异常 ${JSON.stringify(job).slice(0, 80)}：${e.message}`);
      }
    }
    this.busy = false;
    this._broadcast();
  }

  // ---- 流水线 ----
  async _processUrl(url, hints = []) {
    if (store.findSaved(url)) {
      this.hud({ type: 'result', ok: true, title: '已在库中，跳过', detail: '该链接此前已保存' });
      return;
    }
    const ev = store.addEvent({ url, kind: 'wechat' });
    this._broadcast();

    let article;
    const hint = this._resolveHints(hints); // 消息文字指定的集合（优先级最高）
    try {
      article = await extract.fetchArticle(url, store.getConfig().bodyChars);
    } catch (e) {
      // 正文抓取不是强制门槛：失败也可保存仅链接条目（标题用户在 Zotero 里补）
      this.log(`抓取失败：${url} → ${String(e.message || e)}`);
      const fcls = hint.resolved.length
        ? { paths: hint.resolved.map((c) => c.path), keys: hint.resolved.map((c) => c.key), confidence: 1, isPaper: false, paperTitleGuess: '', note: 'hint' }
        : null;
      store.updateEvent(ev.id, {
        status: 'pending',
        error: String(e.message || e),
        paths: fcls ? fcls.paths : undefined,
        keys: fcls ? fcls.keys : undefined,
        payload: JSON.stringify({ article: null, classification: fcls, meta: null }),
      });
      this.hud({
        type: 'confirm', id: ev.id, title: '（抓取失败 · 仅链接可存）',
        blogTitle: '', date: '', paths: fcls ? fcls.paths : [],
        reason: `${this._hintReason(hint)}${fcls ? ' ｜ ' : ''}${String(e.message || e).slice(0, 50)} ｜ 确认=存仅链接条目（标题自己补），忽略=丢弃`,
      });
      this._broadcast();
      return;
    }
    store.updateEvent(ev.id, {
      title: article.title, blogTitle: article.blogTitle, publishDate: article.publishDate,
    });
    this.log(`抓取成功：《${article.title.slice(0, 40)}》（${article.blogTitle} ${article.publishDate}）`);

    try {
      if (await zotero.recentUrlExists(url)) {
        store.updateEvent(ev.id, { status: 'ignored', error: 'zotero已存在' });
        this.hud({ type: 'result', ok: true, title: '已存在于 Zotero', detail: article.title.slice(0, 46) });
        this._broadcast();
        return;
      }
    } catch (e) {
      this.log(`Zotero 查重跳过：${e.message}`);
    }

    // 消息文字指定了集合 → 确认卡直接给指定集合（优先于"Zotero 停留直存"与 LLM）
    if (hint.resolved.length) {
      let meta = null;
      if ((article.arxivIds || []).length || (article.dois || []).length) {
        try { meta = await paper.lookup(article, ''); if (meta) this.log(`论文匹配：${meta.title.slice(0, 50)}`); } catch {}
      }
      const cls = {
        paths: hint.resolved.map((c) => c.path), keys: hint.resolved.map((c) => c.key),
        confidence: 1, isPaper: !!meta, paperTitleGuess: '', note: 'hint',
      };
      store.updateEvent(ev.id, {
        status: 'pending', confidence: 1, paths: cls.paths, keys: cls.keys,
        payload: JSON.stringify({ article, classification: cls, meta }),
      });
      this.log(`按消息指定分类：${cls.paths.join('、')}${hint.missed.length ? `（未命中：${hint.missed.join('、')}）` : ''}`);
      this.hud({
        type: 'confirm', id: ev.id,
        title: article.title, blogTitle: article.blogTitle, date: article.publishDate,
        paths: cls.paths, reason: this._hintReason(hint, !!meta),
      });
      this._broadcast();
      return;
    }

    // 用户在 Zotero 里停在具体集合 → 直接入该集合（connector 直存，跳过 LLM 分类与确认卡）
    try {
      const sel = await this._currentSelection();
      if (sel) {
        let meta = null;
        if ((article.arxivIds || []).length || (article.dois || []).length) {
          try { meta = await paper.lookup(article, ''); if (meta) this.log(`论文匹配：${meta.title.slice(0, 50)}`); } catch {}
        }
        const items = [this._blogpostItem(article, [])];
        if (meta) items.push(this._paperItem(meta, []));
        await zotero.connectorSave(items);
        store.updateEvent(ev.id, {
          status: 'saved', via: 'confirm', paths: [sel.name], keys: [],
          payload: JSON.stringify({ article, classification: { paths: [sel.name], keys: [], confidence: 1, isPaper: !!meta, paperTitleGuess: '' }, meta }),
        });
        this.log(`按选中集合直存：${sel.name}`);
        this.hud({ type: 'result', ok: true, title: '已存入 Zotero', detail: `${article.title.slice(0, 36)} → ${sel.name}` });
        this._broadcast();
        return;
      }
    } catch (e) {
      this.log(`选中集合直存失败，转常规流程：${e.message}`);
    }

    const cfg = store.getConfig();
    let cls;
    try {
      cls = await classify.classify(article, this.tree, cfg);
    } catch (e) {
      cls = classify.emptyCls ? classify.emptyCls('classify_error') : { paths: [], keys: [], confidence: 0, isPaper: false, paperTitleGuess: '', note: 'classify_error' };
    }

    let meta = null;
    if (cls.isPaper) {
      try {
        meta = await paper.lookup(article, cls.paperTitleGuess);
        if (meta) this.log(`论文匹配：${meta.title.slice(0, 50)}`);
      } catch (e) {
        this.log(`论文匹配失败：${e.message}`);
      }
    }

    store.updateEvent(ev.id, {
      confidence: cls.confidence,
      paths: cls.paths,
      keys: cls.keys,
      payload: JSON.stringify({ article, classification: cls, meta }),
    });

    if (cfg.autoWrite && cls.confidence >= cfg.threshold && cls.keys.length) {
      await this._write(ev.id, article, cls, meta);
    } else {
      store.updateEvent(ev.id, { status: 'pending' });
      let reason = !cfg.autoWrite
        ? '全自动写入未开启（点确认后按下方建议保存）'
        : (cls.keys.length
            ? `置信度 ${Number(cls.confidence).toFixed(2)} 低于阈值 ${cfg.threshold}`
            : '没有匹配到合适的集合');
      if (hint.resolved.length || hint.missed.length || hint.ambiguous.length) {
        reason += ` ｜ ${this._hintReason(hint)}`;
      }
      this.hud({
        type: 'confirm', id: ev.id,
        title: article.title, blogTitle: article.blogTitle, date: article.publishDate,
        paths: cls.paths, reason,
      });
    }
    this._broadcast();
  }

  // ---- 流水线（论文直链）----
  async _processPaperUrl(url, hints = []) {
    if (store.findSaved(url)) {
      this.hud({ type: 'result', ok: true, title: '已在库中，跳过', detail: '该链接此前已保存' });
      return;
    }
    const ev = store.addEvent({ url, kind: 'paper' });
    this._broadcast();

    let meta;
    try {
      meta = await paper.lookupByUrl(url);
    } catch (e) {
      meta = null;
    }
    if (!meta || !meta.title) {
      const blocked = /cell\.com|sciencedirect\.com/i.test(url);
      const msg = blocked
        ? '该出版商（Cell/Elsevier 系）反爬封锁，无法自动识别——请从文章页复制 DOI 直链（doi.org/…）再发一次'
        : '识别不到论文元数据（页面被反爬或链接无效）';
      this.log(`论文元数据失败：${url}`);
      store.updateEvent(ev.id, { status: 'failed', error: msg });
      this.hud({ type: 'result', ok: false, title: '元数据获取失败', detail: msg.slice(0, 70) });
      this._broadcast();
      return;
    }
    this.log(`论文识别：${meta.title.slice(0, 50)}（${meta.journal || meta.itemType}）`);

    const pseudo = {
      url, title: meta.title, blogTitle: '', publishDate: meta.date || '',
      abstract: meta.abstract || '', body: '',
      paperLinks: [], arxivIds: [], dois: meta.doi ? [meta.doi] : [],
    };
    // 消息文字指定了集合 → 确认卡直接给指定集合（优先于"Zotero 停留直存"与 LLM）
    const hint = this._resolveHints(hints);
    if (hint.resolved.length) {
      const cls = {
        paths: hint.resolved.map((c) => c.path), keys: hint.resolved.map((c) => c.key),
        confidence: 1, isPaper: true, paperTitleGuess: '', note: 'hint',
      };
      store.updateEvent(ev.id, {
        title: meta.title, publishDate: meta.date || '',
        status: 'pending', confidence: 1, paths: cls.paths, keys: cls.keys,
        payload: JSON.stringify({ article: pseudo, classification: cls, meta }),
      });
      this.log(`按消息指定分类（论文）：${cls.paths.join('、')}`);
      this.hud({
        type: 'confirm', id: ev.id,
        title: meta.title, blogTitle: meta.journal || '', date: meta.date || '',
        paths: cls.paths, reason: this._hintReason(hint),
      });
      this._broadcast();
      return;
    }
    // 用户停在具体集合 → 论文直接入该集合
    try {
      const sel = await this._currentSelection();
      if (sel) {
        await zotero.connectorSave([this._paperItem(meta, [])]);
        store.updateEvent(ev.id, {
          status: 'saved', via: 'confirm', paths: [sel.name], keys: [],
          payload: JSON.stringify({ article: pseudo, classification: { paths: [sel.name], keys: [], confidence: 1, isPaper: true, paperTitleGuess: '' }, meta }),
        });
        this.log(`按选中集合直存论文：${sel.name}`);
        this.hud({ type: 'result', ok: true, title: '已存入 Zotero', detail: `${meta.title.slice(0, 36)} → ${sel.name}` });
        this._broadcast();
        return;
      }
    } catch (e) {
      this.log(`选中集合直存失败，转常规流程：${e.message}`);
    }
    const cfg0 = store.getConfig();
    let cls;
    try {
      cls = await classify.classify(pseudo, this.tree, cfg0);
    } catch {
      cls = { paths: [], keys: [], confidence: 0, isPaper: false, paperTitleGuess: '', note: 'classify_error' };
    }
    store.updateEvent(ev.id, {
      title: meta.title, publishDate: meta.date || '',
      confidence: cls.confidence, paths: cls.paths, keys: cls.keys,
      payload: JSON.stringify({ article: pseudo, classification: cls, meta }),
    });
    const cfg = store.getConfig();
    if (cfg.autoWrite && cls.confidence >= cfg.threshold && cls.keys.length) {
      await this._write(ev.id, pseudo, cls, meta, true);
    } else {
      store.updateEvent(ev.id, { status: 'pending' });
      let reason = !cfg.autoWrite
        ? '全自动写入未开启（点确认后按下方建议保存）'
        : (cls.keys.length
            ? `置信度 ${Number(cls.confidence).toFixed(2)} 低于阈值 ${cfg.threshold}`
            : '没有匹配到合适的集合（确认后存入库根目录）');
      if (hint.missed.length || hint.ambiguous.length) {
        reason += ` ｜ ${this._hintReason(hint)}`;
      }
      this.hud({
        type: 'confirm', id: ev.id,
        title: meta.title, blogTitle: meta.journal || '', date: meta.date || '',
        paths: cls.paths, reason,
      });
    }
    this._broadcast();
  }

  // ---- 写入 ----
  _blogpostItem(article, keys) {
    const it = { itemType: 'blogPost', title: article.title, url: article.url, collections: keys };
    if (article.blogTitle) {
      it.blogTitle = article.blogTitle;
      // 公众号名写入"创建者"列（与 Zotero 微信翻译器的习惯一致）
      it.creators = [{ creatorType: 'author', name: article.blogTitle, fieldMode: 1 }];
    }
    if (article.publishDate) it.date = article.publishDate;
    if (article.abstract) it.abstractNote = article.abstract;
    return it;
  }

  // 论文条目字段与用户库习惯对齐：期刊论文带 ISSN/期刊缩写/出版商/语言/访问时间；
  // preprint 用 repository + archiveID（arXiv）而非 extra。
  _paperItem(meta, keys) {
    const it = { itemType: meta.itemType, title: meta.title, creators: meta.creators, collections: keys };
    if (meta.date) it.date = meta.date;
    if (meta.doi) it.DOI = meta.doi;
    if (meta.url) it.url = meta.url;
    if (meta.journal) it.publicationTitle = meta.journal;
    if (meta.journalAbbrev) it.journalAbbreviation = meta.journalAbbrev;
    if (meta.volume) it.volume = meta.volume;
    if (meta.issue) it.issue = meta.issue;
    if (meta.pages) it.pages = meta.pages;
    if (meta.issn) it.ISSN = meta.issn;
    if (meta.publisher) it.publisher = meta.publisher;
    if (meta.language) it.language = meta.language;
    if (meta.abstract) it.abstractNote = meta.abstract;
    if (meta.arxivId) it.extra = `arXiv: ${meta.arxivId}`;
    // 标签：preprint 的 arXiv 分类 + 各通道关键词（去重）；公众号推送不打标签
    const tags = [];
    const seenTag = new Set();
    if (meta.itemType === 'preprint' && meta.arxivCategory) {
      tags.push({ tag: meta.arxivCategory, type: 1 });
      seenTag.add(meta.arxivCategory.toLowerCase());
    }
    for (const kw of (meta.keywords || [])) {
      const t = String(kw).trim();
      if (t && !seenTag.has(t.toLowerCase())) {
        seenTag.add(t.toLowerCase());
        tags.push({ tag: t, type: 1 });
      }
    }
    if (tags.length) it.tags = tags;
    if (meta.itemType === 'preprint') {
      it.repository = 'arXiv';
      if (meta.arxivId) it.archiveID = `arXiv:${meta.arxivId}`;
    }
    it.accessDate = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    it.libraryCatalog = 'zotero_sdai_collector';
    return it;
  }

  async _write(id, article, cls, meta, paperOnly = false, via = 'auto') {
    const keys = cls.keys || [];
    const items = paperOnly
      ? [this._paperItem(meta, keys)]
      : (meta ? [this._blogpostItem(article, keys), this._paperItem(meta, keys)]
              : [this._blogpostItem(article, keys)]);
    try {
      const itemKeys = await zotero.createItems(items);
      // via：confirm=用户在卡片上亲自确认（金标，可作分类示例）；auto=高置信自动写入
      store.updateEvent(id, { status: 'saved', itemKeys, via });
      this.hud({
        type: 'result', ok: true, title: '已存入 Zotero',
        detail: `${article.title.slice(0, 40)} → ${cls.paths.join('、') || '（未归集合）'}${!paperOnly && meta ? '（含论文条目）' : ''}`,
      });
    } catch (e) {
      if (e.kind === 'unavailable') {
        store.updateEvent(id, { status: 'pending_write', error: e.message });
        this.hud({ type: 'result', ok: false, title: 'Zotero 未运行', detail: '已暂存，Zotero 打开后自动补写' });
      } else {
        store.updateEvent(id, { status: 'failed', error: e.message });
        this.hud({ type: 'result', ok: false, title: e.kind === 'auth' ? '未获授权' : '写入失败', detail: e.message.slice(0, 90) });
      }
    }
    this._broadcast();
  }

  async _writePending(id, chosenPaths, via = 'confirm') {
    const row = store.byStatus('pending').find((e) => e.id === id) || store.recent(200).find((e) => e.id === id);
    if (!row || !row.payload) {
      store.updateEvent(id, { status: 'failed', error: 'payload 缺失' });
      return;
    }
    let p;
    try { p = JSON.parse(row.payload); } catch {
      store.updateEvent(id, { status: 'failed', error: 'payload 损坏' });
      return;
    }
    if (row.status === 'saved') return; // 已写过（改判/重复确认卡防重）
    const meta = p.meta || null;
    const pathToKey = new Map(this.tree.map((c) => [c.path, c.key]));
    // 论文直链只写论文条目（此前误走微信文章分支，多出一条重复 blogPost）
    const paperOnly = row.kind === 'paper';

    // 抓取失败的兜底：仅链接条目（标题/字段由用户在 Zotero 补全）；有指定/勾选集合就带上
    if (!p.article) {
      const keys = Array.isArray(chosenPaths) && chosenPaths.length
        ? chosenPaths.map((pt) => pathToKey.get(pt)).filter(Boolean)
        : [];
      const emptyArticle = { url: row.url, title: '', blogTitle: '', publishDate: '', abstract: '', body: '', paperLinks: [], arxivIds: [], dois: [] };
      const emptyCls = { paths: chosenPaths && chosenPaths.length ? chosenPaths : [], keys, confidence: 0, isPaper: false, paperTitleGuess: '' };
      const item = { itemType: 'blogPost', title: row.url, url: row.url, collections: keys };
      try {
        const itemKeys = await zotero.createItems([item]);
        store.updateEvent(id, { status: 'saved', itemKeys, paths: emptyCls.paths, keys });
        this.hud({ type: 'result', ok: true, title: '已存入 Zotero（仅链接）', detail: `标题请手动补全${emptyCls.paths.length ? ` → ${emptyCls.paths.join('、')}` : ''}` });
      } catch (e) {
        store.updateEvent(id, { status: e.kind === 'unavailable' ? 'pending_write' : 'failed', error: e.message });
        this.hud({ type: 'result', ok: false, title: '写入失败', detail: e.message.slice(0, 70) });
      }
      this._broadcast();
      return;
    }

    const article = p.article;
    let cls = p.classification || { paths: [], keys: [], confidence: 0, isPaper: false, paperTitleGuess: '' };
    if (Array.isArray(chosenPaths)) {
      cls = {
        ...cls,
        paths: chosenPaths,
        keys: chosenPaths.map((pt) => pathToKey.get(pt)).filter(Boolean),
      };
    }
    await this._write(id, article, cls, meta, paperOnly, via);
  }

  _retryPendingWrites() {
    for (const row of store.byStatus('pending_write')) {
      this.log(`重试暂存写入 #${row.id}`);
      // 当初是自动写入失败 → 补写仍算 auto，不算用户确认
      this.queue.push({ type: 'confirm', id: row.id, paths: undefined, via: 'auto' });
    }
    if (this.queue.length) this._drain();
  }

  dispose() {
    if (this._retryTimer) clearInterval(this._retryTimer);
  }
}

module.exports = new Engine();

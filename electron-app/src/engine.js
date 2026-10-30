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
    // 队列在内存里：上次运行残留的 new 行此刻不可能再被处理，
    // 全部回收成 failed（面板可见 + 10 分钟内允许原样重发重试）
    for (const row of store.recent(200)) {
      if (row.status === 'new') {
        store.updateEvent(row.id, { status: 'failed', error: '上次未完成（应用退出中断）；重发该链接即可重试' });
        this.log(`回收上次未完成任务 #${row.id}`);
      }
    }
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
      const r = feishu.start(c.feishuAppId, c.feishuAppSecret, (url, hints, paperUrls = []) => {
        this.log(`飞书收到链接：${url}${hints && hints.length ? `（指定：${hints.join('、')}）` : ''}${paperUrls.length ? `（另附论文链接 ${paperUrls.length} 条）` : ''}`);
        this.enqueueUrl(url, hints, paperUrls);
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

  // 选中集合直存的记录用全路径显示（connector 协议只给短名 → 按名字在集合树里反查；
  // 同名多个时反查不可靠，保持短名不猜）
  _selectionPath(sel) {
    const hits = this.tree.filter((c) => c.name === sel.name);
    return hits.length === 1 ? hits[0].path : sel.name;
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

  // 论文元数据获取的统一入口：优先消息里另贴的论文链接（用户点名），其次文中内嵌的 arXiv/DOI
  async _lookupPaper(article, paperUrl = '', titleGuess = '') {
    if (paperUrl) {
      try {
        const m = await paper.lookupByUrl(paperUrl);
        if (m && m.title) return m;
      } catch {}
      this.log(`论文链接未匹配：${paperUrl}`);
    }
    if ((article.arxivIds || []).length || (article.dois || []).length) {
      try { return await paper.lookup(article, titleGuess) || null; } catch { return null; }
    }
    return null;
  }

  // 论文遗漏提醒文案（空串=无需提醒）：文章处理完没带上论文时告诉用户怎么补
  _paperWarn(article, meta, paperUrl = '') {
    if (meta) return '';
    if (paperUrl) return '论文链接没识别出元数据（可能被出版商反爬）——论文条目未保存，可稍后单独重发该链接';
    if ((article.arxivIds || []).length || (article.dois || []).length || (article.paperLinks || []).length) {
      return '文中发现论文链接但未匹配到论文条目——如需存论文，请把该论文链接单独补发一次';
    }
    return '未检测到论文链接——如该推送涉及论文，请把论文链接（arXiv/DOI 直链）一起粘贴再发';
  }

  // 手机侧论文提醒：链接从飞书来时处理完补一条回执（配对成功 or 缺论文提醒）。
  // 只回给最近发过这条链接的会话；抓取失败/已在库中等情形不打扰
  _feishuPaperReply(url, meta, warn) {
    const text = meta
      ? `📎 已识别论文：《${String(meta.title).slice(0, 40)}》，与文章一起处理`
      : (warn ? `⚠️ ${warn}` : '');
    if (text) feishu.notifyFor(url, text);
  }

  // ---- 入口 ----
  // otherPaperUrls：同一消息里另贴的论文链接。微信链接（主条目）取第一条配对，
  // 其余各自单独走论文流程；纯论文消息（url 本身是论文链接）全部单独处理。
  enqueueUrl(url, hints = [], otherPaperUrls = []) {
    const now = Date.now();
    const isPaperMain = kindOf(url) === 'paper';
    if (now - (this.recentCopies.get(url) || 0) < DUP_WINDOW) {
      const prev = store.recent(50).slice().reverse().find((e) => e.url === url);
      if (prev && prev.status === 'pending') {
        // 已挂起等待确认时补发指定 → 改判该条目的分类并重弹卡
        if (hints.length) {
          const hint = this._resolveHints(hints);
          if (hint.resolved.length) {
            this.recentCopies.set(url, now);
            for (const pu of (otherPaperUrls || []).slice(1)) this.enqueueUrl(pu);
            this._applyHintToPending(prev.id, hint, hints, (otherPaperUrls || [])[0] || '')
              .then((paired) => { if ((otherPaperUrls || [])[0] && !paired) this.enqueueUrl((otherPaperUrls || [])[0]); })
              .catch(() => {});
            return;
          }
        }
        // 已挂起且补发的是论文链接（指定没解析出来也一样配）→ 直接配对到该条目
        if (!isPaperMain && (otherPaperUrls || []).length) {
          this.recentCopies.set(url, now);
          for (const pu of (otherPaperUrls || []).slice(1)) this.enqueueUrl(pu);
          this._attachPaperToPending(prev.id, otherPaperUrls[0])
            .then((paired) => { if (!paired) this.enqueueUrl(otherPaperUrls[0]); })
            .catch(() => {});
          return;
        }
      }
      // 上次处理失败/被忽略的链接允许重发（否则首次粘错后 10 分钟内怎么发都进不来）
      if (prev && !(prev.status === 'failed' || prev.status === 'ignored')) {
        this.log(`重复捕获忽略：${url}`);
        return;
      }
      if (prev) this.log(`上次失败/忽略，允许重发：${url}`);
    }
    this.recentCopies.set(url, now);
    this.queue.push({
      type: 'url', url, hints: hints || [],
      paperUrl: isPaperMain ? '' : ((otherPaperUrls || [])[0] || ''),
    });
    for (const pu of (otherPaperUrls || []).slice(isPaperMain ? 0 : 1)) this.enqueueUrl(pu);
    this._drain();
  }

  // 给已挂起（pending）的条目改判分类：确认卡重弹，指定集合预选；
  // 带论文链接时顺手配对到该条目（补发场景）。返回值=论文链接是否已被消化（没消化由调用方转单独流程）
  async _applyHintToPending(id, hint, rawHints, paperUrl = '') {
    const row = store.recent(200).find((e) => e.id === id);
    if (!row || !row.payload) return false;
    let p;
    try { p = JSON.parse(row.payload); } catch { return false; }
    let meta = p.meta || null;
    let paperNote = '';
    if (paperUrl && p.article && !meta) {
      try { meta = await paper.lookupByUrl(paperUrl); } catch {}
      paperNote = meta ? `已补论文：《${String(meta.title).slice(0, 36)}》` : '补发的论文链接未识别出元数据';
      this.log(meta ? `补发论文配对：《${meta.title.slice(0, 50)}》 (#${id})` : `补发论文未匹配：${paperUrl} (#${id})`);
    }
    if ((store.recent(200).find((e) => e.id === id) || {}).status !== 'pending') return false; // 等待期间已被确认/保存
    const cls = {
      ...(p.classification || {}),
      paths: hint.resolved.map((c) => c.path),
      keys: hint.resolved.map((c) => c.key),
      confidence: 1, note: 'hint',
    };
    const warn = p.article ? this._paperWarn(p.article, meta, '') : '';
    store.updateEvent(id, {
      status: 'pending', confidence: 1, paths: cls.paths, keys: cls.keys,
      payload: JSON.stringify({ ...p, classification: cls, meta, warn }),
    });
    this.log(`按消息指定改判分类：${cls.paths.join('、')} (#${id})`);
    this.hud({
      type: 'confirm', id,
      title: row.title || row.url, blogTitle: row.blogTitle || '', date: row.publishDate || '',
      paths: cls.paths, warn,
      reason: `${this._hintReason(hint, row.kind !== 'paper' && !!meta)}${paperNote ? ` ｜ ${paperNote}` : ''}${hint.missed.length ? `（原提示：${rawHints.join('、')}）` : ''}`,
    });
    this._broadcast();
    return true;
  }

  // 待确认条目补发论文链接（不带指定分类）：抓元数据配对，重弹卡提示"已补论文"。
  // 返回值=是否配对成功（失败时调用方把链接转单独论文流程，不让它凭空消失；
  // 已配过对的也算已消化，避免补发重复弹出论文卡）
  async _attachPaperToPending(id, paperUrl) {
    if (!paperUrl) return true;
    const row = store.recent(200).find((e) => e.id === id);
    if (!row || !row.payload) return false;
    let p;
    try { p = JSON.parse(row.payload); } catch { return false; }
    if (p.meta) return true;           // 已有配对论文，无需再补
    if (!p.article) return false;      // 抓取失败的条目没有文章可配 → 转单独流程
    let meta = null;
    try { meta = await paper.lookupByUrl(paperUrl); } catch {}
    if (!meta) { this.log(`补发论文未匹配：${paperUrl} (#${id})`); return false; }
    if ((store.recent(200).find((e) => e.id === id) || {}).status !== 'pending') return false;
    this.log(`补发论文配对：《${meta.title.slice(0, 50)}》 (#${id})`);
    store.updateEvent(id, { payload: JSON.stringify({ ...p, meta, warn: '' }) });
    this.hud({
      type: 'confirm', id,
      title: row.title || row.url, blogTitle: row.blogTitle || '', date: row.publishDate || '',
      paths: (p.classification || {}).paths || [],
      reason: `已补论文：《${String(meta.title).slice(0, 36)}》，确认后一并保存`,
    });
    this._broadcast();
    return true;
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
        paths: cls.paths || [], warn: p.warn || '',
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
      // 看门狗：单任务超过 240s 仍不结束（下游挂死/超时未兜住）就放行后续队列，
      // 避免一条卡死的任务把整条流水线冻结（Zotero 忙、网络黑洞等场景）。
      // 240s 覆盖最坏正常链路：抓取重试+查重+论文匹配链+写库（正常 <2 分钟）。
      // 环境变量 EngineJobTimeoutMs 仅测试/诊断时用，平时无需设置。
      const JOB_TIMEOUT = Number(process.env.EngineJobTimeoutMs) || 240000;
      let taskP = null;
      try {
        if (job.type === 'url') {
          const kind = kindOf(job.url);
          taskP = kind === 'paper' ? this._processPaperUrl(job.url, job.hints) : this._processUrl(job.url, job.hints, job.paperUrl || '');
        }
        else if (job.type === 'confirm') taskP = this._writePending(job.id, job.paths, job.via);
      } catch (e) {
        this.log(`任务异常 ${JSON.stringify(job).slice(0, 80)}：${e.message}`);
      }
      const listed = taskP ? Promise.race([taskP, new Promise((_, rej) => {
        this._wdTimer = setTimeout(() => {
          const err = new Error(`超过 ${JOB_TIMEOUT / 1000}s 未结束（下游疑似挂死）`);
          rej(Object.assign(err, { watchdog: true }));
        }, JOB_TIMEOUT);
        // 超时不让进程被空拖住
        if (this._wdTimer.unref) this._wdTimer.unref();
      })]) : Promise.resolve();
      // 被看门狗放行后原任务再完成的晚到结果不再关心，晚到的异常也吞掉防 unhandledRejection
      if (taskP) taskP.catch(() => {});
      try {
        await listed;
      } catch (e) {
        const isWd = !!e.watchdog;
        this.log(`${isWd ? '任务超时放行' : '任务异常'} ${JSON.stringify(job).slice(0, 80)}：${e.message}`);
        // 任务级的"new"行（还没走到任何流转）立即标失败：面板可见 + 10 分钟内允许重发
        if (isWd && job.type === 'url') {
          for (const row of store.recent(20)) {
            if (row.url === job.url && row.status === 'new') store.updateEvent(row.id, { status: 'failed', error: '处理超时（下游疑似挂死）；重发该链接可重试' });
          }
        }
      }
    }
    this.busy = false;
    this._broadcast();
  }

  // ---- 流水线 ----
  async _processUrl(url, hints = [], paperUrl = '') {
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
      // 正文抓取不是强制门槛：失败也可保存仅链接条目（标题用户在 Zotero 里补）；
      // 另贴的论文链接不能跟着丢 → 单独走论文流程
      this.log(`抓取失败：${url} → ${String(e.message || e)}`);
      if (paperUrl) {
        this.log(`文章抓取失败，论文链接单独处理：${paperUrl}`);
        this.enqueueUrl(paperUrl);
      }
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
      const meta = await this._lookupPaper(article, paperUrl, '');
      if (meta) this.log(`论文匹配：${meta.title.slice(0, 50)}`);
      const cls = {
        paths: hint.resolved.map((c) => c.path), keys: hint.resolved.map((c) => c.key),
        confidence: 1, isPaper: !!meta, paperTitleGuess: '', note: 'hint',
      };
      const warn = this._paperWarn(article, meta, paperUrl);
      store.updateEvent(ev.id, {
        status: 'pending', confidence: 1, paths: cls.paths, keys: cls.keys,
        payload: JSON.stringify({ article, classification: cls, meta, warn }),
      });
      this.log(`按消息指定分类：${cls.paths.join('、')}${hint.missed.length ? `（未命中：${hint.missed.join('、')}）` : ''}`);
      this.hud({
        type: 'confirm', id: ev.id,
        title: article.title, blogTitle: article.blogTitle, date: article.publishDate,
        paths: cls.paths, warn, reason: this._hintReason(hint, !!meta),
      });
      this._feishuPaperReply(url, meta, warn);
      this._broadcast();
      return;
    }

    // 用户在 Zotero 里停在具体集合 → 直接入该集合（connector 直存，跳过 LLM 分类与确认卡）
    try {
      const sel = await this._currentSelection();
      if (sel) {
        const meta = await this._lookupPaper(article, paperUrl, '');
        if (meta) this.log(`论文匹配：${meta.title.slice(0, 50)}`);
        const items = [this._blogpostItem(article, [])];
        if (meta) items.push(this._paperItem(meta, []));
        await zotero.connectorSave(items);
        const warn = this._paperWarn(article, meta, paperUrl);
        const selPath = this._selectionPath(sel);
        store.updateEvent(ev.id, {
          status: 'saved', via: 'confirm', paths: [selPath], keys: [],
          payload: JSON.stringify({ article, classification: { paths: [selPath], keys: [], confidence: 1, isPaper: !!meta, paperTitleGuess: '' }, meta, warn }),
        });
        this.log(`按选中集合直存：${selPath}`);
        this.hud({ type: 'result', ok: true, title: '已存入 Zotero', detail: `${article.title.slice(0, 36)} → ${selPath}`, warn });
        this._feishuPaperReply(url, meta, warn);
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
    if (cls.isPaper || paperUrl) {
      // 用户另贴了论文链接时不受 LLM 判断限制（点名要的论文一定去找）
      meta = await this._lookupPaper(article, paperUrl, cls.paperTitleGuess);
      if (meta) this.log(`论文匹配：${meta.title.slice(0, 50)}`);
    }
    const warn = this._paperWarn(article, meta, paperUrl);

    store.updateEvent(ev.id, {
      confidence: cls.confidence,
      paths: cls.paths,
      keys: cls.keys,
      payload: JSON.stringify({ article, classification: cls, meta, warn }),
    });

    if (cfg.autoWrite && cls.confidence >= cfg.threshold && cls.keys.length) {
      await this._write(ev.id, article, cls, meta, false, 'auto', warn);
      this._feishuPaperReply(url, meta, warn);
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
        paths: cls.paths, warn, reason,
      });
      this._feishuPaperReply(url, meta, warn);
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
        const selPath = this._selectionPath(sel);
        await zotero.connectorSave([this._paperItem(meta, [])]);
        store.updateEvent(ev.id, {
          status: 'saved', via: 'confirm', paths: [selPath], keys: [],
          payload: JSON.stringify({ article: pseudo, classification: { paths: [selPath], keys: [], confidence: 1, isPaper: true, paperTitleGuess: '' }, meta }),
        });
        this.log(`按选中集合直存论文：${selPath}`);
        this.hud({ type: 'result', ok: true, title: '已存入 Zotero', detail: `${meta.title.slice(0, 36)} → ${selPath}` });
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

  async _write(id, article, cls, meta, paperOnly = false, via = 'auto', warn = '') {
    const keys = cls.keys || [];
    const items = paperOnly
      ? [this._paperItem(meta, keys)]
      : (meta ? [this._blogpostItem(article, keys), this._paperItem(meta, keys)]
              : [this._blogpostItem(article, keys)]);
    // 写前查重闸门：补写场景里"客户端超时中止"不代表没写进去（Zotero 正忙时会收下请求、
    // 忙完照常生效）。补写前必须确认库里确实没有；查重不可判定（Zotero 没响应）时绝不盲写。
    let checkFailed = null;
    try {
      for (const it of items) {
        if (!it.url) continue;
        if (await zotero.recentUrlExists(it.url)) {
          store.updateEvent(id, { status: 'saved', itemKeys: [], via });
          this.log(`写前查重命中（跳过重复写入）：${it.title.slice(0, 40)}`);
          this.hud({ type: 'result', ok: true, title: '已在库中，跳过', detail: `${it.title.slice(0, 44)}（此前写入其实已生效）` });
          this._broadcast();
          return;
        }
      }
    } catch (e) {
      if (e.kind === 'unavailable') {
        store.updateEvent(id, { status: 'pending_write', error: e.message });
        this.hud({ type: 'result', ok: false, title: e.message.includes('没响应') ? 'Zotero 没响应' : 'Zotero 未运行', detail: '已暂存，恢复后自动补写（补写前先查重，不会重复入库）' });
        this._broadcast();
        return;
      }
      checkFailed = e.message; // 其它查重错误（如 HTTP 异常）不做拦截，照常尝试写入
    }
    if (checkFailed) this.log(`写前查重失败（照常尝试写入）：${checkFailed}`);
    try {
      const itemKeys = await zotero.createItems(items);
      // via：confirm=用户在卡片上亲自确认（金标，可作分类示例）；auto=高置信自动写入
      store.updateEvent(id, { status: 'saved', itemKeys, via });
      this.hud({
        type: 'result', ok: true, title: '已存入 Zotero',
        detail: `${article.title.slice(0, 40)} → ${cls.paths.join('、') || '（未归集合）'}${!paperOnly && meta ? '（含论文条目）' : ''}`,
        warn,
      });
    } catch (e) {
      if (e.kind === 'unavailable') {
        store.updateEvent(id, { status: 'pending_write', error: e.message });
        this.hud({ type: 'result', ok: false, title: e.message.includes('没响应') ? 'Zotero 没响应' : 'Zotero 未运行', detail: '已暂存，恢复后自动补写（补写前先查重）' });
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

// LLM 分类：支持 OpenAI 兼容接口与本地 Ollama（端口 11434 自动识别，think:false 关思考）。
// 用户过往"确认保存"时选过的归类会作为【历史确认示例】注入提示词（few-shot），
// 让本地小模型跟随用户的分类习惯——记录越多、越常确认，分类越贴个人偏好。
const store = require('./store');

const SYS_PROMPT =
  '你是科研文献归类助手。用户是遥感、生态环境、城市与人文地理、空间数据科学方向的科研人员，' +
  '需要把微信公众号文章归入其 Zotero 集合树。规则：\n' +
  '1. collections 从给定集合树中逐字选取完整路径（父子以 / 分隔），最多 3 个，按贴切度排序；' +
  '树中存在同名集合，必须以完整路径区分；若与所有集合都不沾边则输出 []。\n' +
  '2. confidence 为归类置信度 0~1；都不沾边时不超过 0.3。\n' +
  '3. is_paper_push 仅当文章主体是在介绍/解读某一篇特定的学术论文（正文含论文标题、作者或方法结果）时为 true；' +
  '软件发布、教程、新闻资讯、征稿启事、数据集/资源分享一律为 false。\n' +
  '4. paper_title_guess 必须是正文中出现的论文英文原标题；找不到或 is_paper_push 为 false 时必须留空。\n' +
  '5. confidence 保守：只要对归类不完全确定，就降到 0.6 以下——宁可让用户确认，也不要自信犯错。\n' +
  '6. 若给出【历史确认示例】，这些是该用户亲自确认过的归类；主题相近的文章优先沿用示例中的集合偏好，' +
  '示例风格与用户习惯冲突时以示例为准。\n' +
  '只输出 JSON，不要任何多余文字。';

function norm(p) {
  return String(p || '').trim().replace(/\\/g, '/').replace(/\s+/g, ' ');
}

function emptyCls(note) {
  return { paths: [], keys: [], confidence: 0, isPaper: false, paperTitleGuess: '', note };
}

function bigrams(s) {
  const t = String(s || '').toLowerCase().replace(/\s+/g, '');
  const g = new Set();
  for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2));
  return g;
}

// 挑 few-shot 示例：只取用户确认过且带集合的记录；按标题/公众号/摘要/正文前段与标题、路径名的
// 二字组重合度打分，取最相关的 n 条。via=auto 的（将来自动写入的）不算金标。
function historyExamples(article, n = 6) {
  const pool = store.recent(200).filter((e) =>
    e.status === 'saved' && Array.isArray(e.paths) && e.paths.length && e.title && e.via !== 'auto'
  );
  if (!pool.length) return [];
  const cur = bigrams(
    `${article.title || ''}${article.blogTitle || ''}${article.abstract || ''}${(article.body || '').slice(0, 800)}`
  );
  const scored = pool.map((e) => {
    let s = 0;
    for (const g of bigrams(`${e.title}${e.blogTitle || ''}`)) if (cur.has(g)) s++;
    for (const g of bigrams(e.paths.join(''))) if (cur.has(g)) s += 1;
    return { e, s };
  });
  scored.sort((a, b) => b.s - a.s || (b.e.id || 0) - (a.e.id || 0));
  const picked = [];
  const seen = new Set();
  for (const { e } of scored) {
    const k = String(e.title).slice(0, 40);
    if (seen.has(k)) continue;
    seen.add(k);
    picked.push(e);
    if (picked.length >= n) break;
  }
  return picked;
}

async function callLlm(cfg, user) {
  const isOllama = /:11434/.test(cfg.llmBaseUrl);
  if (isOllama) {
    // Ollama 原生接口：think:false 关闭思考（qwen3 系推理模型必须关，否则正文为空且极慢）
    const base = cfg.llmBaseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
    const r = await fetch(base + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.llmModel,
        messages: [
          { role: 'system', content: SYS_PROMPT },
          { role: 'user', content: user },
        ],
        think: false,
        stream: false,
      }),
      signal: AbortSignal.timeout(120000),
    });
    if (!r.ok) return { ok: false, status: r.status, content: '' };
    const d = await r.json();
    return { ok: true, content: (d.message && (d.message.content || d.message.reasoning)) || '' };
  }
  // OpenAI 兼容接口
  const r = await fetch(cfg.llmBaseUrl.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.llmKey}` },
    body: JSON.stringify({
      model: cfg.llmModel,
      messages: [
        { role: 'system', content: SYS_PROMPT },
        { role: 'user', content: user },
      ],
      temperature: 0.1,
      max_tokens: 2000,
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) return { ok: false, status: r.status, content: '' };
  const d = await r.json();
  const msg = (d.choices && d.choices[0] && d.choices[0].message) || {};
  return { ok: true, content: msg.content || msg.reasoning || '' };
}

async function classify(article, tree, cfg) {
  if (!cfg.llmBaseUrl) return emptyCls('no_llm_key');

  const pathToKey = new Map(tree.map((c) => [norm(c.path), c.key]));
  const treeText = tree.map((c) => '- ' + c.path).join('\n');
  const ex = historyExamples(article);
  const exBlock = ex.length
    ? `\n\n【历史确认示例】该用户此前亲自确认过的归类（主题相近时优先沿用）：\n` +
      ex.map((e, i) =>
        `${i + 1}. 《${String(e.title).slice(0, 60)}》${e.blogTitle ? `（${e.blogTitle}）` : ''} → ${e.paths.join('；')}`
      ).join('\n')
    : '';
  const user =
    `【集合树】共 ${tree.length} 个集合（完整路径）：\n${treeText}${exBlock}\n\n` +
    `【待归类文章】\n标题：${article.title}\n公众号：${article.blogTitle || '（未知）'}\n` +
    `日期：${article.publishDate || '（未知）'}\n摘要：${article.abstract || '（无）'}\n` +
    `正文节选：${article.body || '（无）'}\n\n` +
    `只输出 JSON：{"collections": ["完整路径"], "confidence": 0.0, "is_paper_push": false, "paper_title_guess": ""}`;

  let res;
  try {
    res = await callLlm(cfg, user);
  } catch (e) {
    return emptyCls('llm_error:' + (e.cause ? e.cause.code || e.cause.message : e.message));
  }
  if (!res.ok) return emptyCls(`llm_http_${res.status}`);

  try {
    const m = res.content.match(/\{[\s\S]*\}/);
    const d = JSON.parse(m ? m[0] : res.content);
    const matched = [];
    const dropped = [];
    for (const p of (d.collections || []).slice(0, 3)) {
      const np = norm(p);
      if (pathToKey.has(np)) matched.push(np);
      else dropped.push(p);
    }
    return {
      paths: matched,
      keys: matched.map((p) => pathToKey.get(p)),
      confidence: Number(d.confidence) || 0,
      isPaper: !!d.is_paper_push,
      paperTitleGuess: (d.paper_title_guess || '').trim(),
      note: dropped.length ? 'dropped:' + dropped.join('|') : '',
    };
  } catch {
    return emptyCls('llm_parse_error');
  }
}

module.exports = { classify, historyExamples };

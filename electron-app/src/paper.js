// 论文元数据匹配：arXiv API 优先，其次 OpenAlex（DOI），最后 Crossref（标题）。
// 全部免费公开接口；任一失败返回 null（推送条目照常保存，只是少配对论文条目）。
const UNWANTED = /<[^>]+>/g;

// 全名 → Zotero 创建者：西方名拆双字段（末词为姓，van/von/de 等小品词并入姓）；
// citation meta 常见的「姓, 名」/「姓; 名」逗号分号格式按分号前为姓识别（此前按末词拆会正好拆反）；
// 无拉丁字母的姓名（中文等）保持单字段。
const NAME_PARTICLES = /^(van|von|de|der|den|di|da|du|del|la|le)$/i;
function toCreators(names) {
  return names.slice(0, 20).map((raw) => {
    const name = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!name) return null;
    if (!/[A-Za-z]/.test(name)) return { creatorType: 'author', name, fieldMode: 1 };
    const sep = name.match(/^([^,;]+)[,;]\s*(.+)$/);
    if (sep) {
      return { creatorType: 'author', lastName: sep[1].trim(), firstName: sep[2].trim() };
    }
    const parts = name.split(' ');
    if (parts.length === 1) return { creatorType: 'author', name, fieldMode: 1 };
    let i = parts.length - 1;
    while (i > 0 && NAME_PARTICLES.test(parts[i - 1])) i--;
    return {
      creatorType: 'author',
      firstName: parts.slice(0, i).join(' '),
      lastName: parts.slice(i).join(' '),
    };
  }).filter(Boolean);
}

// Crossref 的 author 自带 given/family 权威拆分，直接采用（此前被拼成整串丢失了姓/名信息）
function crossrefCreators(authorList) {
  return (authorList || []).slice(0, 20).map((a) => {
    if (a.family) return { creatorType: 'author', firstName: a.given || '', lastName: a.family };
    if (a.name) return { creatorType: 'author', name: a.name, fieldMode: 1 };
    return null;
  }).filter(Boolean);
}

function pagesFromParts(first, last) {
  const f = String(first || '').trim();
  const l = String(last || '').trim();
  if (f && l && f !== l) return f + '-' + l;
  return f || l || '';
}

function unesc(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
}

const ARXIV_ID_RE = /arxiv\.org\/(?:abs|pdf)\/([0-9]{4}\.[0-9]{4,5}(?:v\d+)?|[a-z\-]+(?:\.[A-Z]{2})?\/\d{7})/i;
const DOI_IN_URL_RE = /doi\.org\/(10\.\d{4,9}\/[^\s?#"'<>]+)/i;

function arxivIdFromUrl(url) {
  const m = (url || '').match(ARXIV_ID_RE);
  return m ? m[1].replace(/v\d+$/i, '') : null;
}

function doiFromUrl(url) {
  const m = (url || '').match(DOI_IN_URL_RE);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]).toLowerCase();
  } catch {
    return m[1].toLowerCase();
  }
}

// 出版商页面通常内嵌 Highwire citation meta（nature/wiley/springer/mdpi/plos 等通用）
async function pageCitationMeta(url) {
  const r = await _get(url);
  if (!r) return null;
  const h = await r.text();
  const meta = (name) => {
    const m = h.match(new RegExp('<meta[^>]+(?:name|property)="' + name + '"[^>]+content="([^"]*)"', 'i'))
           || h.match(new RegExp('<meta[^>]+content="([^"]*)"[^>]+(?:name|property)="' + name + '"', 'i'));
    return m ? unesc(m[1]) : '';
  };
  const authors = [...h.matchAll(/<meta[^>]+(?:name|property)="citation_author"[^>]+content="([^"]*)"/gi)]
    .map((m) => unesc(m[1])).slice(0, 20);
  // 关键词：citation_keywords 多标签 + dc.subject（Nature 系页面用它承载学科标签）
  const ckw = [...h.matchAll(/<meta[^>]+(?:name|property)="citation_keywords"[^>]+content="([^"]*)"/gi)]
    .map((m) => unesc(m[1])).flatMap((s) => s.split(/[,;，；]/));
  const dkw = [...h.matchAll(/<meta[^>]+name="dc\.subject"[^>]+content="([^"]*)"/gi)]
    .map((m) => unesc(m[1]));
  const seenKw = new Set();
  const keywords = [...ckw, ...dkw].map((s) => s.trim()).filter((s) => {
    if (!s || seenKw.has(s.toLowerCase())) return false;
    seenKw.add(s.toLowerCase());
    return true;
  }).slice(0, 8);
  return {
    doi: (meta('citation_doi') || meta('citation_DOI') || '').toLowerCase(),
    title: meta('citation_title') || unesc((h.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '').split('|')[0],
    authors,
    journal: meta('citation_journal_title'),
    date: meta('citation_publication_date') || meta('citation_date'),
    volume: meta('citation_volume'),
    issue: meta('citation_issue'),
    pages: pagesFromParts(meta('citation_firstpage'), meta('citation_lastpage')),
    issn: (meta('citation_issn') || '').split(',')[0].trim(),
    publisher: meta('citation_publisher'),
    language: meta('citation_language'),
    keywords,
    abstract: meta('citation_abstract') || meta('og:description') || meta('description'),
  };
}

// OpenAlex 的摘要倒排索引还原成文本（分类时用）
function abstractFromInverted(inv) {
  if (!inv) return '';
  try {
    const pos = [];
    for (const [word, idxs] of Object.entries(inv)) {
      for (const i of idxs) pos[i] = word;
    }
    return pos.filter(Boolean).join(' ');
  } catch {
    return '';
  }
}
async function _get(url, params) {
  const qs = params ? '?' + new URLSearchParams(params) : '';
  const r = await fetch(url + qs, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) return null;
  return r;
}

async function arxiv(id) {
  try {
    const r = await _get('http://export.arxiv.org/api/query', { id_list: id, max_results: '1' });
    if (!r) return null;
    const xml = await r.text();
    const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/);
    if (!entry) return null;
    const e = entry[1];
    const title = ((e.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '').replace(/\s+/g, ' ').trim();
    if (!title) return null;
    const creators = toCreators(
      [...e.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => m[1].trim())
    );
    const date = ((e.match(/<published>([\s\S]*?)<\/published>/) || [])[1] || '').slice(0, 10);
    const summary = ((e.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1] || '').replace(/\s+/g, ' ').trim();
    const cat = (e.match(/<arxiv:primary_category[^>]*term="([^"]+)"/) || [])[1] || '';
    // 作者若关联了正式发表版的 DOI，顺藤摸瓜补全期刊/卷/期/页与权威作者拆分
    const linkedDoi = unesc((e.match(/<arxiv:doi[^>]*>([\s\S]*?)<\/arxiv:doi>/i) || [])[1] || '').trim().toLowerCase();
    const preprint = {
      itemType: 'preprint', title, creators, date,
      url: `https://arxiv.org/abs/${id}`, arxivId: id, arxivCategory: cat, doi: linkedDoi, journal: '',
      volume: '', issue: '', pages: '',
      abstract: summary.slice(0, 2000),
    };
    if (linkedDoi) {
      const pub = await doiMeta(linkedDoi);
      if (pub && pub.title) {
        return { ...pub, arxivId: id, arxivCategory: cat, url: pub.url || preprint.url };
      }
    }
    return preprint;
  } catch {
    return null;
  }
}

async function openalexDoi(doi) {
  try {
    const r = await _get(`https://api.openalex.org/works/https://doi.org/${encodeURIComponent(doi)}`);
    if (!r) return null;
    const d = await r.json();
    const title = d.display_name || '';
    if (!title) return null;
    const creators = toCreators(
      (d.authorships || []).map((a) => (a.author || {}).display_name).filter(Boolean)
    );
    const srcObj = ((d.primary_location || {}).source) || {};
    const bib = d.biblio || {};
    const kws = (d.keywords || []).map((k) => (k || {}).display_name).filter(Boolean).slice(0, 8);
    const topics = (d.topics || []).map((t) => (t || {}).display_name).filter(Boolean).slice(0, 3);
    return {
      itemType: d.type === 'preprint' ? 'preprint' : 'journalArticle',
      title, creators, date: String(d.publication_year || ''),
      doi, url: `https://doi.org/${doi}`, journal: srcObj.display_name || '', arxivId: '', arxivCategory: '',
      volume: String(bib.volume || ''), issue: String(bib.issue || ''),
      pages: pagesFromParts(bib.first_page, bib.last_page),
      issn: (srcObj.issn || [])[0] || '',
      journalAbbrev: '',
      publisher: srcObj.publisher || '',
      language: d.language || '',
      keywords: kws.length ? kws : topics,
      abstract: abstractFromInverted(d.abstract_inverted_index).slice(0, 2000),
    };
  } catch {
    return null;
  }
}

async function crossrefTitle(title) {
  try {
    const r = await _get('https://api.crossref.org/works', {
      'query.bibliographic': title, rows: '1',
      select: 'DOI,title,author,issued,container-title,abstract,volume,issue,page,ISSN,short-container-title,publisher,language',
    });
    if (!r) return null;
    const it = (((await r.json()).message || {}).items || [])[0];
    if (!it) return null;
    const creators = crossrefCreators(it.author);
    const dp = ((it.issued || {})['date-parts'] || [[null]])[0] || [];
    const date = dp.filter(Boolean).join('-');
    const doi = it.DOI || '';
    return {
      itemType: 'journalArticle',
      title: (it.title || [''])[0],
      creators, date, doi,
      url: doi ? `https://doi.org/${doi}` : '',
      journal: (it['container-title'] || [''])[0] || '',
      arxivId: '', arxivCategory: '',
      volume: String(it.volume || ''), issue: String(it.issue || ''), pages: String(it.page || ''),
      issn: (it.ISSN || [])[0] || '',
      journalAbbrev: (it['short-container-title'] || [])[0] || '',
      publisher: it.publisher || '',
      language: it.language || '',
      keywords: (it.subject || []).filter(Boolean).slice(0, 3),
      abstract: unesc((it.abstract || '').replace(UNWANTED, ' ')).replace(/\s+/g, ' ').slice(0, 2000),
    };
  } catch {
    return null;
  }
}

async function crossrefDoi(doi) {
  try {
    const r = await _get(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
    if (!r) return null;
    const it = ((await r.json()).message) || {};
    const title = (it.title || [''])[0];
    if (!title) return null;
    const creators = crossrefCreators(it.author);
    const dp = ((it.issued || {})['date-parts'] || [[null]])[0] || [];
    return {
      itemType: 'journalArticle',
      title, creators,
      date: dp.filter(Boolean).join('-'),
      doi,
      url: `https://doi.org/${doi}`,
      journal: (it['container-title'] || [''])[0] || '',
      arxivId: '', arxivCategory: '',
      volume: String(it.volume || ''), issue: String(it.issue || ''), pages: String(it.page || ''),
      issn: (it.ISSN || [])[0] || '',
      journalAbbrev: (it['short-container-title'] || [])[0] || '',
      publisher: it.publisher || '',
      language: it.language || '',
      keywords: (it.subject || []).filter(Boolean).slice(0, 3),
      abstract: unesc((it.abstract || '').replace(UNWANTED, ' ')).replace(/\s+/g, ' ').slice(0, 2000),
    };
  } catch {
    return null;
  }
}

// DOI 统一入口：Crossref 优先（作者 given/family 与卷期页最全），OpenAlex 兜底；
// Crossref 摘要缺失时用 OpenAlex 的倒排摘要补齐。
async function doiMeta(doi) {
  const m = (await crossrefDoi(doi)) || (await openalexDoi(doi));
  if (m && !m.abstract) {
    const oa = await openalexDoi(doi);
    if (oa && oa.abstract) m.abstract = oa.abstract;
  }
  return m;
}

// 直接论文链接的入口：arXiv → DOI → 出版商页面 citation meta
async function lookupByUrl(url) {
  const aid = arxivIdFromUrl(url);
  if (aid) {
    const m = await arxiv(aid);
    if (m) return m;
  }
  const doi = doiFromUrl(url);
  if (doi) {
    const m = await doiMeta(doi);
    if (m) return m;
    return null;
  }
  const pm = await pageCitationMeta(url);
  if (pm && pm.title) {
    if (pm.doi) {
      const m = await doiMeta(pm.doi);
      if (m) {
        // 页面 meta 的关键词/摘要比 Crossref 更全，缺时补上
        if ((!m.keywords || !m.keywords.length) && (pm.keywords || []).length) m.keywords = pm.keywords;
        if (!m.abstract && pm.abstract) m.abstract = String(pm.abstract).slice(0, 2000);
        return m;
      }
    }
    if (pm.title.length > 15) {
      const cm = await crossrefTitle(pm.title);
      if (cm && cm.title) return cm;
    }
    // 兜底：直接用页面 citation 元数据建条目
    return {
      itemType: 'journalArticle',
      title: pm.title,
      creators: toCreators(pm.authors),
      date: pm.date || '',
      doi: pm.doi || '',
      url,
      journal: pm.journal || '',
      arxivId: '', arxivCategory: '',
      volume: pm.volume || '', issue: pm.issue || '', pages: pm.pages || '',
      issn: pm.issn || '', journalAbbrev: '', publisher: pm.publisher || '', language: pm.language || '',
      keywords: pm.keywords || [],
      abstract: (pm.abstract || '').slice(0, 2000),
    };
  }
  return null;
}

async function lookup(article, titleGuess) {
  for (const id of (article.arxivIds || []).slice(0, 1)) {
    const m = await arxiv(id);
    if (m) return m;
  }
  for (const d of (article.dois || []).slice(0, 1)) {
    const m = await doiMeta(d);
    if (m) return m;
  }
  if (titleGuess) {
    return crossrefTitle(titleGuess);
  }
  return null;
}

module.exports = { lookup, lookupByUrl };

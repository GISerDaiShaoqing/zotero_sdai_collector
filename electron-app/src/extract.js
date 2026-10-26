// 微信文章抓取解析：服务端渲染的 og 元信息 + js_content 正文 + 文中论文链接。
// 命中"当前环境异常"验证墙时抛 FetchError（本机低频抓取概率很低）。
const WECHAT_URL_RE = /https?:\/\/mp\.weixin\.qq\.com\/[^\s"'<>]+/g;

const PAPER_HOSTS = [
  'arxiv.org', 'doi.org', 'sciencedirect.com', 'nature.com', 'link.springer.com',
  'onlinelibrary.wiley.com', 'iopscience.iop.org', 'pubs.acs.org', 'tandfonline.com',
  'mdpi.com', 'plos.org', 'cell.com', 'science.org', 'biorxiv.org', 'medrxiv.org',
  'ssrn.com', 'journals.aps.org', 'ieeexplore.ieee.org',
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

class FetchError extends Error {}

function firstWechatUrl(text) {
  const m = (text || '').match(WECHAT_URL_RE);
  if (!m) return null;
  return m[0].replace(/[)\]}>'`,;:，。、]+$/, '') || null;
}

function m1(pat, s) {
  const m = s.match(pat);
  return m ? m[1].trim() : '';
}

function unesc(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

const ARXIV_URL_RE = /arxiv\.org\/(?:abs|pdf)\/([0-9]{4}\.[0-9]{4,5}(?:v\d+)?|[a-z\-]+(?:\.[A-Z]{2})?\/\d{7})/i;
const DOI_URL_RE = /doi\.org\/(10\.\d{4,9}\/[^\s?#"'<>]+)/i;

function isPaperUrl(url) {
  const u = url || '';
  if (/mp\.weixin\.qq\.com/i.test(u)) return false;
  return ARXIV_URL_RE.test(u) || DOI_URL_RE.test(u) || PAPER_HOSTS.some((k) => u.includes(k));
}

// 从任意文本里抽第一条论文链接（arXiv/DOI/期刊页面）
// Cell/Elsevier 等链接本身含括号（S2542-4351(24)00321-8）：允许括号，再截掉配对失衡的尾部
function tidyUrl(u) {
  let depth = 0;
  for (let i = 0; i < u.length; i++) {
    if (u[i] === '(') depth++;
    else if (u[i] === ')') {
      if (depth === 0) return u.slice(0, i);
      depth--;
    }
  }
  return u;
}

function firstPaperUrl(text) {
  const urls = (text || '').match(/https?:\/\/[^\s"'<>\[\]{}]+/g) || [];
  for (const raw of urls) {
    const clean = tidyUrl(raw).replace(/[.,;:，。、]+$/, '');
    if (isPaperUrl(clean)) return clean;
  }
  return null;
}

async function fetchArticle(url, bodyChars = 3000) {
  // 微信风控页是间歇性出现的：自动重试 3 次（间隔 1.5s / 3s）
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fetchOnce(url, bodyChars);
    } catch (e) {
      lastErr = e;
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, attempt === 1 ? 1500 : 3000));
      }
    }
  }
  throw lastErr;
}

async function fetchOnce(url, bodyChars) {
  let r;
  try {
    r = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    throw new FetchError(`网络错误：${e.cause ? e.cause.code || e.cause.message : e.message}`);
  }
  if (!r.ok) throw new FetchError(`HTTP ${r.status}`);
  const h = await r.text();
  if (h.includes('当前环境异常') || h.includes('完成验证后即可继续访问')) {
    throw new FetchError('触发微信验证墙（IP 被风控），稍后重试');
  }
  return parse(h, url, bodyChars);
}

function parse(h, url, bodyChars) {
  const a = { url, title: '', blogTitle: '', publishDate: '', abstract: '', body: '', paperLinks: [], arxivIds: [], dois: [] };
  a.title = unesc(
    m1(/property="og:title"\s+content="([^"]*)"/, h) ||
    m1(/<h1[^>]*id="activity-name"[^>]*>([\s\S]*?)<\/h1>/, h).replace(/<[^>]+>/g, '')
  ).trim();
  a.blogTitle = unesc(
    m1(/id="js_name"[^>]*>\s*(?:<i[^>]*>\s*<\/i>)?([^<]+?)\s*</, h) ||
    m1(/class="profile_nickname"[^>]*>([^<]+)</, h) ||
    m1(/var nickname\s*=\s*(?:htmlDecode\()?"([^"]+)"/, h)
  ).trim();
  const ct = m1(/var ct\s*=\s*"?(\d{10})"?/, h);
  if (ct) {
    a.publishDate = new Date(Number(ct) * 1000 + 8 * 3600e3).toISOString().slice(0, 10);
  } else {
    a.publishDate = m1(/id="publish_time"[^>]*>([^<]+)</, h).slice(0, 10);
  }
  a.abstract = unesc(m1(/property="og:description"\s+content="([^"]*)"/, h));

  const mc = h.match(/id="js_content"[^>]*>([\s\S]*)/);
  if (mc) {
    let seg = mc[1];
    const cut = seg.search(/id="js_tags"|id="js_pc_qr_code"|<script/);
    if (cut > 0) seg = seg.slice(0, cut);
    a.body = unesc(seg.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, bodyChars);
  }

  const seenLinks = new Set();
  for (const m of h.matchAll(/href="(https?:\/\/[^"]+)"/g)) {
    const u = m[1];
    if (PAPER_HOSTS.some((k) => u.includes(k)) && !seenLinks.has(u)) {
      seenLinks.add(u);
      a.paperLinks.push(u);
      if (a.paperLinks.length >= 10) break;
    }
  }
  const aidSeen = new Set();
  for (const m of h.matchAll(/arxiv\.org\/(?:abs|pdf)\/([0-9]{4}\.[0-9]{4,5}|[a-z\-]+(?:\.[A-Z]{2})?\/\d{7})/gi)) {
    if (!aidSeen.has(m[1])) {
      aidSeen.add(m[1]);
      a.arxivIds.push(m[1]);
    }
    if (a.arxivIds.length >= 3) break;
  }
  const doiSeen = new Set();
  for (const m of h.matchAll(/(?<![\w/.])(10\.\d{4,9}\/[A-Za-z0-9._()\-]+)/g)) {
    const d = m[1].replace(/[.()\-]+$/, '').toLowerCase();
    if (d && !doiSeen.has(d)) {
      doiSeen.add(d);
      a.dois.push(d);
    }
    if (a.dois.length >= 3) break;
  }
  if (!a.title) throw new FetchError('解析不到标题（可能不是有效文章页或被风控）');
  return a;
}

module.exports = { FetchError, fetchArticle, firstWechatUrl, firstPaperUrl, isPaperUrl, PAPER_HOSTS };

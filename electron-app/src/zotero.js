// Zotero 10 本地 API：读免鉴权；写需一次性授权 key（弹窗点"总是允许"）。
// key 有时效：写入遇 401 自动静默重授权再重试。写请求必须回显 Zotero-Server-ID。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

const BASE = 'http://localhost:23119/api';
const ROOT = 'http://localhost:23119';
const USER = '0';
const APP_NAME = 'zotero_sdai_collector';
const KEY_FILE = path.join(store.DATA_DIR, 'zotero_local_key.txt');

let serverId = null;
let key = null;
try {
  key = fs.readFileSync(KEY_FILE, 'utf8').trim() || null;
} catch {}

class ZError extends Error {
  constructor(msg, kind = 'write') {
    super(msg);
    this.kind = kind; // auth | unavailable | write
  }
}

function headers(extra = {}) {
  const h = { 'Zotero-API-Version': '3', ...extra };
  if (key) {
    h['Zotero-API-Key'] = key;
    h['Authorization'] = `Bearer ${key}`;
  }
  if (serverId) h['Zotero-Server-ID'] = serverId;
  return h;
}

async function prime() {
  if (serverId) return;
  try {
    const r = await fetch(BASE + '/');
    serverId = r.headers.get('zotero-server-id') || serverId;
  } catch {}
}

async function call(method, p, { params, body, headers: extra, timeout = 20000 } = {}) {
  await prime();
  const qs = params ? '?' + new URLSearchParams(params) : '';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(BASE + '/' + p.replace(/^\//, '') + qs, {
      method,
      headers: headers(extra),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    serverId = r.headers.get('zotero-server-id') || serverId;
    return r;
  } catch (e) {
    const detail = e.cause ? e.cause.code || e.cause.message : e.message;
    // 超时中止 ≠ 没开：Zotero 正在同步/有弹窗时本地 API 会收下请求但迟迟不答（写请求还照常生效），
    // 文案必须区分，否则误报"未运行"
    const isAbort = e.name === 'AbortError' || /aborted/i.test(detail);
    throw new ZError(
      isAbort
        ? `Zotero 没响应（${timeout / 1000}s 超时，可能正在同步或弹窗中）：${detail}`
        : `连不上 Zotero（是否在运行？）：${detail}`,
      'unavailable'
    );
  } finally {
    clearTimeout(t);
  }
}

async function authorize(timeoutMs = 180000) {
  await prime();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(BASE + '/local/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Zotero-API-Version': '3',
                 ...(serverId ? { 'Zotero-Server-ID': serverId } : {}) },
      body: JSON.stringify({ appName: APP_NAME }),
      signal: ctrl.signal,
    });
    if (r.status === 403) {
      throw new ZError('Zotero 返回 403：请在 设置→高级 勾选“允许其他应用程序与本机 Zotero 通信”', 'auth');
    }
    if (!r.ok) throw new ZError(`授权失败 HTTP ${r.status}`, 'auth');
    const data = await r.json().catch(() => ({}));
    const k = Object.values(data).find((v) => typeof v === 'string' && /^[A-Za-z0-9]{16,64}$/.test(v));
    if (!k) throw new ZError('授权返回中找不到 key', 'auth');
    key = k;
    fs.writeFileSync(KEY_FILE, k, 'utf8');
    return k;
  } catch (e) {
    if (e.name === 'AbortError') throw new ZError('授权超时：未在 Zotero 弹窗里点击确认', 'auth');
    throw e;
  } finally {
    clearTimeout(t);
  }
}

async function getCollections() {
  const items = [];
  let start = 0;
  for (;;) {
    const r = await call('GET', `users/${USER}/collections`, {
      params: { format: 'json', limit: '100', start: String(start) },
    });
    if (!r.ok) throw new ZError(`读取集合失败 HTTP ${r.status}`);
    const batch = await r.json();
    items.push(...batch);
    if (batch.length < 100) break;
    start += 100;
  }
  const byKey = Object.fromEntries(items.map((c) => [c.key, c]));
  return items.map((c) => {
    const parts = [];
    let cur = c;
    const seen = new Set();
    while (cur && !seen.has(cur.key)) {
      seen.add(cur.key);
      parts.push(cur.data.name);
      const p = cur.data.parentCollection;
      cur = p ? byKey[p] : null;
    }
    return { key: c.key, name: c.data.name, path: parts.reverse().join('/') };
  });
}

// 按 URL 查重：拉最近 blogPost 比对（?q= 全文搜索在本地 API 上会超时，不能用）。
async function recentUrlExists(url) {
  // 不限条目类型：微信文章（blogPost）和论文（journalArticle/preprint）都可能被 URL 补写命中
  const r = await call('GET', `users/${USER}/items/top`, {
    params: { format: 'json', limit: '100', sort: 'dateAdded', direction: 'desc' },
  });
  if (!r.ok) throw new ZError(`查重失败 HTTP ${r.status}`);
  const target = url.split('#')[0].trim().toLowerCase();
  for (const it of await r.json()) {
    if (String(it.data?.url || '').split('#')[0].trim().toLowerCase() === target) return it;
  }
  return null;
}

async function createItems(items) {
  if (!key) {
    await authorize();
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await call('POST', `users/${USER}/items`, {
      body: items,
      headers: {
        'Zotero-Write-Token': crypto.randomBytes(16).toString('hex'),
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });
    if (r.status === 401 && attempt === 1) {
      try {
        await authorize(60000);
        continue;
      } catch {}
    }
    if (!r.ok) throw new ZError(`写入失败 HTTP ${r.status}：${(await r.text()).slice(0, 200)}`);
    const data = await r.json();
    if (data.failed && Object.keys(data.failed).length) {
      throw new ZError('部分条目写入失败：' + JSON.stringify(data.failed).slice(0, 200));
    }
    return Object.values(data.success || {});
  }
  throw new ZError('写入失败：重授权后仍 401', 'auth');
}

// Zotero 主窗口当前选中的集合（connector 协议；顶层 id 为数字或 C 前缀，停在库根目录/搜索时为空 → null）
async function getSelectedCollection() {
  try {
    const r = await fetch(ROOT + '/connector/getSelectedCollection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Zotero-Connector-API-Version': '3' },
      body: '{}',
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    const d = await r.json().catch(() => null);
    if (!d || !d.id) return null;
    const id = String(d.id);
    if (!/^(?:C)?\d+$/.test(id)) return null;
    return { id, name: d.name || '' };
  } catch {
    return null;
  }
}

// 浏览器插件同款保存通道：条目落入 Zotero 主窗口当前选中的集合（免 key、免集合 key 映射）
async function connectorSave(items) {
  const r = await fetch(ROOT + '/connector/saveItems', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Zotero-Connector-API-Version': '3' },
    body: JSON.stringify({ items }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok && r.status !== 204) {
    throw new ZError(`connector 直存失败 HTTP ${r.status}`, 'write');
  }
}

module.exports = { ZError, authorize, call, connectorSave, getCollections, getSelectedCollection, recentUrlExists, createItems, hasKey: () => !!key };

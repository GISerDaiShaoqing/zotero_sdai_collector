// Zotero 10 本地 API：读免鉴权；写需一次性授权 key（弹窗点"总是允许"）。
// key 有时效：写入遇 401 自动静默重授权再重试。写请求必须回显 Zotero-Server-ID。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

const BASE = 'http://localhost:23119/api';
const USER = '0';
const APP_NAME = 'Zotero收集机器人';
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
    throw new ZError(`连不上 Zotero（是否在运行？）：${e.cause ? e.cause.code || e.cause.message : e.message}`, 'unavailable');
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
  const r = await call('GET', `users/${USER}/items/top`, {
    params: { format: 'json', limit: '50', itemType: 'blogPost', sort: 'dateAdded', direction: 'desc' },
  });
  if (!r.ok) throw new ZError(`查重失败 HTTP ${r.status}`);
  const target = url.split('#')[0].trim();
  for (const it of await r.json()) {
    if ((it.data?.url || '').split('#')[0].trim() === target) return it;
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

module.exports = { ZError, authorize, getCollections, recentUrlExists, createItems, hasKey: () => !!key };

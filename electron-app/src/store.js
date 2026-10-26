// JSON 存储：处理记录 + 配置。数据量小；写盘走临时文件+改名保证原子性。
const fs = require('fs');
const path = require('path');

// 数据目录：开发/脚本环境用项目内 data/；打包成 exe 后 asar 只读，改用 %APPDATA% 下的用户数据目录。
let DATA_DIR = path.join(__dirname, '..', 'data');
try {
  const { app } = require('electron');
  if (app && typeof app.getPath === 'function' && app.isPackaged) {
    DATA_DIR = path.join(app.getPath('userData'), 'data');
  }
} catch { /* 非 Electron 环境（node 跑一次性脚本）走默认 */ }
const STORE_PATH = path.join(DATA_DIR, 'store.json');

const DEFAULT_CONFIG = {
  llmBaseUrl: 'https://api.deepseek.com',
  llmKey: '',
  llmModel: 'deepseek-flash',
  threshold: 0.7,
  bodyChars: 3000,
  autoWrite: false,   // 高置信度自动写入；默认关 = 每条弹确认卡片
  feishuAppId: '',
  feishuAppSecret: '',
  hudBg: '',          // 卡片窗（HUD）背景图绝对路径，空 = 纯色
};

let state = { events: [], seq: 0 };
let cfg = { ...DEFAULT_CONFIG };

function init() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // 打包版首次启动：用随包携带的 seed 配置（飞书凭据/LLM 地址等），省去重新填写
  if (!fs.existsSync(STORE_PATH)) {
    const seed = path.join(__dirname, '..', 'seed', 'store.json');
    if (fs.existsSync(seed)) {
      try { fs.copyFileSync(seed, STORE_PATH); } catch {}
    }
  }
  try {
    const d = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    state.events = Array.isArray(d.events) ? d.events : [];
    state.seq = d.seq || 0;
    if (d.config) cfg = { ...DEFAULT_CONFIG, ...d.config };
  } catch {
    /* 首次运行 */
  }
}

function save() {
  const tmp = STORE_PATH + '.tmp';
  fs.writeFileSync(
    tmp,
    JSON.stringify({ events: state.events.slice(-200), seq: state.seq, config: cfg }, null, 1),
    'utf8'
  );
  try {
    fs.renameSync(tmp, STORE_PATH);
  } catch {
    fs.copyFileSync(tmp, STORE_PATH);
    fs.unlinkSync(tmp);
  }
}

function addEvent(ev) {
  const id = ++state.seq;
  const row = { id, status: 'new', createdAt: Date.now(), ...ev };
  state.events.push(row);
  save();
  return row;
}

function updateEvent(id, patch) {
  const row = state.events.find((e) => e.id === id);
  if (row) {
    Object.assign(row, patch, { updatedAt: Date.now() });
    save();
  }
  return row;
}

function findSaved(url) {
  return state.events.find((e) => e.status === 'saved' && e.url === url) || null;
}

function byStatus(st) {
  return state.events.filter((e) => e.status === st);
}

function recent(n = 60) {
  return state.events.slice(-n).reverse();
}

function clearEvents() {
  state.events = [];
  save();
}

function getConfig() {
  return { ...cfg };
}

function setConfig(patch) {
  cfg = { ...cfg, ...patch };
  save();
  return getConfig();
}

module.exports = { init, addEvent, updateEvent, findSaved, byStatus, recent, clearEvents, getConfig, setConfig, DATA_DIR };

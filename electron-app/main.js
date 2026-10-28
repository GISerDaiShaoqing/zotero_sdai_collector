// 应用生命周期：托盘常驻、主面板窗口、右下角卡片窗（HUD）、IPC 桥接、剪贴板轮询。
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, clipboard, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const store = require('./src/store');
const engine = require('./src/engine');
const zotero = require('./src/zotero');
const extract = require('./src/extract');

let panel = null;
let hud = null;
let tray = null;
let paused = false;
let quitting = false;
let pollTimer = null;
let lastClip = '';

const ICON = path.join(__dirname, 'assets', 'icon.png');

function mainLog(msg) {
  try {
    fs.appendFileSync(path.join(store.DATA_DIR, 'app.log'),
      `${new Date().toISOString().slice(0, 19).replace('T', ' ')} [main] ${msg}\n`, 'utf8');
  } catch {}
}

if (!app.requestSingleInstanceLock()) {
  mainLog('未取得单实例锁，退出（已有实例在运行）');
  app.quit();
} else {
  app.on('second-instance', () => showPanel());

  app.whenReady().then(async () => {
    store.init();
    await engine.init();
    createPanel();
    createHud();
    createTray();
    startClipboardPolling();
    engine.syncFeishu();
    engine.on('update', () => panel && !panel.isDestroyed() && panel.webContents.send('state', snapshot()));
    engine.on('hud', (p) => {
      if (hud && !hud.isDestroyed()) {
        resetHudSize();
        hud.webContents.send('hud', p);
        hud.showInactive();
      }
    });
  });
}

function snapshot() {
  return { status: engine.status(), events: store.recent(60), authorized: zotero.hasKey(), config: store.getConfig(), version: app.getVersion() };
}

function showPanel() {
  if (panel && !panel.isDestroyed()) {
    panel.show();
    panel.focus();
  }
}

function createPanel() {
  panel = new BrowserWindow({
    width: 740, height: 540, minWidth: 600, minHeight: 440,
    title: 'zotero_sdai_collector',
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  panel.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  panel.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      panel.hide();
    }
  });
}

const HUD_W = 340;
const HUD_MARGIN = 16;

function hudBounds(h) {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - HUD_W - HUD_MARGIN, y: wa.y + wa.height - h - HUD_MARGIN, width: HUD_W, height: h };
}

function createHud() {
  hud = new BrowserWindow({
    width: HUD_W, height: 96,
    ...hudBounds(96),
    frame: false, alwaysOnTop: true, skipTaskbar: true, resizable: false,
    show: false, icon: ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  hud.setAlwaysOnTop(true, 'screen-saver');
  hud.webContents.on('did-finish-load', sendHudBg);
  hud.loadFile(path.join(__dirname, 'hud.html'));
}

// 弹卡前先把窗口归位到最小尺寸，内容渲染后再自适应，避免沿用上次的大窗口
function resetHudSize() {
  if (hud && !hud.isDestroyed()) hud.setBounds(hudBounds(96));
}

const IMG_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' };

function sendHudBg() {
  if (!hud || hud.isDestroyed()) return;
  let dataUrl = '';
  const p = store.getConfig().hudBg;
  if (p) {
    try {
      const ext = path.extname(p).toLowerCase();
      if (IMG_EXT[ext] && fs.statSync(p).size < 12 * 1024 * 1024) {
        dataUrl = `data:${IMG_EXT[ext]};base64,` + fs.readFileSync(p).toString('base64');
      }
    } catch {}
  }
  hud.webContents.send('hud-bg', dataUrl);
}

function createTray() {
  const icon = nativeImage.createFromPath(ICON).resize({ width: 32, height: 32 });
  tray = new Tray(icon);
  tray.setToolTip('zotero_sdai_collector — 复制微信文章链接即可收集');
  const menu = Menu.buildFromTemplate([
    { label: '显示面板', click: showPanel },
    { label: '暂停监听', id: 'pause', click: togglePause },
    { label: '重弹待确认', click: () => engine.reconfirmPending() },
    { label: '关于', click: openAbout },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', showPanel);
}

function openAbout() {
  showPanel();
  if (panel && !panel.isDestroyed()) panel.webContents.send('about');
}

function togglePause() {
  paused = !paused;
  engine.paused = paused;
  if (tray) {
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: paused ? '恢复监听' : '暂停监听', click: togglePause },
      { label: '显示面板', click: showPanel },
      { label: '重弹待确认', click: () => engine.reconfirmPending() },
      { label: '关于', click: openAbout },
      { type: 'separator' },
      { label: '退出', click: () => { quitting = true; app.quit(); } },
    ]));
  }
  broadcast();
}

function broadcast() {
  if (panel && !panel.isDestroyed()) panel.webContents.send('state', snapshot());
}

// ---- 剪贴板轮询（1 秒；Electron 45 起 readText 为异步 API）----
function startClipboardPolling() {
  pollTimer = setInterval(() => {
    if (paused) return;
    Promise.resolve(clipboard.readText())
      .then((text) => {
        if (!text || text === lastClip) return;
        lastClip = text;
        const url = extract.firstWechatUrl(text) || extract.firstPaperUrl(text);
        if (url) {
          engine.log(`捕获链接：${url}`);
          engine.enqueueUrl(url);
        }
      })
      .catch((e) => engine.log(`剪贴板读取异常：${e.message}`));
  }, 1000);
}

// ---- IPC ----
ipcMain.handle('get-init', () => snapshot());
ipcMain.handle('get-config', () => store.getConfig());
ipcMain.handle('set-paused', (e, p) => {
  if (paused !== p) togglePause();
});
ipcMain.handle('refresh-collections', async () => {
  const n = await engine.loadTree();
  return { n, authorized: zotero.hasKey() };
});
ipcMain.handle('reconfirm', () => engine.reconfirmPending());
ipcMain.handle('clear-history', () => {
  store.clearEvents();
  broadcast();
});
ipcMain.handle('save-config', (e, c) => {
  const prevBg = store.getConfig().hudBg;
  const cfg = store.setConfig(c || {});
  if ((cfg.hudBg || '') !== (prevBg || '')) sendHudBg();
  syncFeishuAfterConfig();
  return cfg;
});

function syncFeishuAfterConfig() {
  try {
    engine.syncFeishu();
    if (panel && !panel.isDestroyed()) panel.webContents.send('state', snapshot());
  } catch {}
}
ipcMain.handle('authorize', async () => {
  try {
    await zotero.authorize();
    broadcast();
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message };
  }
});
ipcMain.handle('choose', (e, { id, action, paths }) => {
  if (action === 'confirm') engine.confirmChoose(id, paths || []);
  else engine.ignore(id);
});
ipcMain.handle('hud-hide', () => {
  if (hud && !hud.isDestroyed()) hud.hide();
});
// 渲染进程报内容高度 → 夹取后按右下角重新贴靠
ipcMain.on('hud-resize', (e, h) => {
  if (!hud || hud.isDestroyed()) return;
  const height = Math.max(80, Math.min(520, Math.round(Number(h) || 96)));
  hud.setBounds(hudBounds(height));
});
ipcMain.handle('pick-bg', async () => {
  const r = await dialog.showOpenDialog(panel, {
    title: '选择卡片窗背景图',
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths.length) return { ok: false };
  const cfg = store.setConfig({ hudBg: r.filePaths[0] });
  sendHudBg();
  return { ok: true, path: cfg.hudBg };
});
ipcMain.handle('clear-bg', () => {
  const cfg = store.setConfig({ hudBg: '' });
  sendHudBg();
  return cfg;
});
ipcMain.handle('quit', () => {
  quitting = true;
  app.quit();
});
ipcMain.handle('open-url', (e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
});
// 检查更新：查 GitHub Releases 最新版本；仓库未发布/网络不通时温和降级
function isNewer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}
ipcMain.handle('check-update', async () => {
  try {
    const r = await fetch('https://api.github.com/repos/GISerDaiShaoqing/zotero_sdai_collector/releases/latest', {
      headers: { 'User-Agent': 'zotero-collector', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(8000),
    });
    if (r.status === 404) return { ok: false, reason: '仓库尚未发布 Release' };
    if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
    const d = await r.json();
    const latest = String(d.tag_name || '').replace(/^v/i, '');
    const current = app.getVersion();
    return { ok: true, latest, current, upToDate: !isNewer(latest, current) };
  } catch (e) {
    return { ok: false, reason: e.name === 'TimeoutError' ? '网络超时' : '访问 GitHub 失败' };
  }
});

app.on('window-all-closed', () => {
  // 不退出：托盘常驻
});
app.on('before-quit', () => {
  mainLog('应用退出（before-quit 触发）');
  quitting = true;
  if (pollTimer) clearInterval(pollTimer);
  engine.dispose();
});

// 应用生命周期：托盘常驻、主面板窗口、右下角卡片窗（HUD）、IPC 桥接、剪贴板轮询。
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, clipboard, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const store = require('./src/store');
const engine = require('./src/engine');
const zotero = require('./src/zotero');
const extract = require('./src/extract');
const feishu = require('./src/feishu');

let panel = null;
let hud = null;
let ball = null;
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

// 开发态与打包版 productName 同名，会共用 %APPDATA%\zotero_sdai_collector——而 GPU 磁盘缓存、
// 单实例锁都按 userData 划界：两者同时跑会互相锁缓存文件（启动报 "Unable to create cache"）、
// 单实例锁互踢（正式版被弹退"未取得单实例锁"）。开发态改用独立 userData 目录，从此互不干扰
if (!app.isPackaged) {
  try { app.setPath('userData', path.join(app.getPath('appData'), 'zotero_sdai_collector-dev')); } catch {}
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
    createBall();
    createTray();
    startClipboardPolling();
    engine.syncFeishu();
    engine.on('update', () => {
      const snap = snapshot();
      if (panel && !panel.isDestroyed()) panel.webContents.send('state', snap);
      sendBallState(snap);
    });
    engine.on('hud', (p) => {
      if (hud && !hud.isDestroyed()) {
        resetHudSize();
        hud.webContents.send('hud', p);
        hud.showInactive();
      } else {
        // 平时不会发生（卡片窗只藏不关会发生）；发生了说明窗口被销毁、卡片会丢，先记日志
        mainLog('有一张卡片未能送达：卡片窗不可用（恢复后由重弹待确认兜底）');
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
  syncBallWithPanel();
}

// 球与面板互斥：面板在屏（含最小化到任务栏）时收球，面板收起（缩托盘）时亮球。
// 收纳态即球态——红角标正好在"你不在面板前"的时候告诉你有卡片待确认
function syncBallWithPanel() {
  if (!ball || ball.isDestroyed()) return;
  const onScreen = !!(panel && !panel.isDestroyed() && panel.isVisible() && !panel.isMinimized());
  if (onScreen) {
    if (ball.isVisible()) ball.hide();
  } else if (!ball.isVisible()) {
    ball.showInactive();
  }
}

function createPanel() {
  panel = new BrowserWindow({
    width: 740, height: 540, minWidth: 600, minHeight: 440,
    title: 'zotero_sdai_collector',
    icon: ICON,
    autoHideMenuBar: true,
    // 悬浮置顶（面板 📌 开关记忆）：级别用 floating，低于卡片窗的 screen-saver——卡片始终压在面板上
    alwaysOnTop: !!store.getConfig().panelFloat,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  panel.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // 面板渲染进程异常退出会白屏：记日志并自动重载（重载后 index.html 会拉全量快照，无需其他处理）
  panel.webContents.on('render-process-gone', (_e, d) => {
    mainLog(`面板渲染进程异常退出（reason=${d.reason} exitCode=${d.exitCode}）`);
    if (d.reason !== 'clean-exit') {
      try { panel.webContents.reload(); } catch {}
    }
  });
  panel.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      panel.hide();
    }
  });
  // 球随面板收放：面板 show/hide/minimize/restore 都同步球的显隐（互斥态）
  for (const ev of ['show', 'hide', 'minimize', 'restore']) panel.on(ev, syncBallWithPanel);
}

const HUD_W = 340;
const HUD_MARGIN = 16;

function hudBounds(h) {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - HUD_W - HUD_MARGIN, y: wa.y + wa.height - h - HUD_MARGIN, width: HUD_W, height: h };
}

// 卡片窗可拖动（hud.css 的 -webkit-app-region）：默认贴右下角，用户拖走后，
// 本次运行内新卡都停在拖到的位置（不再飞回右下角），重启应用归位。
// 区分"用户拖动"与"程序归位"：程序归位后位置必等于锚点，'moved' 时不等即用户拖的
let hudAnchor = null;
let hudMoved = false;

// 内容高度变化统一走这里：未拖动贴右下角；拖过后保持左上角只随内容伸缩，
// 并夹回工作区（防拖到屏幕边缘后新卡把窗口伸进看不见的地方）
function placeHud(h) {
  if (!hud || hud.isDestroyed()) return;
  const height = Math.max(80, Math.min(520, Math.round(Number(h) || 96)));
  let b;
  if (hudMoved) {
    const [x, y] = hud.getPosition();
    const wa = screen.getDisplayMatching({ x, y, width: HUD_W, height }).workArea;
    b = {
      x: Math.min(Math.max(x, wa.x), Math.max(wa.x, wa.x + wa.width - HUD_W)),
      y: Math.min(Math.max(y, wa.y), Math.max(wa.y, wa.y + wa.height - height)),
      width: HUD_W, height,
    };
  } else {
    b = hudBounds(height);
  }
  hudAnchor = { x: b.x, y: b.y };
  hud.setBounds(b);
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
  // 记下初始锚点 + 监听用户拖动（拖动由 CSS app-region 完成，这里只负责记住"拖过了"）
  hudAnchor = (() => { const b = hud.getBounds(); return { x: b.x, y: b.y }; })();
  hud.on('moved', () => {
    if (!hudAnchor) return;
    const [x, y] = hud.getPosition();
    if (x !== hudAnchor.x || y !== hudAnchor.y) hudMoved = true;
  });
  // 启动或恢复后：把仍在等待确认的卡片自动重新弹出（状态已落盘；不重弹用户无从知晓）
  hud.webContents.on('did-finish-load', () => {
    sendHudBg();
    try { engine.reconfirmPending(); } catch {}
  });
  // 看护：渲染进程被杀/挂起时，此前会把后续卡片全部塞进透明空壳——用户一张卡都收不到
  // （一次排队二十多条全积压的根源）。现在记日志并自动重载；恢复完成时 did-finish-load
  // 会自动重弹待确认。clean-exit 是窗口正常关闭（本项目只在退出时发生），不做处理
  hud.webContents.on('render-process-gone', (_e, d) => {
    mainLog(`卡片窗渲染进程异常退出（reason=${d.reason} exitCode=${d.exitCode}）`);
    if (d.reason !== 'clean-exit') {
      try { hud.webContents.reload(); } catch {}
    }
  });
  hud.webContents.on('unresponsive', () => mainLog('卡片窗渲染进程无响应（挂起），尝试重载恢复'));
  hud.webContents.on('responsive', () => mainLog('卡片窗已恢复响应'));
  hud.loadFile(path.join(__dirname, 'hud.html'));
}

// 弹卡前先把窗口归位到最小尺寸，内容渲染后再自适应，避免沿用上次的大窗口
function resetHudSize() {
  placeHud(96);
}

// ---- 悬浮小球 ----
const BALL_W = 56;

// 初始/恢复位置：用记忆点，夹取到工作区内（换分辨率/拔显示器时防丢）
function ballBounds() {
  const wa = screen.getPrimaryDisplay().workArea;
  const p = store.getConfig().ballPos;
  const x = p && Number.isFinite(p.x) ? p.x : wa.x + wa.width - 72;
  const y = p && Number.isFinite(p.y) ? p.y : wa.y + Math.round(wa.height / 2) - 28;
  return {
    x: Math.round(Math.min(Math.max(wa.x, x), wa.x + wa.width - BALL_W)),
    y: Math.round(Math.min(Math.max(wa.y, y), wa.y + wa.height - BALL_W)),
    width: BALL_W, height: BALL_W,
  };
}

function createBall() {
  ball = new BrowserWindow({
    ...ballBounds(),
    frame: false, transparent: true, hasShadow: false, resizable: false, skipTaskbar: true,
    // backgroundColor 透明：不写这个，Windows 上"创建时隐藏+事后 showInactive"的透明窗会
    // 出现"窗口在但内容永远不画"的坑（实测小球隐形的根源）
    backgroundColor: '#00000000',
    alwaysOnTop: true, show: false, icon: ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  // floating 级：高于普通窗口，低于卡片窗的 screen-saver——确认卡永远压在小球上
  ball.setAlwaysOnTop(true, 'floating');
  ball.webContents.on('did-finish-load', () => {
    sendBallState();
    sendBallIcon();
    // 面板开着就不亮球（互斥态；渲染异常恢复重载时同理）
    syncBallWithPanel();
    try {
      const b = ball.getBounds();
      mainLog(`悬浮小球就绪：(${b.x},${b.y}) ${b.width}×${b.height}`);
    } catch {}
  });
  // 看护同卡片窗（V1.2.7 教训）：小球渲染进程死了就是透明空壳，用户只会觉得"小球消失了"
  ball.webContents.on('render-process-gone', (_e, d) => {
    mainLog(`悬浮小球渲染进程异常退出（reason=${d.reason} exitCode=${d.exitCode}）`);
    if (d.reason !== 'clean-exit') {
      try { ball.webContents.reload(); } catch {}
    }
  });
  ball.loadFile(path.join(__dirname, 'ball.html'));
  // 拖动结束记位（moved 连发，去抖落盘）
  let moveTimer = null;
  ball.on('moved', () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      try {
        const b = ball.getBounds();
        store.setConfig({ ballPos: { x: b.x, y: b.y } });
      } catch {}
    }, 600);
  });
}

// 小球角标状态：待确认数>0 红标描边
function sendBallState(snap) {
  if (!ball || ball.isDestroyed()) return;
  try {
    const s = (snap || snapshot()).status;
    ball.webContents.send('ball-state', { nPending: s.nPending, listening: s.listening });
  } catch {}
}

// 球面 = 应用图标本体（主进程读 icon.png 转 dataURL 注入，同 HUD 背景图的机制；
// 圆形裁掉方角后呈现「汇流 Z」，sd 签名留在软件图标本体里）
function sendBallIcon() {
  if (!ball || ball.isDestroyed()) return;
  try {
    const buf = fs.readFileSync(path.join(__dirname, 'assets', 'icon.png'));
    ball.webContents.send('ball-icon', `data:image/png;base64,${buf.toString('base64')}`);
  } catch {}
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

// 手动重启：pending 状态全部落盘、确认卡启动时自动重弹（V1.2.7），重启零损失。
// Windows 下不能用 app.relaunch：其 relauncher 助手只能拉起 Electron 自身，而便携版真正的
// 入口是 NSIS 包装器（普通 exe），指向它会静默失败（现象即"点重启后应用消失"）；且包装器
// 退出时会删除 %TEMP% 解包目录（portable.nsi 的 RMDir /r），默认 relaunch 目标（内层 exe）
// 正在其中。改为分离式直接 spawn 新实例：包装器重新解包到各自独立的随机目录，互不干扰，
// 且新实例要等解包完成才启动，此时旧进程早已退出、单实例锁已释放；主进程稍后自行退出。
// 非 Windows 平台 relauncher 无此限制，仍走 relaunch。
function restartApp() {
  mainLog('手动重启应用');
  quitting = true;
  try { engine.dispose(); } catch {}
  if (pollTimer) clearInterval(pollTimer);
  if (process.platform === 'win32') {
    const portableExe = process.env.PORTABLE_EXECUTABLE_FILE;
    const exe = (portableExe && fs.existsSync(portableExe)) ? portableExe : process.execPath;
    const args = (exe === process.execPath && !app.isPackaged) ? [app.getAppPath()] : [];
    mainLog(`重启目标：${exe}${args.length ? ' ' + args.join(' ') : ''}`);
    try {
      spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true });
    } catch (e) {
      mainLog('重启拉起新实例失败：' + (e && e.message));
    }
    setTimeout(() => app.exit(0), 400);
  } else {
    app.relaunch();
    app.exit(0);
  }
}

// 托盘菜单统一在此生成（暂停/恢复的文案随 paused 变化，togglePause 重建时复用）
function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: paused ? '恢复监听' : '暂停监听', click: togglePause },
    { label: '显示面板', click: showPanel },
    { label: '重弹待确认', click: () => engine.reconfirmPending() },
    { label: '重启应用', click: restartApp },
    { label: '关于', click: openAbout },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]);
}

function createTray() {
  const icon = nativeImage.createFromPath(ICON).resize({ width: 32, height: 32 });
  tray = new Tray(icon);
  tray.setToolTip('zotero_sdai_collector — 复制微信文章链接即可收集');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', showPanel);
}

function openAbout() {
  showPanel();
  if (panel && !panel.isDestroyed()) panel.webContents.send('about');
}

function togglePause() {
  paused = !paused;
  engine.paused = paused;
  if (tray) tray.setContextMenu(buildTrayMenu());
  broadcast();
}

function broadcast() {
  const snap = snapshot();
  if (panel && !panel.isDestroyed()) panel.webContents.send('state', snap);
  sendBallState(snap);
}

// ---- 剪贴板轮询（1 秒；Electron 45 起 readText 为异步 API）----
function startClipboardPolling() {
  pollTimer = setInterval(() => {
    if (paused) return;
    Promise.resolve(clipboard.readText())
      .then((text) => {
        if (!text || text === lastClip) return;
        lastClip = text;
        // 微信链接 + 论文链接一起粘：论文链接随 enqueueUrl 传入配对，不再只取第一条；
        // 小红书链接（V1.3）不入库，单独捕获（面板/卡片一键浏览器打开）
        const wechat = extract.firstWechatUrl(text);
        const xhs = extract.firstXhsUrl(text);
        const papers = extract.paperUrls(text).filter((u) => u !== wechat && u !== xhs);
        // 指定分类在剪贴板入口同样生效（此前只有飞书入口解析提示词，桌面复制"链接 进 xxx"
        // 会被静默丢进常规流程）；主链接 = 文章或第一条论文链接，其余附带论文不带指定，与飞书一致
        const mainUrl = wechat || papers[0] || '';
        const hints = mainUrl ? feishu.parseHintPaths(JSON.stringify({ text }), mainUrl) : [];
        const hintTag = hints.length ? `（指定：${hints.join('、')}）` : '';
        if (wechat) {
          engine.log(`捕获链接：${wechat}${papers.length ? ` + 论文链接 ${papers.length} 条` : ''}${xhs ? ' + 小红书链接' : ''}${hintTag}`);
          engine.enqueueUrl(wechat, hints, papers);
          if (xhs) engine.enqueueUrl(xhs);
        } else if (xhs) {
          engine.log(`捕获小红书链接：${xhs}${papers.length ? ` + 论文链接 ${papers.length} 条` : ''}`);
          engine.enqueueUrl(xhs);
          for (const pu of papers) engine.enqueueUrl(pu);
        } else {
          papers.forEach((pu, i) => {
            engine.log(`捕获论文链接：${pu}${i === 0 ? hintTag : ''}`);
            engine.enqueueUrl(pu, i === 0 ? hints : []);
          });
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
ipcMain.handle('resend-event', (_e, id) => engine.resendEvent(id));
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
ipcMain.handle('ball-click', () => {
  // 点击球 = 展开主面板（球随面板显隐自动退场，不再需要手动切换）
  showPanel();
});
// 右键小球：托盘同款快捷菜单（每次弹出时现建，暂停/恢复文案随当前状态变）
ipcMain.handle('ball-menu', () => {
  Menu.buildFromTemplate([
    { label: '显示主面板', click: showPanel },
    { label: '重弹待确认', click: () => engine.reconfirmPending() },
    { label: paused ? '恢复监听' : '暂停监听', click: togglePause },
    { label: '重启应用', click: restartApp },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]).popup({ window: ball });
});
// 渲染进程报内容高度 → 统一贴靠（未拖动贴右下角；拖过则原地随内容伸缩）
ipcMain.on('hud-resize', (e, h) => {
  placeHud(h);
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
ipcMain.handle('restart', restartApp);
ipcMain.handle('set-float', (e, v) => {
  const cfg = store.setConfig({ panelFloat: !!v });
  if (panel && !panel.isDestroyed()) panel.setAlwaysOnTop(!!cfg.panelFloat, 'floating');
  return cfg;
});
ipcMain.handle('open-url', (e, url) => {
  // 只放行 http(s) 与 zotero://select（跳到库内指定条目），其余协议一律不开
  if (typeof url === 'string' && (/^https?:\/\//i.test(url) || /^zotero:\/\/select\//.test(url))) shell.openExternal(url);
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

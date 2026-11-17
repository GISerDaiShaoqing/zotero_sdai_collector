// 生成应用图标 assets/icon.png：「汇流 Z」
// 语义：左上三条支流（微信推送/飞书/剪贴板）汇入一条白色流道，流道即 Zotero 的 Z，
// 流道中央一颗流珠（正在流动的条目），右下角 sd 签名（作者印记）——连通器。
// 运行：electron scripts/gen-icon.js
// 绘制走 Canvas 2D + executeJavaScript 取 toDataURL（本机 offscreen capturePage 报
// UnknownVizError 不可用，capturePage 路线弃用）。另输出 128px 预览供人工检查。
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Canvas 绘制脚本（几何与配色 = 设计源，改这里重跑即可迭代）
const DRAW = `
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 1024;
  const g = c.getContext('2d');
  // 底：圆角方块 + 深青渐变
  const grad = g.createLinearGradient(0, 0, 1024, 1024);
  grad.addColorStop(0, '#3f6a83');
  grad.addColorStop(0.55, '#25475c');
  grad.addColorStop(1, '#15242f');
  g.beginPath();
  if (g.roundRect) g.roundRect(0, 0, 1024, 1024, 230); else g.rect(0, 0, 1024, 1024);
  g.fillStyle = grad; g.fill();
  // 三条支流 = 三颗源头圆珠，向 Z 的起笔汇聚（珠形任何尺寸都清晰，不会像线端那样糊成一撮）
  g.fillStyle = 'rgba(255,255,255,0.9)';
  for (const [x, y] of [[176, 206], [142, 300], [176, 394]]) {
    g.beginPath(); g.arc(x, y, 24, 0, Math.PI * 2); g.fill();
  }
  // 主流道：Z（圆帽圆角，像一根管子）
  g.strokeStyle = '#ffffff'; g.lineWidth = 98; g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(296, 296); g.lineTo(728, 296); g.lineTo(296, 728); g.lineTo(728, 728);
  g.stroke();
  // 流珠：流道中央的镂空珠（底色填充 = 管道开孔）
  g.beginPath(); g.arc(512, 512, 46, 0, Math.PI * 2);
  g.fillStyle = '#2c5066'; g.fill();
  // 签名：sd（作者印记，右下角小号；大尺寸可读、小尺寸自然隐去）
  g.fillStyle = 'rgba(255,255,255,0.88)';
  g.font = '700 118px "Segoe UI", Arial, sans-serif';
  g.textAlign = 'center';
  g.fillText('sd', 852, 902);
  c.toDataURL('image/png');
`;

async function renderIcon() {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<body></body>');
  const dataUrl = await win.webContents.executeJavaScript(DRAW);
  win.destroy();
  return Buffer.from(String(dataUrl).split(',')[1], 'base64');
}

app.whenReady().then(async () => {
  try {
    const asset = path.join(__dirname, '..', 'assets', 'icon.png');
    const buf = await renderIcon();
    fs.writeFileSync(asset, buf);
    console.log('icon written:', asset);
    // 128px 预览（nativeImage 缩放，不依赖窗口捕获）
    const small = nativeImage.createFromBuffer(buf).resize({ width: 128 });
    const prev = path.join(os.tmpdir(), 'diag', 'icon_128.png');
    fs.mkdirSync(path.dirname(prev), { recursive: true });
    fs.writeFileSync(prev, small.toPNG());
    console.log('preview:', prev);
    app.quit();
  } catch (e) {
    console.error('生成失败：', e.message);
    app.exit(1);
  }
});

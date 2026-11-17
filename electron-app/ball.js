// 悬浮小球：中心点击呼出主面板；角标显示待确认数量（>0 红标+描边）
const badge = document.getElementById('badge');
const ball = document.getElementById('ball');

document.getElementById('hit').addEventListener('click', () => window.api.ballClick());
// 右键 anywhere（含外圈拖动区）：快捷菜单（面板/重弹待确认/暂停监听/重启/退出）
ball.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.api.ballMenu();
});

// 球面 = 应用图标本体（主进程注入 icon.png 的 dataURL；圆形裁掉方角呈现「汇流 Z」）
window.api.onBallIcon((dataUrl) => {
  if (dataUrl) ball.style.backgroundImage = `url("${dataUrl}")`;
});

window.api.onBallState((s) => {
  // 三态：常态深青 / 待确认（红角标+红描边）/ 暂停监听（灰化+斜杠，优先级最高）
  const paused = !!(s && s.listening === false);
  const pending = !paused && !!s && s.nPending > 0;
  if (pending) badge.textContent = s.nPending > 99 ? '99+' : String(s.nPending);
  badge.classList.toggle('hidden', !pending);
  ball.classList.toggle('alert', pending);
  ball.classList.toggle('paused', paused);
});

// 右下角卡片窗：结果通知（自动消失）+ 确认卡片（集合点选，点完自动收起）
let selected = [];

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 窗口高度贴内容收缩：读 scrollHeight 会强制同步排版，卡片增删后调用即可
function fit() {
  const h = Math.max(
    document.body.scrollHeight,
    document.documentElement.scrollHeight
  );
  window.api.hudResize(Math.round(h) + 2);
}

function maybeHide() {
  if (!document.querySelector('.card')) window.api.hudHide();
}

function addResultCard(p) {
  const el = document.createElement('div');
  el.className = 'card';
  el.innerHTML = `
    <div class="head">
      <span class="ico ${p.ok ? 'ok' : 'bad'}">${p.ok ? '✓' : '✕'}</span>
      <div class="grow">
        <div class="t">${esc(p.title)}</div>
        ${p.detail ? `<div class="d">${esc(p.detail)}</div>` : ''}
        ${p.warn ? `<div class="d warnline">⚠️ ${esc(p.warn)}</div>` : ''}
      </div>
    </div>`;
  document.body.appendChild(el);
  fit();
  setTimeout(() => {
    if (el.parentNode) el.remove();
    maybeHide();
    fit();
  }, 5600);
}

function addConfirmCard(p) {
  // 同一条目的旧确认卡先移除（改判重弹时避免两张卡都可点、重复写入）
  document.querySelectorAll('.card[data-id]').forEach((c) => {
    if (c.dataset.id === String(p.id)) c.remove();
  });
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.id = String(p.id);
  const chips = (p.paths || []).map((pt, i) =>
    `<button class="chip" data-i="${i}" data-path="${esc(pt)}">${esc(pt)}</button>`).join('');
  el.innerHTML = `
    <div class="t">${esc(p.title)}</div>
    ${(p.blogTitle || p.date) ? `<div class="meta">${esc([p.blogTitle, p.date].filter(Boolean).join(' · '))}</div>` : ''}
    ${chips ? `<div class="chips">${chips}</div>` : ''}
    ${p.warn ? `<div class="warn">⚠️ ${esc(p.warn)}</div>` : ''}
    <div class="reason">${esc(p.reason || '')}</div>
    <div class="btns">
      <button class="b b-ok">确认保存</button>
      <button class="b b-no">忽略</button>
    </div>`;
  // 卡片上的集合默认全选（确认=按提议保存，取消勾选可剔除）
  const sel = new Set((p.paths || []).slice(0, 3));
  el.querySelectorAll('.chip').forEach((c) => {
    if (sel.has(c.dataset.path)) c.classList.add('on');
    c.onclick = () => {
      const path = c.dataset.path;
      if (sel.has(path)) { sel.delete(path); c.classList.remove('on'); }
      else if (sel.size < 3) { sel.add(path); c.classList.add('on'); }
    };
  });
  el.querySelector('.b-ok').onclick = () => {
    window.api.choose(p.id, 'confirm', [...sel]);
    el.remove();
    maybeHide();
    fit();
  };
  el.querySelector('.b-no').onclick = () => {
    window.api.choose(p.id, 'ignore');
    el.remove();
    maybeHide();
    fit();
  };
  document.body.prepend(el);
  fit();
}

window.api.onHud((p) => {
  if (p.type === 'confirm') addConfirmCard(p);
  else addResultCard(p);
});

// 设置了背景图时：深色蒙层压底保证文字可读，卡片改半透明
window.api.onHudBg((dataUrl) => {
  if (dataUrl) {
    document.body.classList.add('with-bg');
    document.body.style.backgroundImage =
      `linear-gradient(rgba(18,22,28,.85), rgba(18,22,28,.85)), url("${dataUrl}")`;
    document.body.style.backgroundSize = 'cover';
    document.body.style.backgroundPosition = 'center';
  } else {
    document.body.classList.remove('with-bg');
    document.body.style.backgroundImage = '';
  }
});

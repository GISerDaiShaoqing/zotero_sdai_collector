// 面板交互逻辑
const $ = (id) => document.getElementById(id);

const STATUS_TEXT = {
  new: '处理中…', pending: '待确认', saved: '已存入', ignored: '已忽略',
  failed: '失败', pending_write: '待写入',
};
let cfg = null;
let authorized = false;

function timeStr(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderState(s) {
  const dot = $('dot');
  dot.className = 'dot' + (s.listening ? '' : ' paused');
  $('subtitle').textContent = s.listening
    ? (s.processing ? '正在处理…' : '监听剪贴板中 — 复制微信文章链接即收集')
    : '已暂停监听';
  const chips = [
    `<span class="chip${s.nCollections ? ' good' : ' warn'}">集合 ${s.nCollections}</span>`,
    `<span class="chip${s.llm !== '未配置' ? ' good' : ' warn'}">LLM ${esc(s.llm)}</span>`,
    `<span class="chip${s.feishu ? ' good' : ''}">飞书 ${s.feishu ? '已连接' : '未连接'}</span>`,
    `<span class="chip">待确认 ${s.nPending}</span>`,
  ];
  $('headChips').innerHTML = chips.join('');
  $('pauseBtn').textContent = s.listening ? '暂停监听' : '恢复监听';
  authorized = !!s.authorized;
}

function renderEvents(events) {
  const list = $('list');
  if (!events.length) {
    list.innerHTML = '<div class="empty">还没有记录<br/>去微信复制一篇公众号文章链接试试</div>';
    return;
  }
  list.innerHTML = events.map((e) => {
    const tags = (e.paths || []).map((p) => `<span class="tag">${esc(p)}</span>`).join('');
    const err = e.error && e.status === 'failed' ? `<div class="ev-error">${esc(e.error)}</div>` : '';
    const meta = [e.blogTitle, e.publishDate].filter(Boolean).join(' · ');
    return `<div class="ev">
      <div class="ev-time">${timeStr(e.createdAt)}</div>
      <div class="ev-main">
        <div class="ev-title" title="${esc(e.title || e.url)}">${esc(e.title || e.url)}</div>
        <div class="ev-meta">${esc(meta)}</div>
        ${tags ? `<div class="ev-collections">${tags}</div>` : ''}
        ${err}
      </div>
      <span class="pill ${e.status}">${STATUS_TEXT[e.status] || esc(e.status)}</span>
    </div>`;
  }).join('');
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 2400);
}

function fillSettings() {
  $('cfgBaseUrl').value = cfg.llmBaseUrl || '';
  $('cfgKey').value = cfg.llmKey || '';
  $('cfgModel').value = cfg.llmModel || '';
  $('cfgThreshold').value = cfg.threshold;
  $('cfgAutoWrite').checked = !!cfg.autoWrite;
  $('cfgFeishuId').value = cfg.feishuAppId || '';
  $('cfgFeishuSecret').value = cfg.feishuAppSecret || '';
  $('bgName').textContent = cfg.hudBg ? cfg.hudBg.split(/[\\/]/).pop() : '未设置';
  $('zotCount').textContent = `${cfg._nCollections ?? '—'}`;
  $('zotAuth').textContent = authorized ? '已授权 ✓' : '未授权（首次写入时自动请求）';
}

window.addEventListener('DOMContentLoaded', async () => {
  const init = await window.api.getInit();
  cfg = init.config;
  authorized = init.authorized;
  renderState(init.status);
  renderEvents(init.events);

  window.api.onState((snap) => {
    authorized = snap.authorized;
    renderState(snap.status);
    renderEvents(snap.events);
    if (cfg) cfg._nCollections = snap.status.nCollections;
  });

  $('settingsBtn').onclick = async () => {
    cfg = await window.api.getConfig();
    fillSettings();
    $('settingsMask').classList.remove('hidden');
  };
  $('settingsClose').onclick = () => $('settingsMask').classList.add('hidden');
  $('settingsMask').onclick = (e) => {
    if (e.target === $('settingsMask')) $('settingsMask').classList.add('hidden');
  };
  $('saveCfgBtn').onclick = async () => {
    cfg = await window.api.saveConfig({
      llmBaseUrl: $('cfgBaseUrl').value.trim(),
      llmKey: $('cfgKey').value.trim(),
      llmModel: $('cfgModel').value.trim(),
      threshold: Number($('cfgThreshold').value) || 0.7,
      autoWrite: $('cfgAutoWrite').checked,
      feishuAppId: $('cfgFeishuId').value.trim(),
      feishuAppSecret: $('cfgFeishuSecret').value.trim(),
    });
    $('settingsMask').classList.add('hidden');
    toast('设置已保存，立即生效');
  };
  $('refreshTreeBtn').onclick = async () => {
    const r = await window.api.refreshCollections();
    toast(`集合树已刷新：${r.n} 个`);
  };
  $('pickBgBtn').onclick = async () => {
    const r = await window.api.pickBg();
    if (r.ok) {
      $('bgName').textContent = r.path.split(/[\\/]/).pop();
      toast('背景图已设置，立即生效');
    }
  };
  $('clearBgBtn').onclick = async () => {
    await window.api.clearBg();
    $('bgName').textContent = '未设置';
    toast('背景已清除');
  };
  $('authorizeBtn').onclick = async () => {
    toast('请在 Zotero 弹窗中点“总是允许”…');
    const r = await window.api.authorize();
    if (r.ok) toast('授权成功');
    else toast('授权失败：' + (r.message || '').slice(0, 60));
  };

  $('pauseBtn').onclick = () => {
    window.api.setPaused($('pauseBtn').textContent === '暂停监听');
  };
  $('reconfirmBtn').onclick = () => {
    window.api.reconfirm();
    toast('已弹出待确认卡片');
  };
  $('clearBtn').onclick = () => {
    window.api.clearHistory();
    toast('显示已清空');
  };
});

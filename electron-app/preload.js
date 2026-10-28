const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getInit: () => ipcRenderer.invoke('get-init'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  setPaused: (p) => ipcRenderer.invoke('set-paused', p),
  refreshCollections: () => ipcRenderer.invoke('refresh-collections'),
  reconfirm: () => ipcRenderer.invoke('reconfirm'),
  clearHistory: () => ipcRenderer.invoke('clear-history'),
  saveConfig: (c) => ipcRenderer.invoke('save-config', c),
  authorize: () => ipcRenderer.invoke('authorize'),
  choose: (id, action, paths) => ipcRenderer.invoke('choose', { id, action, paths }),
  hudHide: () => ipcRenderer.invoke('hud-hide'),
  hudResize: (h) => ipcRenderer.send('hud-resize', h),
  pickBg: () => ipcRenderer.invoke('pick-bg'),
  clearBg: () => ipcRenderer.invoke('clear-bg'),
  quit: () => ipcRenderer.invoke('quit'),
  openUrl: (u) => ipcRenderer.invoke('open-url', u),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  onState: (cb) => ipcRenderer.on('state', (e, s) => cb(s)),
  onHud: (cb) => ipcRenderer.on('hud', (e, p) => cb(p)),
  onAbout: (cb) => ipcRenderer.on('about', () => cb()),
  onHudBg: (cb) => ipcRenderer.on('hud-bg', (e, d) => cb(d)),
});

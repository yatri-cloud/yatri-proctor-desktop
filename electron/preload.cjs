// Narrow bridge between the sandboxed renderer and the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('yp', {
  systemInfo: () => ipcRenderer.invoke('yp:system-info'),
  askMedia: () => ipcRenderer.invoke('yp:ask-media'),
  openPrivacy: (pane) => ipcRenderer.invoke('yp:open-privacy', pane),
  scanApps: () => ipcRenderer.invoke('yp:scan-apps'),
  redeem: (code) => ipcRenderer.invoke('yp:redeem', code),
  closeApps: (labels) => ipcRenderer.invoke('yp:close-apps', labels),
  lockdown: (on) => ipcRenderer.invoke('yp:lockdown', on),
  confirmQuit: () => ipcRenderer.invoke('yp:confirm-quit'),
  quit: () => ipcRenderer.invoke('yp:quit'),
  onLaunch: (cb) => { const h = (_e, code) => cb(code); ipcRenderer.on('yp:launch', h); return () => ipcRenderer.removeListener('yp:launch', h); },
  onEvent: (cb) => { const h = (_e, ev) => cb(ev); ipcRenderer.on('yp:event', h); return () => ipcRenderer.removeListener('yp:event', h); },
  onCloseRequested: (cb) => { const h = () => cb(); ipcRenderer.on('yp:close-requested', h); return () => ipcRenderer.removeListener('yp:close-requested', h); },
});

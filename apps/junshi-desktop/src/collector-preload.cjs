const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('junshiCollector', {
  getStatus: () => ipcRenderer.invoke('junshi:collector-status'),
  openUrl: (url) => ipcRenderer.invoke('junshi:collector-open-url', { url }),
  openSelf: () => ipcRenderer.invoke('junshi:collector-open-self'),
  collect: (mode) => ipcRenderer.invoke('junshi:collector-capture', { mode }),
  syncAll: () => ipcRenderer.invoke('junshi:collector-sync-all'),
  updateSettings: (patch) => ipcRenderer.invoke('junshi:collector-update-settings', patch),
  openWorkbench: () => ipcRenderer.invoke('junshi:open-workbench'),
  checkForUpdates: () => ipcRenderer.invoke('junshi:check-updates', { manual: true }),
  installUpdate: () => ipcRenderer.invoke('junshi:install-update'),
  onStatus: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('junshi:collector-status-event', listener);
    return () => ipcRenderer.removeListener('junshi:collector-status-event', listener);
  },
});


const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('junshiDesktop', {
  bootstrap: () => ipcRenderer.invoke('junshi:bootstrap'),
  login: (login, password, mfaCode = '') => ipcRenderer.invoke('junshi:login', { login, password, mfaCode }),
  openWorkbench: () => ipcRenderer.invoke('junshi:open-workbench'),
  clearSession: () => ipcRenderer.invoke('junshi:clear-session'),
  openCollector: () => ipcRenderer.invoke('junshi:open-collector'),
  openCollectorSelf: () => ipcRenderer.invoke('junshi:open-collector-self'),
  getCollectorStatus: () => ipcRenderer.invoke('junshi:collector-status'),
  syncAllPeers: () => ipcRenderer.invoke('junshi:collector-sync-all'),
  onCollectorStatus: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('junshi:collector-status-event', listener);
    return () => ipcRenderer.removeListener('junshi:collector-status-event', listener);
  },
});


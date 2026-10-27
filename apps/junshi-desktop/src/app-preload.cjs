const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('junshiApp', {
  bootstrap: () => ipcRenderer.invoke('junshi:app-bootstrap'),
  api: (path, options = {}) => ipcRenderer.invoke('junshi:app-api', { path, options }),
  downloadAsset: (payload) => ipcRenderer.invoke('junshi:app-download-asset', payload),
  uploadAsset: (payload) => ipcRenderer.invoke('junshi:app-upload-asset', payload),
  chat: (payload) => ipcRenderer.invoke('junshi:app-chat', payload),
  cancelChat: (requestId) => ipcRenderer.invoke('junshi:app-chat-cancel', { requestId }),
  onChatEvent: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('junshi:app-chat-event', listener);
    return () => ipcRenderer.removeListener('junshi:app-chat-event', listener);
  },
  openCollector: () => ipcRenderer.invoke('junshi:open-collector'),
  openCollectorSelf: () => ipcRenderer.invoke('junshi:open-collector-self'),
  openCollectorUrl: (url) => ipcRenderer.invoke('junshi:collector-open-url', { url }),
  syncAll: () => ipcRenderer.invoke('junshi:collector-sync-all'),
  getCollectorStatus: () => ipcRenderer.invoke('junshi:collector-status'),
  onCollectorStatus: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('junshi:collector-status-event', listener);
    return () => ipcRenderer.removeListener('junshi:collector-status-event', listener);
  },
  updateSettings: (patch) => ipcRenderer.invoke('junshi:collector-update-settings', patch),
  checkUpdates: () => ipcRenderer.invoke('junshi:check-updates', { manual: true }),
  logout: () => ipcRenderer.invoke('junshi:clear-session'),
});

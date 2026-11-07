// TaskMeter Pro Studio — Preload Script
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isDesktop: true,
  sendNotification: (title, body) => ipcRenderer.send('desktop:notify', { title, body }),
  updateTrayTitle: (text) => ipcRenderer.send('desktop:update-tray-title', text),
  onToggleTimer: (callback) => ipcRenderer.on('desktop:toggle-timer', () => callback()),
  onSwitchView: (callback) => ipcRenderer.on('desktop:switch-view', (event, viewName) => callback(viewName))
});

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('atris', {
  run: (command) => ipcRenderer.invoke('run-atris', command),
  onOutput: (callback) => ipcRenderer.on('atris-output', (event, data) => callback(data))
});

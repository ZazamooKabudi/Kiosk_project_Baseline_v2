const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kioskAPI', {
  saveUrl:   (url) => ipcRenderer.send('save-url',   url),
  updateUrl: (url) => ipcRenderer.send('update-url', url),
  onError:   (cb)  => ipcRenderer.on('setup-error', (_e, msg) => cb(msg))
});

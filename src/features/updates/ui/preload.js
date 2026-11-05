// SPDX-License-Identifier: AGPL-3.0-or-later
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('downloaderApi', {
  onState: (fn) => ipcRenderer.on('updates:state', (_e, state) => fn(state)),
  ready: () => ipcRenderer.send('updates:ready'),
  cancel: () => ipcRenderer.send('updates:cancel'),
  close: () => ipcRenderer.send('updates:close'),
  retry: () => ipcRenderer.invoke('updates:install'),
});

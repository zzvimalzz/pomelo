// SPDX-License-Identifier: AGPL-3.0-or-later
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('pomelo', {
  onOpen: (cb) => ipcRenderer.on('wheel:open', (_e, data) => cb(data)),
  onClose: (cb) => ipcRenderer.on('wheel:close', () => cb()),
  pathFor: (file) => webUtils.getPathForFile(file),
  drop: (targetId, paths) => ipcRenderer.send('wheel:drop', { targetId, paths }),
  cancel: () => ipcRenderer.send('wheel:cancel'),
  log: (msg) => ipcRenderer.send('overlay:log', msg),
  ready: () => ipcRenderer.send('overlay:ready'),
});

// SPDX-License-Identifier: AGPL-3.0-or-later
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('pomelo', {
  onOpen: (cb) => ipcRenderer.on('wheel:open', (_e, data) => cb(data)),
  onSwitch: (cb) => ipcRenderer.on('wheel:switch', (_e, data) => cb(data)),
  onUnlock: (cb) => ipcRenderer.on('wheel:unlock-open', (_e, data) => cb(data)),
  unlock: (request) => ipcRenderer.invoke('wheel:unlock', request),
  card: (rect) => ipcRenderer.send('wheel:card', rect),
  onClose: (cb) => ipcRenderer.on('wheel:close', () => cb()),
  pathFor: (file) => webUtils.getPathForFile(file),
  drop: (targetId, paths) => ipcRenderer.send('wheel:drop', { targetId, paths }),
  pick: (targetId) => ipcRenderer.send('wheel:pick', targetId),
  cancel: () => ipcRenderer.send('wheel:cancel'),
  log: (msg) => ipcRenderer.send('overlay:log', msg),
  ready: () => ipcRenderer.send('overlay:ready'),
});

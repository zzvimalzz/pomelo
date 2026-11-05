// SPDX-License-Identifier: AGPL-3.0-or-later
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('toast', {
  onView: (cb) => ipcRenderer.on('toast:view', (_e, view) => cb(view)),
  reveal: (file) => ipcRenderer.send('toast:reveal', file),
  remove: (id) => ipcRenderer.send('toast:remove', id),
  cancel: (id) => ipcRenderer.send('toast:cancel', id),
  click: (id) => ipcRenderer.send('toast:click', id),
  ready: () => ipcRenderer.send('toast:ready'),
});

// SPDX-License-Identifier: AGPL-3.0-or-later
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsApi', {
  get: () => ipcRenderer.invoke('settings:get'),
  set: (patch) => ipcRenderer.invoke('settings:set', patch),
  fit: (height) => ipcRenderer.send('settings:fit', height),
  copy: (text) => ipcRenderer.send('app:copy', text),
  openLogs: () => ipcRenderer.send('app:open-logs'),
  uninstall: () => ipcRenderer.invoke('app:uninstall'),
  installEngine: (key) => ipcRenderer.invoke('engines:install', key),
  onEngineProgress: (fn) => ipcRenderer.on('engines:progress', (_e, installing) => fn(installing)),
  checkUpdates: () => ipcRenderer.invoke('updates:check'),
  downloadUpdate: (url) => ipcRenderer.invoke('updates:download', url),
  onUpdateFound: (fn) => ipcRenderer.on('updates:found', (_e, result) => fn(result)),
});

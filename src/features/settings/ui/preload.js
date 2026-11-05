// SPDX-License-Identifier: AGPL-3.0-or-later
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsApi', {
  get: () => ipcRenderer.invoke('settings:get'),
  set: (patch) => ipcRenderer.invoke('settings:set', patch),
  chooseOutput: () => ipcRenderer.invoke('settings:choose-output'),
  fit: (height) => ipcRenderer.send('settings:fit', height),
  copy: (text) => ipcRenderer.send('app:copy', text),
  openGuide: () => ipcRenderer.send('settings:open-guide'),
  openLogs: () => ipcRenderer.send('app:open-logs'),
  uninstall: () => ipcRenderer.invoke('app:uninstall'),
  installEngine: (key) => ipcRenderer.invoke('engines:install', key),
  onEngineProgress: (fn) => ipcRenderer.on('engines:progress', (_e, installing) => fn(installing)),
  checkUpdates: () => ipcRenderer.invoke('updates:check'),
  downloadUpdate: (url) => ipcRenderer.invoke('updates:download', url),
  installUpdate: () => ipcRenderer.invoke('updates:install'),
  onUpdateProgress: (fn) => ipcRenderer.on('updates:progress', (_e, p) => fn(p)),
  onUpdateFound: (fn) => ipcRenderer.on('updates:found', (_e, result) => fn(result)),
});

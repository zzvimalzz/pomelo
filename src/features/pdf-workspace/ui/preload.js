// SPDX-License-Identifier: AGPL-3.0-or-later
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('workspaceApi', {
  state: () => ipcRenderer.invoke('pdfws:state'),
  read: (token, begin, end) => ipcRenderer.invoke('pdfws:read', token, begin, end),
  unlock: (token, password) => ipcRenderer.invoke('pdfws:unlock', token, password),
  setDock: (side) => ipcRenderer.invoke('pdfws:dock', side),
  setView: (patch) => ipcRenderer.invoke('pdfws:view', patch),
  focus: (on) => ipcRenderer.invoke('pdfws:focus', on),
  checkLink: (url) => ipcRenderer.invoke('pdfws:check-link', url),
  openLink: (url) => ipcRenderer.invoke('pdfws:open-link', url),
  copyLink: (url) => ipcRenderer.invoke('pdfws:copy-link', url),
  copyLinks: (urls) => ipcRenderer.invoke('pdfws:copy-links', urls),
  onFocus: (cb) => ipcRenderer.on('pdfws:focus-changed', (_e, on) => cb(on)),
});

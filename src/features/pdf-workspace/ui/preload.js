// SPDX-License-Identifier: AGPL-3.0-or-later
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('workspaceApi', {
  state: () => ipcRenderer.invoke('pdfws:state'),
  read: (token, begin, end) => ipcRenderer.invoke('pdfws:read', token, begin, end),
  unlock: (token, password) => ipcRenderer.invoke('pdfws:unlock', token, password),
  close: (token) => ipcRenderer.invoke('pdfws:close', token),
  putRevision: (token, bytes) => ipcRenderer.invoke('pdfws:put-revision', token, bytes),
  apply: (token, ops) => ipcRenderer.invoke('pdfws:apply', token, ops),
  undo: (token) => ipcRenderer.invoke('pdfws:undo', token),
  redo: (token) => ipcRenderer.invoke('pdfws:redo', token),
  save: (token) => ipcRenderer.invoke('pdfws:save', token),
  saveAs: (token) => ipcRenderer.invoke('pdfws:save-as', token),
  reload: (token) => ipcRenderer.invoke('pdfws:reload', token),
  closeWindow: () => ipcRenderer.invoke('pdfws:close-window'),
  setDock: (side) => ipcRenderer.invoke('pdfws:dock', side),
  setView: (patch) => ipcRenderer.invoke('pdfws:view', patch),
  focus: (on) => ipcRenderer.invoke('pdfws:focus', on),
  checkLink: (url) => ipcRenderer.invoke('pdfws:check-link', url),
  openLink: (url) => ipcRenderer.invoke('pdfws:open-link', url),
  copyLink: (url) => ipcRenderer.invoke('pdfws:copy-link', url),
  copyLinks: (urls) => ipcRenderer.invoke('pdfws:copy-links', urls),
  onFocus: (cb) => ipcRenderer.on('pdfws:focus-changed', (_e, on) => cb(on)),
  onChanged: (cb) => ipcRenderer.on('pdfws:changed', (_e, document) => cb(document)),
  onClosing: (cb) => ipcRenderer.on('pdfws:closing', () => cb()),
  onOpened: (cb) => ipcRenderer.on('pdfws:opened', (_e, documents) => cb(documents)),
});

// A drop is read here and sent on, so the page never sees a path. A drop made up by a script has no file behind it.
const carriesFiles = (e) => e.isTrusted && e.dataTransfer.types.includes('Files');
document.addEventListener('dragover', (e) => { if (carriesFiles(e)) e.preventDefault(); });
document.addEventListener('drop', (e) => {
  if (!carriesFiles(e)) return;
  e.preventDefault();
  ipcRenderer.invoke('pdfws:drop', [...e.dataTransfer.files].map((file) => webUtils.getPathForFile(file)).filter(Boolean));
});

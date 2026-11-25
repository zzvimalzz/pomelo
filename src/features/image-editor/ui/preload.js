// SPDX-License-Identifier: AGPL-3.0-or-later
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('editorApi', {
  state: () => ipcRenderer.invoke('imged:state'),
  pixels: (token, begin, end) => ipcRenderer.invoke('imged:pixels', token, begin, end),
  pixelsDone: (token) => ipcRenderer.invoke('imged:pixels-done', token),
  close: (token) => ipcRenderer.invoke('imged:close', token),
  showInFolder: (token) => ipcRenderer.invoke('imged:show', token),
  setView: (patch) => ipcRenderer.invoke('imged:view', patch),
  fullScreen: (on) => ipcRenderer.invoke('imged:full-screen', on),
  save: (token, rgba, options) => ipcRenderer.invoke('imged:save', token, rgba, options),
  setDirty: (token, dirty) => ipcRenderer.invoke('imged:dirty', token, dirty),
  closeWindow: () => ipcRenderer.invoke('imged:close-window'),
  onFullScreen: (cb) => ipcRenderer.on('imged:full-screen-changed', (_e, on) => cb(on)),
  onClosing: (cb) => ipcRenderer.on('imged:closing', () => cb()),
  onOpened: (cb) => ipcRenderer.on('imged:opened', (_e, images) => cb(images)),
});

// A drop is read here and sent on, so the page never sees a path. A drop made up by a script has no file behind it.
const carriesFiles = (e) => e.isTrusted && e.dataTransfer.types.includes('Files');
document.addEventListener('dragover', (e) => { if (carriesFiles(e)) e.preventDefault(); });
document.addEventListener('drop', (e) => {
  if (!carriesFiles(e)) return;
  e.preventDefault();
  ipcRenderer.invoke('imged:drop', [...e.dataTransfer.files].map((file) => webUtils.getPathForFile(file)).filter(Boolean));
});

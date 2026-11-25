// SPDX-License-Identifier: AGPL-3.0-or-later
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('workspaceApi', {
  state: () => ipcRenderer.invoke('pdfws:state'),
  read: (token, begin, end) => ipcRenderer.invoke('pdfws:read', token, begin, end),
  unlock: (token, password) => ipcRenderer.invoke('pdfws:unlock', token, password),
  close: (token) => ipcRenderer.invoke('pdfws:close', token),
  putRevision: (token, bytes) => ipcRenderer.invoke('pdfws:put-revision', token, bytes),
  apply: (token, ops) => ipcRenderer.invoke('pdfws:apply', token, ops),
  properties: (token) => ipcRenderer.invoke('pdfws:properties', token),
  details: (token) => ipcRenderer.invoke('pdfws:details', token),
  rename: (token, name) => ipcRenderer.invoke('pdfws:rename', token, name),
  showInFolder: (token) => ipcRenderer.invoke('pdfws:show', token),
  engine: () => ipcRenderer.invoke('pdfws:engine'),
  installEngine: () => ipcRenderer.invoke('pdfws:install-engine'),
  undo: (token) => ipcRenderer.invoke('pdfws:undo', token),
  redo: (token) => ipcRenderer.invoke('pdfws:redo', token),
  save: (token) => ipcRenderer.invoke('pdfws:save', token),
  saveAs: (token, openCopy) => ipcRenderer.invoke('pdfws:save-as', token, openCopy),
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
  onInstallNote: (cb) => ipcRenderer.on('pdfws:install-note', (_e, progress) => cb(progress)),
  onClosing: (cb) => ipcRenderer.on('pdfws:closing', () => cb()),
  onOpened: (cb) => ipcRenderer.on('pdfws:opened', (_e, documents) => cb(documents)),
  chooseSources: (kind) => ipcRenderer.invoke('pdfws:choose-sources', kind),
  unlockSource: (id, password) => ipcRenderer.invoke('pdfws:unlock-source', id, password),
  extract: (token, pages) => ipcRenderer.invoke('pdfws:extract', token, pages),
  combine: (token, ids, at) => ipcRenderer.invoke('pdfws:combine', token, ids, at),
  split: (token, request, total) => ipcRenderer.invoke('pdfws:split', token, request, total),
  onFilesDropped: (cb) => { dropped = cb; },
});

// A drop is read here and sent on, so the page never sees a path. A drop made up by a script has no file behind it. On the grid of pages
// the files are offered to the page to insert; anywhere else they are opened.
let dropped = null;
const carriesFiles = (e) => e.isTrusted && e.dataTransfer.types.includes('Files');
document.addEventListener('dragover', (e) => { if (carriesFiles(e)) e.preventDefault(); });
document.addEventListener('drop', (e) => {
  if (!carriesFiles(e)) return;
  e.preventDefault();
  const paths = [...e.dataTransfer.files].map((file) => webUtils.getPathForFile(file)).filter(Boolean);
  if (e.target.closest?.('.pgrid')) ipcRenderer.invoke('pdfws:drop-sources', paths).then((sources) => dropped?.(sources));
  else ipcRenderer.invoke('pdfws:drop', paths);
});

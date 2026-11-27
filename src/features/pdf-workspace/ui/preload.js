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
  installEngine: (key) => ipcRenderer.invoke('pdfws:install-engine', key),
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
  onInstallNote: (cb) => { const on = (_e, progress) => cb(progress); ipcRenderer.on('pdfws:install-note', on); return () => ipcRenderer.off('pdfws:install-note', on); },
  onClosing: (cb) => ipcRenderer.on('pdfws:closing', () => cb()),
  onOpened: (cb) => ipcRenderer.on('pdfws:opened', (_e, documents) => cb(documents)),
  chooseSources: async (onPicked) => {
    const paths = await ipcRenderer.invoke('pdfws:choose-sources');
    if (!paths.length) return [];
    onPicked(paths.length);
    return ipcRenderer.invoke('pdfws:drop-sources', paths);
  },
  unlockSource: (id, password) => ipcRenderer.invoke('pdfws:unlock-source', id, password),
  extract: (token, pages) => ipcRenderer.invoke('pdfws:extract', token, pages),
  split: (token, request, total) => ipcRenderer.invoke('pdfws:split', token, request, total),
  splitPlan: (request, total) => ipcRenderer.invoke('pdfws:split-plan', request, total),
  onFilesDropped: (cb) => { dropped.add(cb); return () => dropped.delete(cb); },
});

// A drop is read here and sent on, so the page never sees a path. A drop made up by a script has no file behind it. On the grid of pages
// and in the Add files card the files are offered to the page; anywhere else they are opened.
const dropped = new Set();
const carriesFiles = (e) => e.isTrusted && e.dataTransfer.types.includes('Files');
document.addEventListener('dragover', (e) => { if (carriesFiles(e)) e.preventDefault(); });
document.addEventListener('drop', (e) => {
  if (!carriesFiles(e)) return;
  e.preventDefault();
  const paths = [...e.dataTransfer.files].map((file) => webUtils.getPathForFile(file)).filter(Boolean);
  const into = e.target.closest?.('[data-drops]') ? 'card' : e.target.closest?.('.pgrid') ? 'grid' : null;
  if (into) ipcRenderer.invoke('pdfws:drop-sources', paths).catch(() => []).then((sources) => { for (const cb of dropped) cb(sources, into); });
  else ipcRenderer.invoke('pdfws:drop', paths);
});

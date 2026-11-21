// SPDX-License-Identifier: AGPL-3.0-or-later
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('workspaceApi', {
  state: () => ipcRenderer.invoke('pdfws:state'),
  read: (token, begin, end) => ipcRenderer.invoke('pdfws:read', token, begin, end),
});

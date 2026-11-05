// SPDX-License-Identifier: AGPL-3.0-or-later
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('guideApi', {
  data: () => ipcRenderer.invoke('guide:data'),
  fit: (height) => ipcRenderer.send('guide:fit', height),
  website: () => ipcRenderer.send('guide:website'),
  close: () => ipcRenderer.send('guide:close'),
});

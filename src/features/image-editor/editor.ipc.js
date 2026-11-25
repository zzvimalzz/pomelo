// SPDX-License-Identifier: AGPL-3.0-or-later
// The editor page's messages to the main process. The preload (ui/preload.js) sends the same channel names. Only the editor window
// may ask: a handler refuses any other sender.
const { ipcMain } = require('electron');

// images: the open pictures (images.js). state(): what the page starts from. closeImage(token): close a tab's picture, and the window
// with the last one. openDropped(paths): open the pictures among the paths of a drop. showInFolder(token): show the file in Explorer.
// setView(patch): keep the valid fields of the view (view.js). setFullScreen(on): enter or leave full screen. closeWindow(): close the window.
// isEditor(sender): is this the editor window's page.
function registerEditorIpc({ images, state, closeImage, openDropped, showInFolder, setView, setFullScreen, closeWindow, isEditor }) {
  const guard = (e) => { if (!isEditor(e.sender)) throw new Error('not the editor window'); };
  ipcMain.handle('imged:state', (e) => { guard(e); return state(); });
  ipcMain.handle('imged:pixels', (e, token, begin, end) => { guard(e); return images.pixels(token, begin, end); });
  ipcMain.handle('imged:pixels-done', (e, token) => { guard(e); images.pixelsDone(token); });
  ipcMain.handle('imged:close', (e, token) => { guard(e); closeImage(token); });
  ipcMain.handle('imged:drop', (e, paths) => { guard(e); openDropped(paths); });
  ipcMain.handle('imged:show', (e, token) => { guard(e); showInFolder(token); });
  ipcMain.handle('imged:view', (e, patch) => { guard(e); setView(patch); });
  ipcMain.handle('imged:full-screen', (e, on) => { guard(e); setFullScreen(on === true); });
  ipcMain.handle('imged:close-window', (e) => { guard(e); closeWindow(); });
}

module.exports = { registerEditorIpc };

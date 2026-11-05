// SPDX-License-Identifier: AGPL-3.0-or-later
// The toast page's messages to the main process. The preload (ui/preload.js) sends the same channel names.
const { ipcMain, shell } = require('electron');

// onReady(): the page has loaded. onRemove(id): a card finished fading out. onCancel(id): the X in a progress ring was pressed.
// onClick(id): a card that is a button was clicked.
function registerToastIpc({ onReady, onRemove, onCancel, onClick }) {
  ipcMain.once('toast:ready', onReady);
  ipcMain.on('toast:reveal', (_e, file) => { if (file) shell.showItemInFolder(file); });
  ipcMain.on('toast:remove', (_e, id) => onRemove(id));
  ipcMain.on('toast:cancel', (_e, id) => onCancel(id));
  ipcMain.on('toast:click', (_e, id) => onClick(id));
}

module.exports = { registerToastIpc };

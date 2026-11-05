// SPDX-License-Identifier: AGPL-3.0-or-later
// The wheel page's messages to the main process. The preload (ui/preload.js) sends the same channel names.
const { ipcMain } = require('electron');

// onLog(msg): the page wants something in the debug log. onReady(): the page has loaded. onDrop(paths, targetId): files were
// dropped on a segment. onPick(targetId): a segment was clicked, when the wheel was opened from the right-click menu. onCancel(): the
// page asks to be closed.
function registerWheelIpc({ onLog, onReady, onDrop, onPick, onCancel }) {
  ipcMain.on('overlay:log', (_e, msg) => onLog(msg));
  ipcMain.once('overlay:ready', onReady);
  ipcMain.on('wheel:drop', (_e, { targetId, paths }) => onDrop(paths, targetId));
  ipcMain.on('wheel:pick', (_e, targetId) => onPick(String(targetId)));
  ipcMain.on('wheel:cancel', onCancel);
}

module.exports = { registerWheelIpc };

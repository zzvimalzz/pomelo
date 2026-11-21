// SPDX-License-Identifier: AGPL-3.0-or-later
// The wheel page's messages to the main process. The preload (ui/preload.js) sends the same channel names.
const { ipcMain } = require('electron');

// onLog(msg): the page wants something in the debug log. onReady(): the page has loaded. onDrop(paths, targetId): files were
// dropped on a segment. onPick(targetId): a segment was clicked, when the wheel was opened from the right-click menu. onCancel(): the
// page asks to be closed. onUnlock({ token, password, all }): the password card sent a password; the answer goes back to the page.
// isWheel(sender): the page that is allowed to send these. onCard(rect): where the card is in the page ({ x, y, width, height }), or null when there is none.
function registerWheelIpc({ onLog, onReady, onDrop, onPick, onCancel, onUnlock, onCard, isWheel }) {
  ipcMain.on('overlay:log', (_e, msg) => onLog(msg));
  ipcMain.once('overlay:ready', onReady);
  ipcMain.on('wheel:drop', (_e, { targetId, paths }) => onDrop(paths, targetId));
  ipcMain.on('wheel:pick', (_e, targetId) => onPick(String(targetId)));
  ipcMain.on('wheel:cancel', onCancel);
  ipcMain.handle('wheel:unlock', (e, request) => {
    const { token, password, all } = request || {};
    if (!isWheel(e.sender) || typeof token !== 'string' || typeof password !== 'string' || typeof all !== 'boolean') throw new Error('bad request');
    return onUnlock({ token, password, all });
  });
  ipcMain.on('wheel:card', (e, rect) => {
    const sides = ['x', 'y', 'width', 'height'];
    if (!isWheel(e.sender) || (rect !== null && !(rect && typeof rect === 'object' && sides.every((k) => Number.isFinite(rect[k]))))) return;
    onCard(rect === null ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
  });
}

module.exports = { registerWheelIpc };

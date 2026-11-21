// SPDX-License-Identifier: AGPL-3.0-or-later
// The workspace page's messages to the main process. The preload (ui/preload.js) sends the same channel names. Only the workspace
// window may ask: a handler refuses any other sender.
const { ipcMain } = require('electron');

// documents: the open documents (documents.js). state(): what the page starts from. isWorkspace(sender): is this the workspace window's page.
function registerWorkspaceIpc({ documents, state, isWorkspace }) {
  const guard = (e) => { if (!isWorkspace(e.sender)) throw new Error('not the workspace window'); };
  ipcMain.handle('pdfws:state', (e) => { guard(e); return state(); });
  ipcMain.handle('pdfws:read', (e, token, begin, end) => { guard(e); return documents.read(token, begin, end); });
}

module.exports = { registerWorkspaceIpc };

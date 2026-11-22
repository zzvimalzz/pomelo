// SPDX-License-Identifier: AGPL-3.0-or-later
// The workspace page's messages to the main process. The preload (ui/preload.js) sends the same channel names. Only the workspace
// window may ask: a handler refuses any other sender.
const { ipcMain } = require('electron');

// documents: the open documents (documents.js). state(): what the page starts from. setFocus(on): enter or leave full screen.
// setDock(side): keep the dock's place. setView(patch): keep the valid fields of the view (view.js). checkLink(url): the address a link may open, or null. openLink(url): open it. copyLink(url): put
// it on the clipboard. copyLinks(urls): put the ones that may be opened on it, one to a line, and answer how many. isWorkspace(sender): is this the workspace window's page.
function registerWorkspaceIpc({ documents, state, setFocus, setDock, setView, checkLink, openLink, copyLink, copyLinks, isWorkspace }) {
  const guard = (e) => { if (!isWorkspace(e.sender)) throw new Error('not the workspace window'); };
  ipcMain.handle('pdfws:state', (e) => { guard(e); return state(); });
  ipcMain.handle('pdfws:read', (e, token, begin, end) => { guard(e); return documents.read(token, begin, end); });
  ipcMain.handle('pdfws:unlock', (e, token, password) => { guard(e); documents.unlock(token, password); });
  ipcMain.handle('pdfws:dock', (e, side) => { guard(e); setDock(side); });
  ipcMain.handle('pdfws:view', (e, patch) => { guard(e); setView(patch); });
  ipcMain.handle('pdfws:focus', (e, on) => { guard(e); setFocus(on === true); });
  ipcMain.handle('pdfws:check-link', (e, url) => { guard(e); return checkLink(url); });
  ipcMain.handle('pdfws:open-link', (e, url) => { guard(e); openLink(url); });
  ipcMain.handle('pdfws:copy-link', (e, url) => { guard(e); copyLink(url); });
  ipcMain.handle('pdfws:copy-links', (e, urls) => { guard(e); return copyLinks(urls); });
}

module.exports = { registerWorkspaceIpc };

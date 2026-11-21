// SPDX-License-Identifier: AGPL-3.0-or-later
// The PDF workspace: a window that reads PDFs. The rest of the app uses only this file. The window code is loaded the first time a
// PDF is opened, so a Pomelo that never opens one pays nothing for it.
const os = require('os');
const path = require('path');
const { createDocuments } = require('./documents');
const { registerWorkspaceIpc } = require('./workspace.ipc');

const WINDOWS_11 = 22621;
const DOCKS = ['bottom', 'top', 'left', 'right'];

const REASONS = {
  ENOENT: 'The file is no longer there.', ENOTFILE: 'This is not a file.',
  EACCES: "Windows won't let Pomelo read this file.", EPERM: "Windows won't let Pomelo read this file.", EBUSY: "Windows won't let Pomelo read this file.",
};

// asset(name): path of a file shipped in assets/. getSettings(), setSettings(patch): the stored settings. notify({ title, detail }): the
// notice in the corner of the screen. log(...). solid: draw an opaque window; by default only before Windows 11.
function createWorkspace({ asset, getSettings, setSettings, notify, log, solid = Number(os.release().split('.')[2]) < WINDOWS_11 }) {
  const documents = createDocuments();
  let win = null;
  let current = null;
  let opening = false;

  const setView = (patch) => setSettings({ pdfView: { ...getSettings().pdfView, ...patch } });
  const dock = () => { const side = getSettings().pdfView?.dock; return DOCKS.includes(side) ? side : 'bottom'; };

  const focus = () => { if (win.isMinimized()) win.restore(); win.show(); win.focus(); };

  // Opens the first of the paths in a new window. While a window is open a later call only brings it to the front.
  async function open(paths) {
    if (win && !win.isDestroyed()) { focus(); return; }
    if (opening || !paths.length) return;
    opening = true;
    try {
      const file = paths[0];
      try {
        current = await documents.open(file);
      } catch (e) {
        log('cannot open PDF:', path.basename(file), e.code || e.message);
        notify({ title: "Can't open this file", detail: REASONS[e.code] || 'The file could not be read.' });
        return;
      }
      win = require('./workspace.window').create({
        asset, solid, saved: getSettings().pdfView?.window,
        onBounds: (bounds) => setView({ window: bounds }),
      });
      win.on('closed', () => { win = null; current = null; documents.closeAll(); });
    } finally {
      opening = false;
    }
  }

  async function openDialog() {
    await open(await require('./workspace.window').choosePdf(win && !win.isDestroyed() ? win : null));
  }

  const registerIpc = () => registerWorkspaceIpc({
    documents,
    state: () => ({ documents: current ? [current] : [], dock: dock() }),
    setFocus: (on) => win?.setFullScreen(on),
    setDock: (side) => { if (DOCKS.includes(side)) setView({ dock: side }); },
    isWorkspace: (sender) => !!win && !win.isDestroyed() && win.webContents === sender,
  });

  return { open, openDialog, registerIpc, closeAll: documents.closeAll, served: documents.served, getWindow: () => win };
}

module.exports = { createWorkspace };

// SPDX-License-Identifier: AGPL-3.0-or-later
// The PDF workspace: a window that reads PDFs, one tab for each. The rest of the app uses only this file. The window code is loaded the first time a
// PDF is opened, so a Pomelo that never opens one pays nothing for it.
const os = require('os');
const path = require('path');
const { createDocuments, sweepSessions } = require('./documents');
const { linkTarget } = require('./links');
const { addRecent, startFolder } = require('./recent');
const { cleanView } = require('./view');
const { registerWorkspaceIpc } = require('./workspace.ipc');

const WINDOWS_11 = 22621;
const DOCKS = ['bottom', 'top', 'left', 'right'];
const MAX_COPIED = 100000;
const MAX_TABS = 10;

const WHY_NOT_SAVED = {
  locked: ({ name }) => `${name} is open in another program. Close it there, or save a copy.`,
  'read-only': ({ name }) => `${name} is read-only. Save a copy instead.`,
  'no-space': ({ name, drive }) => `There is not enough free space on ${drive} to save ${name}.`,
  'too-large': () => 'Saving changes to a file this large needs the PDF engine.',
};

const REASONS = {
  ENOENT: 'The file is no longer there.', ENOTFILE: 'This is not a file.',
  EACCES: "Windows won't let Pomelo read this file.", EPERM: "Windows won't let Pomelo read this file.", EBUSY: "Windows won't let Pomelo read this file.",
};

// asset(name): path of a file shipped in assets/. getSettings(), setSettings(patch): the stored settings. notify({ title, detail }): the
// notice in the corner of the screen. log(...). openExternal(url): open an address with the program Windows has for it, as a promise.
// copyText(text): put text on the clipboard. uniquePath(dir, base, ext): a path that does not exist yet. runPdfTool(script, args, { src, signal, secrets }): run a
// PDF editing helper with the PDF engine. showInFolder(file): show a file in Explorer. solid: draw an opaque window; by default only before Windows 11.
function createWorkspace({ asset, getSettings, setSettings, notify, log, openExternal, copyText, uniquePath, runPdfTool, showInFolder, solid = Number(os.release().split('.')[2]) < WINDOWS_11 }) {
  const documents = createDocuments({ runPdfTool });
  let win = null;
  let queue = Promise.resolve();
  let leaving = false;

  const setView = (patch) => setSettings({ pdfView: { ...getSettings().pdfView, ...patch } });
  const dock = () => { const side = getSettings().pdfView?.dock; return DOCKS.includes(side) ? side : 'bottom'; };

  // Writes only what is valid and what differs from what is stored, so a page that repeats itself does not rewrite the file.
  function rememberView(patch) {
    const stored = cleanView(getSettings().pdfView);
    const changed = Object.entries(cleanView(patch)).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(stored[key]));
    if (changed.length) setView(Object.fromEntries(changed));
  }

  const focus = () => { if (win.isMinimized()) win.restore(); win.show(); win.focus(); };

  // Opens each PDF as a tab, in the open window or in a new one, and brings the window to the front. Calls are served one at a time,
  // so the files of one Explorer selection do not overtake each other. A file that is open already is shown, not opened twice.
  function open(paths) {
    const turn = queue.then(() => add(paths));
    queue = turn.catch(() => {});
    return turn;
  }

  async function add(paths) {
    const shown = [];
    let refusal = null;
    for (const file of paths) {
      const known = documents.find(file);
      if (known) { shown.push(known); continue; }
      if (documents.list().length >= MAX_TABS) { refusal = { title: 'Too many PDFs open', detail: 'Close one to open another.' }; break; }
      try {
        shown.push(await documents.open(file));
        setSettings({ pdfRecent: addRecent(getSettings().pdfRecent, path.resolve(file)) });
      } catch (e) {
        log('cannot open PDF:', path.basename(file), e.code || e.message);
        refusal ??= { title: "Can't open this file", detail: REASONS[e.code] || 'The file could not be read.' };
      }
    }
    if (refusal) notify(refusal);
    if (win && !win.isDestroyed()) {
      if (shown.length) win.webContents.send('pdfws:opened', shown);
      focus();
    } else if (shown.length) {
      win = require('./workspace.window').create({
        asset, solid, saved: getSettings().pdfView?.window,
        onBounds: (bounds) => setView({ window: bounds }),
      });
      // The page asks about each document with changes before it lets the window go.
      win.on('close', (e) => {
        if (leaving || !documents.list().some((d) => d.dirty)) return;
        e.preventDefault();
        win.webContents.send('pdfws:closing');
      });
      win.on('closed', () => { win = null; leaving = false; documents.closeAll(); });
    }
  }

  async function openDialog() {
    await open(await require('./workspace.window').choosePdf(win && !win.isDestroyed() ? win : null, startFolder(getSettings().pdfRecent)));
  }

  function openDropped(paths) {
    if (!Array.isArray(paths)) return;
    const pdfs = paths.filter((file) => typeof file === 'string' && path.isAbsolute(file) && path.extname(file).toLowerCase() === '.pdf');
    if (pdfs.length) open(pdfs);
    else notify({ title: 'PDF files only', detail: 'Drop a PDF to open it.' });
  }

  function closeDocument(token) {
    documents.close(token);
    if (!documents.list().length) win?.close();
  }

  // Tells the page a document's new state (`reload`: its pages must be read again; a result can say it itself), and when a save stopped says
  // why, once, in the corner of the screen and gives the page only the reason.
  async function revised(pending, reload) {
    const result = await pending;
    if (!result) return null;
    if (result.info) { win?.webContents.send('pdfws:changed', { ...result.info, reload: result.reload ?? reload }); return result; }
    const why = WHY_NOT_SAVED[result.stop]?.(result);
    if (why) notify({ title: "Can't save", detail: why });
    return { stop: result.stop };
  }

  // A helper that failed says why in the corner of the screen, in its own one line; a file system error would name a temp path, so it
  // gets a fixed sentence. A missing engine and a stop are the page's to explain, so it gets only the reason.
  function applyFailed(e) {
    if (e.code === 'NO_ENGINE') return { stop: 'no-engine' };
    if (e.name === 'CancelledError') return { stop: 'cancelled' };
    log('PDF change failed:', e.code || e.message);
    notify({ title: "Can't make this change", detail: e.code ? 'The new version could not be written.' : e.message });
    return { stop: 'failed' };
  }

  // What the PDF engine knows about the document, or { stop } with 'no-engine' or 'failed'. A helper that failed is only logged: the panel
  // simply shows less.
  async function properties(token) {
    try {
      return { facts: await documents.facts(token) };
    } catch (e) {
      if (e.code === 'NO_ENGINE') return { stop: 'no-engine' };
      log('PDF details failed:', e.code || e.message);
      return { stop: 'failed' };
    }
  }

  async function saveAs(token) {
    const file = documents.fileOf(token);
    const suggested = uniquePath(path.dirname(file), `${path.basename(file, path.extname(file))} (edited)`, 'pdf');
    const target = await require('./workspace.window').chooseSavePath(win, suggested);
    if (!target) return { stop: 'cancelled' };
    const same = path.resolve(target).toLowerCase() === path.resolve(file).toLowerCase();
    return revised(same ? documents.save(token) : documents.saveCopy(token, target), false);
  }

  function openLink(url) {
    const target = linkTarget(url);
    if (target) openExternal(target).catch(() => notify({ title: "Can't open this link", detail: 'Windows has nothing to open it with.' }));
  }

  function copyLink(url) {
    const target = linkTarget(url);
    if (target) copyText(target);
  }

  // Copies the addresses `linkTarget` accepts, each once, one to a line. Answers how many there were.
  function copyLinks(urls) {
    if (!Array.isArray(urls) || urls.length > MAX_COPIED) return 0;
    const targets = [...new Set(urls.map((url) => linkTarget(url)).filter(Boolean))];
    if (targets.length) copyText(targets.join('\n'));
    return targets.length;
  }

  const registerIpc = () => registerWorkspaceIpc({
    documents,
    state: () => ({ documents: documents.list(), dock: dock(), view: cleanView(getSettings().pdfView) }),
    closeDocument,
    openDropped,
    putRevision: (token, bytes) => revised(documents.putRevision(token, bytes), false),
    apply: (token, ops) => revised(documents.apply(token, ops).catch(applyFailed), true),
    properties,
    details: documents.details,
    rename: (token, name) => revised(documents.rename(token, name), false),
    showInFolder: (token) => showInFolder(documents.fileOf(token)),
    undo: (token) => revised(documents.undo(token), true),
    redo: (token) => revised(documents.redo(token), true),
    save: (token) => revised(documents.save(token), false),
    saveAs,
    reload: (token) => revised(documents.reload(token), true),
    closeWindow: () => { leaving = true; win?.close(); },
    setFocus: (on) => win?.setFullScreen(on),
    setDock: (side) => { if (DOCKS.includes(side)) setView({ dock: side }); },
    setView: rememberView,
    checkLink: linkTarget,
    openLink,
    copyLink,
    copyLinks,
    isWorkspace: (sender) => !!win && !win.isDestroyed() && win.webContents === sender,
  });

  return { open, openDialog, registerIpc, sweepSessions, closeAll: documents.closeAll, served: documents.served, getWindow: () => win };
}

module.exports = { createWorkspace };

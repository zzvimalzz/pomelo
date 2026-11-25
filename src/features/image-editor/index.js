// SPDX-License-Identifier: AGPL-3.0-or-later
// The image editor: a window that shows pictures, one tab for each. The rest of the app uses only this file. The window code is loaded
// the first time a picture is opened, so a Pomelo that never opens one pays nothing for it.
const path = require('path');
const { createImages } = require('./images');
const { MAX_TABS, PIECE, editable } = require('./limits');
const { cleanView } = require('./view');
const { createSave } = require('./save');
const { registerEditorIpc } = require('./editor.ipc');

const REASONS = {
  ENOENT: 'The file is no longer there.', ENOTFILE: 'This is not a file.',
  EACCES: "Windows won't let Pomelo read this file.", EPERM: "Windows won't let Pomelo read this file.", EBUSY: "Windows won't let Pomelo read this file.",
};

const REFUSALS = {
  TOO_LARGE: { title: 'This image is too large to edit', detail: 'Pomelo edits images up to 50 megapixels.' },
  ANIMATED: { title: "Can't edit an animated image", detail: 'Pomelo edits still images.' },
};

// asset(name): path of a file shipped in assets/. getSettings(), setSettings(patch): the stored settings. notify({ title, detail }): the
// notice in the corner of the screen. log(...). readImage(file, { maxPixels, maxEdge }): decode a picture to upright RGBA. showInFolder(file):
// show a file in Explorer. writeImage(rgba, out, format, options) and uniquePath(dir, base, ext): the conversion feature's. qualities: its
// default quality for each format that has one. extOf(file): the format a file name stands for, with spellings like .jpeg folded in.
// solid: draw an opaque window; by default only before Windows 11. chooseSavePath(suggested, format): where a copy goes, or null; by
// default the Save dialog on the editor window.
function createEditor({ asset, getSettings, setSettings, notify, log, readImage, writeImage, uniquePath, qualities, showInFolder, extOf, solid, chooseSavePath }) {
  const images = createImages({ readImage, extOf });
  const canEdit = (file) => editable(extOf(file));
  let win = null;
  let queue = Promise.resolve();
  let leaving = false;
  const saver = createSave({
    images, writeImage, uniquePath, notify, log,
    show: async (file) => { await open([file]); return !!images.find(file); },
    chooseSavePath: chooseSavePath ?? ((suggested, format) => require('./editor.window').chooseSavePath(win, suggested, format)),
  });

  // Writes only what is valid and what differs from what is stored, so a page that repeats itself does not rewrite the file.
  function rememberView(patch) {
    const stored = cleanView(getSettings().imageView);
    const changed = Object.entries(cleanView(patch)).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(stored[key]));
    if (changed.length) setSettings({ imageView: { ...getSettings().imageView, ...Object.fromEntries(changed) } });
  }

  const focus = () => { if (win.isMinimized()) win.restore(); win.show(); win.focus(); };

  // Opens each picture as a tab, in the open window or in a new one, and brings the window to the front. Calls are served one at a time,
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
      const known = images.find(file);
      if (known) { shown.push(known); continue; }
      if (images.list().length >= MAX_TABS) { refusal = { title: 'Too many images open', detail: 'Close one to open another.' }; break; }
      try {
        shown.push(await images.open(file));
      } catch (e) {
        log('cannot open image:', path.basename(file), e.code || e.message);
        refusal ??= REFUSALS[e.code] || { title: "Can't open this image", detail: REASONS[e.code] || 'The file could not be read.' };
      }
    }
    if (refusal) notify(refusal);
    if (win && !win.isDestroyed()) {
      if (shown.length) win.webContents.send('imged:opened', shown);
      focus();
    } else if (shown.length) {
      win = require('./editor.window').create({
        asset, solid, saved: getSettings().imageView?.window,
        onBounds: (bounds) => setSettings({ imageView: { ...getSettings().imageView, window: bounds } }),
      });
      // The page asks about each picture with changes before it lets the window go.
      win.on('close', (e) => {
        if (leaving || !images.anyDirty()) return;
        e.preventDefault();
        win.webContents.send('imged:closing');
      });
      win.on('closed', () => { win = null; leaving = false; images.closeAll(); });
    }
  }

  function openDropped(paths) {
    if (!Array.isArray(paths)) return;
    const pictures = paths.filter((file) => typeof file === 'string' && path.isAbsolute(file) && canEdit(file));
    if (pictures.length) open(pictures);
    else notify({ title: 'Images only', detail: 'Drop an image to edit it.' });
  }

  function closeImage(token) {
    images.close(token);
    if (!images.list().length) win?.close();
  }

  const registerIpc = () => registerEditorIpc({
    images,
    state: () => ({ images: images.list(), view: cleanView(getSettings().imageView), piece: PIECE, quality: qualities }),
    closeImage,
    openDropped,
    showInFolder: (token) => showInFolder(images.fileOf(token)),
    setView: rememberView,
    setFullScreen: (on) => win?.setFullScreen(on),
    save: saver.save,
    setDirty: (token, dirty) => images.setDirty(token, dirty === true),
    closeWindow: () => { leaving = true; win?.close(); },
    isEditor: (sender) => !!win && !win.isDestroyed() && win.webContents === sender,
  });

  return { open, registerIpc, editable: canEdit, closeAll: images.closeAll };
}

module.exports = { createEditor };

// SPDX-License-Identifier: AGPL-3.0-or-later
// The image editor: a window that shows pictures, one tab for each. The rest of the app uses only this file. The window code is loaded
// the first time a picture is opened, so a Pomelo that never opens one pays nothing for it.
const path = require('path');
const { createImages } = require('./images');
const { MAX_TABS, PIECE, editable } = require('./limits');
const { cleanView } = require('./view');
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
// show a file in Explorer. extOf(file): the format a file name stands for, with spellings like .jpeg folded in. solid: draw an opaque
// window; by default only before Windows 11.
function createEditor({ asset, getSettings, setSettings, notify, log, readImage, showInFolder, extOf, solid }) {
  const images = createImages({ readImage });
  const canEdit = (file) => editable(extOf(file));
  let win = null;
  let queue = Promise.resolve();

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
      win.on('closed', () => { win = null; images.closeAll(); });
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
    state: () => ({ images: images.list(), view: cleanView(getSettings().imageView), piece: PIECE }),
    closeImage,
    openDropped,
    showInFolder: (token) => showInFolder(images.fileOf(token)),
    setView: rememberView,
    setFullScreen: (on) => win?.setFullScreen(on),
    closeWindow: () => win?.close(),
    isEditor: (sender) => !!win && !win.isDestroyed() && win.webContents === sender,
  });

  return { open, registerIpc, editable: canEdit, closeAll: images.closeAll };
}

module.exports = { createEditor };

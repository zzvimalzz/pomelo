// SPDX-License-Identifier: AGPL-3.0-or-later
// The editor window: the shared app window with the editor's page and preload, the full-screen events its page listens for, and the
// Save a copy dialog.
const path = require('path');
const { dialog } = require('electron');
const { createAppWindow } = require('#shared/electron/windows');

// asset(name): path of a file shipped in assets/. solid: draw an opaque window. saved: the stored place of the window.
// onBounds({ x, y, width, height, maximised, savedAt }): called, after a pause, whenever the user moved or resized it.
function create({ asset, solid, saved, onBounds }) {
  const win = createAppWindow({
    asset, solid, saved, onBounds, partition: 'pomelo-editor',
    preload: path.join(__dirname, 'ui', 'preload.js'), page: path.join(__dirname, 'ui', 'editor.html'),
  });
  for (const [event, on] of [['enter-full-screen', true], ['leave-full-screen', false]]) win.on(event, () => win.webContents.send('imged:full-screen-changed', on));
  return win;
}

const FILTERS = { jpg: ['jpg', 'jpeg'], tiff: ['tiff', 'tif'] };

async function chooseSavePath(parent, file, format) {
  const picked = await dialog.showSaveDialog(parent, { title: 'Save a copy', defaultPath: file, filters: [{ name: `${format.toUpperCase()} files`, extensions: FILTERS[format] ?? [format] }] });
  return picked.canceled ? null : picked.filePath;
}

module.exports = { create, chooseSavePath };

// SPDX-License-Identifier: AGPL-3.0-or-later
// The workspace window: the shared app window with the workspace's page and preload, and the full-screen events its page listens for,
// plus the Open and Save a copy dialogs.
const path = require('path');
const { dialog } = require('electron');
const { createAppWindow } = require('#shared/electron/windows');
const { PICTURE_EXTENSIONS } = require('./ops');

// asset(name): path of a file shipped in assets/. solid: draw an opaque window. saved: the stored place of the window.
// onBounds({ x, y, width, height, maximised, savedAt }): called, after a pause, whenever the user moved or resized it.
function create({ asset, solid, saved, onBounds }) {
  const win = createAppWindow({
    asset, solid, saved, onBounds, partition: 'pomelo-workspace',
    preload: path.join(__dirname, 'ui', 'preload.js'), page: path.join(__dirname, 'ui', 'workspace.html'),
  });
  for (const [event, on] of [['enter-full-screen', true], ['leave-full-screen', false]]) win.on(event, () => win.webContents.send('pdfws:focus-changed', on));
  return win;
}

// folder: where the dialog starts, or undefined to leave it to Windows.
async function choosePdf(parent, folder) {
  const options = { title: 'Open a PDF', defaultPath: folder, properties: ['openFile', 'multiSelections'], filters: [{ name: 'PDF files', extensions: ['pdf'] }] };
  const picked = await (parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options));
  return picked.canceled ? [] : picked.filePaths;
}

// One PDF ('pdf'), any number of PDFs ('pdfs') or any number of pictures ('image') to put among the pages or combine with the document.
async function chooseInsert(parent, kind, folder) {
  const pictures = kind === 'image';
  const options = {
    title: pictures ? 'Insert pictures' : kind === 'pdfs' ? 'Add files' : 'Insert pages from a PDF', defaultPath: folder, properties: kind === 'pdf' ? ['openFile'] : ['openFile', 'multiSelections'],
    filters: [pictures ? { name: 'Pictures', extensions: PICTURE_EXTENSIONS } : { name: 'PDF files', extensions: ['pdf'] }],
  };
  const picked = await dialog.showOpenDialog(parent, options);
  return picked.canceled ? [] : picked.filePaths;
}

async function chooseSavePath(parent, file, title = 'Save a copy') {
  const picked = await dialog.showSaveDialog(parent, { title, defaultPath: file, filters: [{ name: 'PDF files', extensions: ['pdf'] }] });
  return picked.canceled ? null : picked.filePath;
}

module.exports = { create, choosePdf, chooseInsert, chooseSavePath };

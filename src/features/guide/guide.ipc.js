// SPDX-License-Identifier: AGPL-3.0-or-later
// The guide page's messages to the main process. The preload (ui/preload.js) sends the same channel names.
const { ipcMain, shell, BrowserWindow } = require('electron');
const { fit } = require('./guide.window');

const WEBSITE = 'https://pomelo.swymble.com';
const SAMPLES = ['Report.docx', 'Budget.xlsx', 'Photo.png'];       // the files the animation converts, one after the other

// describe(name): what the app knows of a sample file, as { ext, group, targets: [{ ext, label, sub, group }] } (the formats it can become).
function registerGuideIpc({ describe }) {
  ipcMain.handle('guide:data', () => ({ samples: SAMPLES.map((name) => ({ name, ...describe(name) })).filter((s) => s.targets.length) }));
  ipcMain.on('guide:fit', (e, height) => fit(e.sender, Number(height)));
  ipcMain.on('guide:website', () => { shell.openExternal(WEBSITE); });
  ipcMain.on('guide:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());
}

module.exports = { registerGuideIpc };

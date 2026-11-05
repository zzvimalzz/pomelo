// SPDX-License-Identifier: AGPL-3.0-or-later
// The Settings page's messages to the main process. The preload (ui/preload.js) sends the same channel names.
const { ipcMain, clipboard, shell, dialog, BrowserWindow } = require('electron');
const { fit } = require('./settings.window');

// store: the settings store. getState(): the rest of what the page shows ({ engines, installing, version, os, update, updated }),
// which belongs to other parts of the app. onChange(patch): settings were changed from the page. logPath(): the debug log.
// onOpenGuide(): the "?" button was pressed.
function registerSettingsIpc({ store, getState, onChange, logPath, onOpenGuide }) {
  ipcMain.handle('settings:get', () => ({ settings: store.get(), ...getState() }));
  // A folder is only ever stored from the dialog below (or cleared with ''), so a page cannot make Pomelo write somewhere it picked.
  ipcMain.handle('settings:set', (_e, patch) => {
    const { outputDir, ...rest } = patch;
    const safe = outputDir === '' ? { ...rest, outputDir } : rest;
    store.set(safe);
    onChange(safe);
    return store.get();
  });
  ipcMain.handle('settings:choose-output', async (e) => {
    const picked = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
      title: 'Save conversions to', defaultPath: store.get().outputDir || undefined, properties: ['openDirectory', 'createDirectory'],
    });
    if (!picked.canceled && picked.filePaths[0]) { store.set({ outputDir: picked.filePaths[0] }); onChange({ outputDir: picked.filePaths[0] }); }
    return store.get();
  });
  ipcMain.on('settings:fit', (e, height) => fit(e.sender, height));
  ipcMain.on('settings:open-guide', () => onOpenGuide());
  ipcMain.on('app:copy', (_e, text) => clipboard.writeText(String(text)));
  ipcMain.on('app:open-logs', () => shell.showItemInFolder(logPath()));
}

module.exports = { registerSettingsIpc };

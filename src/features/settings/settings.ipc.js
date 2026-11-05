// SPDX-License-Identifier: AGPL-3.0-or-later
// The Settings page's messages to the main process. The preload (ui/preload.js) sends the same channel names.
const { ipcMain, clipboard, shell } = require('electron');
const { fit } = require('./settings.window');

// store: the settings store. getState(): the rest of what the page shows ({ engines, installing, version, os, update }),
// which belongs to other parts of the app. onChange(patch): settings were changed from the page. logPath(): the debug log.
function registerSettingsIpc({ store, getState, onChange, logPath }) {
  ipcMain.handle('settings:get', () => ({ settings: store.get(), ...getState() }));
  ipcMain.handle('settings:set', (_e, patch) => { store.set(patch); onChange(patch); return store.get(); });
  ipcMain.on('settings:fit', (e, height) => fit(e.sender, height));
  ipcMain.on('app:copy', (_e, text) => clipboard.writeText(String(text)));
  ipcMain.on('app:open-logs', () => shell.showItemInFolder(logPath()));
}

module.exports = { registerSettingsIpc };

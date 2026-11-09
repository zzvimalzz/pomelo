// SPDX-License-Identifier: AGPL-3.0-or-later
// The Settings page's messages to the main process. The preload (ui/preload.js) sends the same channel names.
const { ipcMain, clipboard, shell, dialog, BrowserWindow } = require('electron');

const WEBSITE = 'https://pomelo.swymble.com';
const SAMPLES = ['Report.docx', 'Budget.xlsx', 'Photo.png'];       // the files the animation on the Help page converts, one after the other

// What a page may change, and the values it may give. A folder is only ever stored from the dialog below (or cleared with ''), so a page
// cannot make Pomelo write somewhere it picked; the update checker's own keys are not the page's to set.
const isBool = (v) => typeof v === 'boolean';
const SETTABLE = { enabled: isBool, openAtLogin: isBool, autoUpdate: isBool, theme: (v) => ['system', 'light', 'dark'].includes(v), outputDir: (v) => v === '' };

// store: the settings store. getState(): the rest of what the page shows ({ engines, installing, version, os, update, updated }),
// which belongs to other parts of the app. onChange(patch): settings were changed from the page. logPath(): the debug log.
// describe(name): what the app knows of a sample file, as { ext, group, targets: [{ ext, label, sub, group }] } (the formats it can become).
function registerSettingsIpc({ store, getState, onChange, logPath, describe }) {
  ipcMain.handle('settings:get', () => ({ settings: store.get(), ...getState() }));
  ipcMain.handle('settings:set', (_e, patch) => {
    const safe = Object.fromEntries(Object.entries(patch && typeof patch === 'object' ? patch : {}).filter(([key, value]) => Object.hasOwn(SETTABLE, key) && SETTABLE[key](value)));
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
  ipcMain.handle('settings:samples', () => ({ samples: SAMPLES.map((name) => ({ name, ...describe(name) })).filter((s) => s.targets.length) }));
  ipcMain.on('settings:website', () => { shell.openExternal(WEBSITE); });
  ipcMain.on('app:copy', (_e, text) => clipboard.writeText(String(text)));
  ipcMain.on('app:open-logs', () => shell.showItemInFolder(logPath()));
}

module.exports = { registerSettingsIpc };

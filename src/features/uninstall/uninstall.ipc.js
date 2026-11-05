// SPDX-License-Identifier: AGPL-3.0-or-later
// The Settings page's Uninstall button: confirm, then hand over to the Windows uninstaller (or, from source, remove the engines).
const fs = require('fs');
const path = require('path');
const { ipcMain, dialog } = require('electron');
const { plan, confirmText, uninstall } = require('./uninstall');

// installer: the engine installer (its uninstall() and installed()). getWindow(): the Settings window, or null.
// setLoginItem(bool). removeShellMenu(): removes the right-click entries (used when there is no Windows uninstaller to do it).
// isPackaged, execPath: where the running Pomelo is, to find unins000.exe next to it. quit(). log(...).
function registerUninstallIpc({ installer, getWindow, setLoginItem, removeShellMenu, isPackaged, execPath, quit, log }) {
  ipcMain.handle('app:uninstall', async () => {
    const win = getWindow();
    const what = plan(installer);
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning', title: 'Uninstall Pomelo', message: 'Uninstall Pomelo?', detail: confirmText(what),
      buttons: ['Uninstall', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
    });
    if (response !== 0) return { ok: false };
    log('uninstalling', what.engines);
    const tell = (note) => win?.webContents.send('engines:progress', { keys: [], note });
    const unins = isPackaged && path.join(path.dirname(execPath), 'unins000.exe');
    const done = await uninstall({ installer, uninstaller: unins && fs.existsSync(unins) ? unins : null, setLoginItem, removeShellMenu, note: tell });
    if (!done.launched && done.engines.failed.length) {              // from source: no Windows uninstaller to report it
      await dialog.showMessageBox(win, { type: 'info', title: 'Uninstall Pomelo', message: 'The engines are removed, with one exception',
        detail: `These could not be removed automatically: ${done.engines.failed.join(', ')}.\nDelete the folder %LOCALAPPDATA%\\Pomelo\\engines, or use Windows Settings > Apps for Pandoc and Python.`, buttons: ['OK'] });
    }
    quit();                                                           // the Windows uninstaller carries on by itself
    return { ok: true };
  });
}

module.exports = { registerUninstallIpc };

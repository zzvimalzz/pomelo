// SPDX-License-Identifier: AGPL-3.0-or-later
// The Settings window's update buttons: check, open the download page, or download and install in place.
const { ipcMain, shell } = require('electron');
const { check, openDownload, downloadRules } = require('./check');
const { download, launch } = require('./install');

// deps:
//   current            the running version
//   autoCheck          the AutoUpdate object: .available is what the last check found, .remember(result) stores a new one
//   onChecked()        the update state changed (the tray tooltip follows it)
//   isPackaged, execPath   where the running Pomelo is, so the installer can start it again
//   sendToSettings(channel, payload)   send to the Settings window if it is open
//   stopForUpdate()    stop the helpers and child processes before the installer takes over
//   exit(code)         quit now; will-quit does not run on exit(), which is why stopForUpdate exists
//   log(...)
function registerUpdatesIpc({ current, autoCheck, onChecked, isPackaged, execPath, sendToSettings, stopForUpdate, exit, log }) {
  ipcMain.handle('updates:check', async () => {
    const result = await check({ current });
    autoCheck.remember(result);
    onChecked();
    return result;
  });
  ipcMain.handle('updates:download', (_e, url) => openDownload(url, (u) => shell.openExternal(u)));

  // "Download update": fetch the installer inside Pomelo, check it against the release's checksum, run it quietly and come
  // back. What to download comes from the check Pomelo itself made, never from the Settings window.
  let updating = false;
  ipcMain.handle('updates:install', async () => {
    const found = autoCheck.available;
    if (!found) return { ok: false, message: 'Check for updates first' };
    if (!isPackaged) return { ok: false, message: 'Updating in place only works in the installed app', fallback: true };
    if (!found.installable) return { ok: false, message: 'This release cannot be installed from here', fallback: true };
    if (updating) return { ok: false, message: 'The update is already downloading' };
    updating = true;
    const startedAt = Date.now();
    try {
      log('update: downloading', found.latest);
      const file = await download({
        url: found.url, sha256: found.sha256, size: found.size, rules: downloadRules(),
        onProgress: ({ received, total, fraction }) => {
          const secs = (Date.now() - startedAt) / 1000;
          const left = fraction > 0.02 && secs > 1 ? Math.round(secs * (1 - fraction) / fraction) : null;
          sendToSettings('updates:progress', { phase: 'download', received, total, fraction, left });
        },
      });
      sendToSettings('updates:progress', { phase: 'install' });
      log('update: installing', found.latest);
      launch(file, execPath, { version: found.latest });
      setTimeout(() => exit(0), 400);          // out of the installer's way
      stopForUpdate();
      return { ok: true };
    } catch (e) {
      updating = false;
      log('update failed:', e.message);
      return { ok: false, message: e.message, fallback: true };
    }
  });
}

module.exports = { registerUpdatesIpc };

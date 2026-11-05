// SPDX-License-Identifier: AGPL-3.0-or-later
// The update buttons of the Settings window and the Pomelo Downloader window: check, open the download page, or download
// and install in place.
const { ipcMain, shell } = require('electron');
const { check, openDownload, downloadRules } = require('./check');
const { download, launch } = require('./install');

// deps:
//   current            the running version
//   autoCheck          the AutoUpdate object: .available is what the last check found, .remember(result) stores a new one
//   onChecked()        the update state changed (the tray tooltip follows it)
//   isPackaged, execPath   where the running Pomelo is, so the installer can start it again
//   sendToSettings(channel, payload)   send to the Settings window if it is open
//   isSettingsOpen()   Settings is open now, so it should be open again after the restart
//   downloader         the Downloader window (downloader.window.js)
//   stopForUpdate()    stop the helpers and child processes before the installer takes over
//   exit(code)         quit now; will-quit does not run on exit(), which is why stopForUpdate exists
//   log(...)
function registerUpdatesIpc({ current, autoCheck, onChecked, isPackaged, execPath, sendToSettings, isSettingsOpen, downloader, stopForUpdate, exit, log }) {
  ipcMain.handle('updates:check', async () => {
    const result = await check({ current });
    autoCheck.remember(result);
    onChecked();
    return result;
  });
  ipcMain.handle('updates:download', (_e, url) => openDownload(url, (u) => shell.openExternal(u)));

  // "Download update": fetch the installer inside Pomelo, check it against the release's checksum, run it quietly and come
  // back. What to download comes from the check Pomelo itself made, never from a page.
  let running = null;                          // the AbortController of the update in progress
  ipcMain.handle('updates:install', async () => {
    const found = autoCheck.available;
    if (!found) return { ok: false, message: 'Check for updates first' };
    if (!isPackaged) return { ok: false, message: 'Updating in place only works in the installed app', fallback: true };
    if (!found.installable) return { ok: false, message: 'This release cannot be installed from here', fallback: true };
    if (running) { downloader.show(); return { ok: true }; }       // pressed again (Settings was reopened): show where it is
    running = new AbortController();
    const startedAt = Date.now();
    let lastSent = 0;
    // Settings follows the download and the hand-over; the Downloader window follows everything, errors included.
    const tell = (progress) => {
      const state = { current, latest: found.latest, ...progress };
      downloader.update(state);
      if (progress.phase === 'download' || progress.phase === 'install') sendToSettings('updates:progress', state);
    };
    downloader.show();
    tell({ phase: 'download', fraction: 0 });
    try {
      log('update: downloading', found.latest);
      const file = await download({
        url: found.url, sha256: found.sha256, size: found.size, rules: downloadRules(), signal: running.signal,
        onProgress: ({ received, total, fraction }) => {
          const now = Date.now();
          if (now - lastSent < 100 && fraction < 1) return;          // the stream reports every chunk; the windows need ten a second
          lastSent = now;
          const secs = (now - startedAt) / 1000;
          const left = fraction > 0.02 && secs > 1 ? Math.round(secs * (1 - fraction) / fraction) : null;
          tell({ phase: 'download', received, total, fraction, left });
        },
      });
      tell({ phase: 'install' });
      log('update: installing', found.latest);
      launch(file, execPath, { version: found.latest, reopen: isSettingsOpen() });
      setTimeout(() => exit(0), 1500);         // long enough to read "Installing", and out of the installer's way
      stopForUpdate();
      return { ok: true };
    } catch (e) {
      const cancelled = e.name === 'AbortError';
      running = null;
      log(cancelled ? 'update: cancelled' : `update failed: ${e.message}`);
      if (cancelled) downloader.close(); else tell({ phase: 'error', message: e.message });
      return { ok: false, cancelled, message: e.message, fallback: !cancelled };
    }
  });

  ipcMain.on('updates:cancel', () => running?.abort());
  ipcMain.on('updates:close', () => downloader.close());
  ipcMain.on('updates:ready', () => downloader.ready());
}

module.exports = { registerUpdatesIpc };

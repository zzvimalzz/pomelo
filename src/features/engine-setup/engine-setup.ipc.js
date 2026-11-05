// SPDX-License-Identifier: AGPL-3.0-or-later
// The Settings page's Install buttons.
const { ipcMain } = require('electron');
const { PACKS, PACK } = require('./packs');

// installer: createInstaller(). getEngines(): the engines map. sendToSettings(channel, payload): send to the Settings window if
// it is open. log(...).
// -> { getInstalling } : { keys, note } while an install is working, else null (the page asks for it when it opens).
function registerEngineSetupIpc({ installer, getEngines, sendToSettings, log }) {
  let installing = null;
  ipcMain.handle('engines:install', async (_e, key) => {
    if (!PACK[key]) return { ok: false, message: 'Unknown engine' };
    if (installing) return { ok: false, message: 'Another engine is still installing' };
    const tell = () => sendToSettings('engines:progress', installing);
    installing = { keys: PACKS[PACK[key]].keys, note: 'Starting…' };
    tell();
    const result = await installer.install(key, (note) => { if (installing) { installing.note = note; tell(); } });
    installing = null;
    log('engine install', key, result.ok ? 'ok' : `failed: ${result.message}`);
    return { ok: result.ok, message: result.message, engines: getEngines() };
  });
  return { getInstalling: () => installing };
}

module.exports = { registerEngineSetupIpc };

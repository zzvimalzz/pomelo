// SPDX-License-Identifier: AGPL-3.0-or-later
// The Settings page's Install buttons, and the same install for the rest of the app (after an update adds an engine).
const { ipcMain } = require('electron');
const { PACKS, PACK } = require('./packs');

// installer: createInstaller(). getEngines(): the engines map. sendToSettings(channel, payload): send to the Settings window if
// it is open. log(...).
// -> { getInstalling, run }. getInstalling(): { keys, note } while an install is working, else null (the page asks for it when it
// opens). run(key, onNote): install what `key` needs, with Settings following along, and give onNote(text, fraction) the progress.
function registerEngineSetupIpc({ installer, getEngines, sendToSettings, log }) {
  let installing = null;
  async function run(key, onNote = () => {}) {
    if (!PACK[key]) return { ok: false, message: 'Unknown engine' };
    if (installing) return { ok: false, message: 'Another engine is still installing' };
    const tell = () => sendToSettings('engines:progress', installing);
    installing = { keys: PACKS[PACK[key]].keys, note: 'Starting…' };
    tell();
    const result = await installer.install(key, (note, fraction) => { if (installing) { installing.note = note; tell(); } onNote(note, fraction); });
    installing = null;
    log('engine install', key, result.ok ? 'ok' : `failed: ${result.message}`);
    return { ok: result.ok, message: result.message, engines: getEngines() };
  }
  ipcMain.handle('engines:install', (_e, key) => run(key));
  return { getInstalling: () => installing, run };
}

module.exports = { registerEngineSetupIpc };

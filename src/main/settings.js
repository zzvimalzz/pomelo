// SPDX-License-Identifier: AGPL-3.0-or-later
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// autoUpdate is off by default: Pomelo goes online only when asked. lastUpdateCheck / updateNotified belong to autoUpdate.js.
const DEFAULTS = { enabled: true, key: 'ctrl', openAtLogin: true, advanced: false, pdfLayout: 'exact', autoUpdate: false, lastUpdateCheck: 0, updateNotified: '' };
let cache = null;

const file = () => path.join(app.getPath('userData'), 'settings.json');

function get() {
  if (!cache) {
    try { cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) }; } catch { cache = { ...DEFAULTS }; }
  }
  return cache;
}

function set(patch) {
  cache = { ...get(), ...patch };
  try { fs.mkdirSync(path.dirname(file()), { recursive: true }); fs.writeFileSync(file(), JSON.stringify(cache, null, 2)); } catch (e) { console.warn('settings not saved:', e.message); }
  return cache;
}

module.exports = { get, set };

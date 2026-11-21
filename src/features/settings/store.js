// SPDX-License-Identifier: AGPL-3.0-or-later
// Settings kept in a JSON file. No Electron in here: the app hands in the file's path.
const fs = require('fs');
const path = require('path');

// outputDir is the folder conversions are saved to, or '' for next to the original file. autoUpdate is off by default: Pomelo goes online only when asked. lastUpdateCheck / updateNotified belong to the update checker
// (features/updates/auto-check.js). pdfView belongs to the PDF window (features/pdf-workspace): where it was last, as { x, y, width, height, maximised, savedAt }, which the window forgets after 24 hours, and dock, the side of the document area the dock stands at.
const DEFAULTS = { enabled: true, outputDir: '', openAtLogin: true, advanced: false, theme: 'system', autoUpdate: false, lastUpdateCheck: 0, updateNotified: '', pdfView: { window: null, dock: 'bottom' } };

function createStore(file) {
  let cache = null;

  function get() {
    if (!cache) {
      try { cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { cache = { ...DEFAULTS }; }
    }
    return cache;
  }

  function set(patch) {
    cache = { ...get(), ...patch };
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(cache, null, 2)); } catch (e) { console.warn('settings not saved:', e.message); }
    return cache;
  }

  return { get, set };
}

module.exports = { createStore };

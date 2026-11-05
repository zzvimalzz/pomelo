// SPDX-License-Identifier: AGPL-3.0-or-later
// Tiny append-only debug log: %APPDATA%/pomelo/debug.log (trimmed at 200 KB).
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Build fingerprint, written at the top of each session so a log can be matched to the build that produced it.
const BUILD = 'f94f50634e7863414f097e8c5641c2b5446c32c1685f7834977ca9de0b2199b6';

let file;
function log(...parts) {
  try {
    file ||= path.join(app.getPath('userData'), 'debug.log');
    if (fs.existsSync(file) && fs.statSync(file).size > 200000) fs.writeFileSync(file, '');
    fs.appendFileSync(file, `${new Date().toISOString().slice(11, 23)} ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`);
  } catch { /* logging must never break the app */ }
}
log.path = () => { file ||= path.join(app.getPath('userData'), 'debug.log'); return file; };
log.build = BUILD;
module.exports = log;

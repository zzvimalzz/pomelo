// SPDX-License-Identifier: AGPL-3.0-or-later
// The PDFs opened lately, newest first, kept in the settings as full paths. The Open dialog starts in the folder of the newest one that
// is still there. The settings file may have been edited by hand, so whatever is read goes through cleanRecent.
const fs = require('fs');
const path = require('path');

const KEPT = 10;

const cleanRecent = (raw) => (Array.isArray(raw) ? raw.filter((p) => typeof p === 'string' && path.isAbsolute(p)).slice(0, KEPT) : []);

const addRecent = (raw, file) => [file, ...cleanRecent(raw).filter((p) => p.toLowerCase() !== file.toLowerCase())].slice(0, KEPT);

const startFolder = (raw) => cleanRecent(raw).map((p) => path.dirname(p)).find((dir) => fs.existsSync(dir));

module.exports = { addRecent, startFolder };

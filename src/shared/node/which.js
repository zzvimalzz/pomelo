// SPDX-License-Identifier: AGPL-3.0-or-later
// Finding an installed program.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { vendorRoots, enginesRoot } = require('./paths');

// The first match for `name` on PATH, or null.
function where(name) {
  try { return execFileSync('where', [name], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\n')[0].trim() || null; } catch { return null; }
}

// Looks in Pomelo's own folders first (vendor/ and the engines folder, which holds the LibreOffice that Pomelo unpacked), then
// the usual install spots and PATH.
function findExe(name, subdirs) {
  const roots = [...vendorRoots(), enginesRoot()];
  const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA, process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean);
  const candidates = [
    ...roots.flatMap((r) => subdirs.map((d) => path.join(r, d, name))),
    ...pf.flatMap((p) => subdirs.map((d) => path.join(p, d, name))),
  ];
  return candidates.find((c) => fs.existsSync(c)) || where(name);
}

module.exports = { where, findExe };

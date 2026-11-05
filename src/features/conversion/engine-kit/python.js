// SPDX-License-Identifier: AGPL-3.0-or-later
// Python helpers: finding a Python that has the packages an engine needs, and running one of Pomelo's scripts with it.
const fs = require('fs');
const { execFileSync } = require('child_process');
const { run } = require('./run');
const { pyenvPython, scriptPath, vendorRoots } = require('../../../shared/node/paths');

function pythons() {
  const envs = [pyenvPython(), ...vendorRoots().map((v) => pyenvPython(v))];   // the one Pomelo installs, then a developer's vendor/pyenv
  return [...envs.filter((p) => fs.existsSync(p)), 'python', 'py'];
}

// First Python that can import `modules` (a comma-separated list), or null.
function findPython(modules) {
  for (const py of pythons()) {
    try {
      execFileSync(py, ['-W', 'ignore', '-c', `import ${modules}`], { windowsHide: true, timeout: 30000, stdio: 'ignore' });
      return py;
    } catch { /* try the next one */ }
  }
  return null;
}

// Turns a script's output into a 0..1 progress figure: the scripts print "POMELO_PROGRESS 0.4" as they go.
function progressReader(onProgress) {
  if (!onProgress) return undefined;
  return (line) => {
    const own = /^POMELO_PROGRESS ([0-9.]+)/.exec(line);
    if (own) onProgress(Math.min(0.99, +own[1]));
  };
}

// A long PDF (or a scan, which is read page by page) needs longer than a short one: ten minutes, and two more for every ten pages.
function timeoutFor(src) {
  let pages = 1;
  try { pages = Math.max(1, Math.ceil(fs.statSync(src).size / 60000)); } catch { /* the script reports a missing file */ }
  return Math.min(4 * 3600 * 1000, 600000 + Math.ceil(pages / 10) * 120000);
}

// Runs python/<script> with `python`. The time limit comes from the size of `src`, unless `timeout` is given.
function runHelper(python, script, args, { src, onProgress, timeout } = {}) {
  return run(python, ['-W', 'ignore', scriptPath(script), ...args], { timeout: timeout ?? timeoutFor(src), onLine: progressReader(onProgress) });
}

module.exports = { findPython, runHelper, progressReader, timeoutFor };

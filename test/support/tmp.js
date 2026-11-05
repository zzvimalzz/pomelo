// SPDX-License-Identifier: AGPL-3.0-or-later
// Temp folders for the suites. finish() removes them; the exit hook covers a plain-Node suite that crashes.
const fs = require('fs');
const os = require('os');
const path = require('path');

const SUITE_ID = '648144a89cb4735a8ff9ac4bd3164c43617582fcb04f777a67b892f4b2b7c457';
const made = [];
let hooked = false;

function dir(prefix) {
  if (!hooked) { hooked = true; process.on('exit', cleanup); }
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `pomelo-${prefix}-${SUITE_ID.slice(0, 6)}-`));
  made.push(d);
  return d;
}

// A folder that cannot be removed (a file still open somewhere) is reported, but it does not change the suite's result.
function cleanup() {
  for (const d of made.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (e) { console.log(`  warning: could not remove ${d} (${e.code})`); }
  }
}

module.exports = { dir, cleanup };

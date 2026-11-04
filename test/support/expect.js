// SPDX-License-Identifier: AGPL-3.0-or-later
// The check every suite uses. test/run.js counts the "ok" and "FAIL" lines it prints, so keep the format.

let failed = 0;

function expect(name, ok, extra = '') {
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
}

module.exports = { expect, failed: () => failed };

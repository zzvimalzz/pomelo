// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs the classic scripts of a window's page under plain Node, in the order given, and returns the `window` they filled in. Only for
// scripts that touch nothing but `window`.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadPageScripts(...files) {
  const window = {};
  for (const file of files) vm.runInNewContext(fs.readFileSync(path.resolve(file), 'utf8'), { window, JSON, Array, Float32Array, Number, Math });
  return window;
}

module.exports = { loadPageScripts };

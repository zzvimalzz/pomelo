// SPDX-License-Identifier: AGPL-3.0-or-later
// Choosing and cleaning up the files a conversion writes.
const fs = require('fs');
const path = require('path');
const { currentContext } = require('./context');

// dir/base.ext, or dir/base (1).ext if that exists. Never overwrites. The path is noted in the conversion's context.
function uniquePath(dir, base, ext) {
  const dot = ext ? '.' + ext : '';
  let candidate = path.join(dir, base + dot);
  for (let n = 1; fs.existsSync(candidate); n++) candidate = path.join(dir, `${base} (${n})${dot}`);
  currentContext()?.outputs.push(candidate);
  return candidate;
}

// Engines that run another program check afterwards that it really wrote the file.
function assertProduced(out, who) {
  if (!fs.existsSync(out)) throw new Error(`${who} produced no output`);
}

// Delete paths a conversion chose but did not finish (files or folders).
function removeOutputs(paths) {
  for (const p of paths) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ } }
}

module.exports = { uniquePath, assertProduced, removeOutputs };

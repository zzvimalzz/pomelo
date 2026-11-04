// SPDX-License-Identifier: AGPL-3.0-or-later
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { killOnAbort, runCapture } = require('../../shared/node/process');

// Each conversion runs inside a context { signal, outputs }: a cancel signal that every helper process started
// during it listens to, and the list of output paths it has chosen so far (so a cancelled or failed attempt can
// delete what it left behind). It travels through async calls on its own, so engines need no extra parameters.
const context = new AsyncLocalStorage();
const withContext = (ctx, fn) => context.run(ctx, fn);
const currentContext = () => context.getStore();

class CancelledError extends Error {
  constructor() { super('Cancelled'); this.name = 'CancelledError'; }
}

// dir/base.ext, or dir/base (1).ext if that exists. Never overwrites.
function uniquePath(dir, base, ext) {
  const dot = ext ? '.' + ext : '';
  let candidate = path.join(dir, base + dot);
  for (let n = 1; fs.existsSync(candidate); n++) candidate = path.join(dir, `${base} (${n})${dot}`);
  context.getStore()?.outputs.push(candidate);
  return candidate;
}

// Kill `child` if the current conversion is cancelled. Returns a function that stops listening.
const killOnCancel = (child) => killOnAbort(child, context.getStore()?.signal);

// Delete paths a conversion chose but did not finish (files or folders).
function removeOutputs(paths) {
  for (const p of paths) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ } }
}

// Run a program inside the current conversion: resolves with its stdout, and cancelling the conversion kills it.
async function run(cmd, args, opts) {
  const signal = context.getStore()?.signal;
  try { return await runCapture(cmd, args, { ...opts, signal }); } catch (e) { throw signal?.aborted ? new CancelledError() : e; }
}

module.exports = { uniquePath, run, withContext, currentContext, killOnCancel, removeOutputs, CancelledError };

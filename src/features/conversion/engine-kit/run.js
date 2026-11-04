// SPDX-License-Identifier: AGPL-3.0-or-later
// Running a helper program inside a conversion.
const { currentContext, CancelledError } = require('./context');
const { runCapture } = require('../../../shared/node/process');

// Resolves with the program's stdout. Cancelling the conversion kills the program and rejects with CancelledError.
async function run(cmd, args, opts) {
  const signal = currentContext()?.signal;
  try { return await runCapture(cmd, args, { ...opts, signal }); } catch (e) { throw signal?.aborted ? new CancelledError() : e; }
}

module.exports = { run };

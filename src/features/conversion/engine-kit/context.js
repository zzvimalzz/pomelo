// SPDX-License-Identifier: AGPL-3.0-or-later
// The context of one conversion: { signal, outputs }. The signal cancels every helper process started during it, and outputs
// lists the paths it has chosen so far, so a cancelled or failed attempt can delete what it left behind. The context travels
// through async calls on its own, so engines need no extra parameters.
const { AsyncLocalStorage } = require('async_hooks');
const { killOnAbort } = require('#shared/node/process');

const context = new AsyncLocalStorage();
const withContext = (ctx, fn) => context.run(ctx, fn);
const currentContext = () => context.getStore();

class CancelledError extends Error {
  constructor() { super('Cancelled'); this.name = 'CancelledError'; }
}

// Kill `child` if the current conversion is cancelled. Returns a function that stops listening.
const killOnCancel = (child) => killOnAbort(child, context.getStore()?.signal);

module.exports = { withContext, currentContext, CancelledError, killOnCancel };

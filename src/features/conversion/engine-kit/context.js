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

// A file that cannot be read without a password. kind: 'needed' (ask for one), 'wrong' (the one given did not fit), 'unsupported'
// (a protection Pomelo cannot open), 'engine' (the component that opens it is not installed) or 'ascii' (7-Zip reads a password from
// standard input in the console's code page, so only plain ASCII reaches it unchanged).
const PASSWORD_TEXT = { needed: 'This file is password-protected', wrong: 'Wrong password', ascii: "Archive passwords can't have accented or non-Latin characters", unsupported: "This file's protection is not supported", engine: 'Opening protected files needs the PDF components, which can be installed in Settings' };
class PasswordError extends Error {
  constructor(kind) { super(PASSWORD_TEXT[kind]); this.name = 'PasswordError'; this.kind = kind; }
}

// Kill `child` if the current conversion is cancelled. Returns a function that stops listening.
const killOnCancel = (child) => killOnAbort(child, context.getStore()?.signal);

module.exports = { withContext, currentContext, CancelledError, PasswordError, killOnCancel };

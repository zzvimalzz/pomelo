// SPDX-License-Identifier: AGPL-3.0-or-later
// Running 7-Zip. A password goes to it on standard input, never on the command line where other programs can read it, and the two ways
// it says "protected" (it asks for a password, it says the one given is wrong) become a PasswordError.
const { run } = require('./run');
const { CancelledError, PasswordError } = require('./context');
const { parsePercent } = require('#shared/node/process');

// password: a Buffer. report(0..1) gets the "42%" 7-Zip prints while it works (-bsp1 sends that to stdout).
async function sevenZip(exe, args, { report, password, timeout = 3600000, ...opts } = {}) {
  if (password?.some((byte) => byte > 127)) throw new PasswordError('ascii');
  let asked = false;
  const input = password && Buffer.concat([password, Buffer.from('\n')]);
  const onLine = (line) => {
    if (line.startsWith('Enter password')) asked = true;
    const p = report ? parsePercent(line) : undefined;
    if (p !== undefined) report(p);
  };
  try {
    return await run(exe, ['-bsp1', '-y', ...args], { timeout, input, onLine, ...opts });
  } catch (e) {
    if (e instanceof CancelledError) throw e;
    if (asked && !password) throw new PasswordError('needed');
    if (password && /wrong password|data error in encrypted/i.test(e.message)) throw new PasswordError('wrong');
    throw e;
  } finally { input?.fill(0); }
}

module.exports = { sevenZip };

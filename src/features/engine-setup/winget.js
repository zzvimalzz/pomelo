// SPDX-License-Identifier: AGPL-3.0-or-later
// Windows Package Manager (winget) calls.
const { lastMeaningfulLine, parsePercent } = require('#shared/node/process');

const FLAGS = ['--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'];

// A result with code -1 and ENOENT means winget itself could not be started, as opposed to a package that failed.
function wingetRan(r) {
  if (r.code === -1 && /ENOENT/.test(r.out)) throw new Error('Windows Package Manager (winget) is not available on this PC');
}

// entry = { id, name, args? }. Throws with a reason when it did not install.
async function wingetInstall(run, entry, note) {
  note(`Installing ${entry.name}…`);
  const r = await run('winget', ['install', '--id', entry.id, ...FLAGS, ...(entry.args || [])], { onLine: (l) => note(`${entry.name}: ${l}`.slice(0, 90), parsePercent(l)) });
  wingetRan(r);
  if (r.code !== 0) throw new Error(`${entry.name} could not be installed: ${lastMeaningfulLine(r.out)}`);
}

module.exports = { wingetInstall, wingetRan };

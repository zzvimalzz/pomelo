// SPDX-License-Identifier: AGPL-3.0-or-later
// Ends a suite: removes its temp folders, then exits with 1 if a check failed. Under Electron it uses app.exit, which does not wait for windows.
const { failed } = require('./expect');
const { cleanup } = require('./tmp');

module.exports = function finish(code = failed() ? 1 : 0) {
  cleanup();
  if (process.versions.electron) require('electron').app.exit(code);
  else process.exit(code);
};

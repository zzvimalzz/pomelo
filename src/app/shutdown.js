// SPDX-License-Identifier: AGPL-3.0-or-later
// Stopping everything Pomelo started: the input helper and every converter process. Used when the app quits and before an update
// takes over (app.exit does not run the will-quit handlers).
const { killAll } = require('#shared/node/process');

function stopAll(helper) {
  helper?.stop();
  killAll();
}

module.exports = { stopAll };

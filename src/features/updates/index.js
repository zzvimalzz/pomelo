// SPDX-License-Identifier: AGPL-3.0-or-later
// Updates: look for a newer version (when asked, or now and then if the user switched it on), download and install it in
// place, and report how it went when Pomelo starts again. The rest of the app uses only this file.
const { check } = require('./check');
const { AutoUpdate } = require('./auto-check');
const { cleanup } = require('./install');
const { reportUpdate } = require('./post-update');
const { registerUpdatesIpc } = require('./updates.ipc');

module.exports = { check, AutoUpdate, cleanup, reportUpdate, registerUpdatesIpc };

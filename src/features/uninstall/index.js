// SPDX-License-Identifier: AGPL-3.0-or-later
// Removing Pomelo from inside the app. The rest of the app uses only this file.
const { registerUninstallIpc } = require('./uninstall.ipc');

module.exports = { registerUninstallIpc };

// SPDX-License-Identifier: AGPL-3.0-or-later
// Files in Pomelo's user-data folder (%APPDATA%\Pomelo): settings.json, timings.json, debug.log.
const path = require('path');
const { app } = require('electron');

const userDataFile = (name) => path.join(app.getPath('userData'), name);

module.exports = { userDataFile };

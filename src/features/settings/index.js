// SPDX-License-Identifier: AGPL-3.0-or-later
// Settings: what is stored, the Settings window, and its messages. The rest of the app uses only this file.
const { createStore } = require('./store');
const { open, getWindow } = require('./settings.window');
const { registerSettingsIpc } = require('./settings.ipc');

module.exports = { createStore, openSettingsWindow: open, getSettingsWindow: getWindow, registerSettingsIpc };

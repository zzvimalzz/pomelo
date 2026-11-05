// SPDX-License-Identifier: AGPL-3.0-or-later
// The drag-and-tap gesture: the native input helper, the state machine that reads its events, and the wheel window that
// offers the formats. The rest of the app uses only this file.
const { InputHelper } = require('./input-helper');
const { Trigger } = require('./trigger');
const { WheelWindow } = require('./wheel.window');

module.exports = { InputHelper, Trigger, WheelWindow };

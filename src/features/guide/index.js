// SPDX-License-Identifier: AGPL-3.0-or-later
// The guide: a window with an animation of the gesture and a few questions, shown on the first start and from Settings. The rest of
// the app uses only this file.
const { open } = require('./guide.window');
const { registerGuideIpc } = require('./guide.ipc');

module.exports = { openGuideWindow: open, registerGuideIpc };

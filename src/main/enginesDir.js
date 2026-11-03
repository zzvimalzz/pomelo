// SPDX-License-Identifier: AGPL-3.0-or-later
// Where Pomelo keeps the optional engines it installs for the user (a private Python environment and the list of
// what Pomelo itself installed, so uninstalling removes exactly that and nothing else).
const os = require('os');
const path = require('path');

const enginesRoot = () => path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Pomelo', 'engines');
const pyenvPython = (root = enginesRoot()) => path.join(root, 'pyenv', 'Scripts', 'python.exe');

module.exports = { enginesRoot, pyenvPython };

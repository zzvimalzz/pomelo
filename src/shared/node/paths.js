// SPDX-License-Identifier: AGPL-3.0-or-later
// Where Pomelo's own files live: the app root, the helper programs and scripts it ships, a developer's vendor/ folder, and the
// folder where Pomelo keeps the optional engines it installs for the user (with a manifest of what it installed, so uninstalling
// removes exactly that).
const os = require('os');
const path = require('path');

const APP_ROOT = path.join(__dirname, '..', '..', '..');

// Files that cannot run from inside an asar archive are unpacked next to it. Pomelo packages with asar:false, so this changes
// nothing today; it is the one place to fix if that changes. (A path that is already unpacked is left alone.)
const bundled = (p) => p.replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked');
const inApp = (...parts) => bundled(path.join(APP_ROOT, ...parts));
const scriptPath = (name) => inApp('python', name);

// vendor/ is where a developer's `npm run setup:pdf` puts the Python environment and where a release can ship portable tools.
const vendorRoots = () => [path.join(APP_ROOT, 'vendor'), process.resourcesPath && path.join(process.resourcesPath, 'vendor')].filter(Boolean);

const enginesRoot = () => path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Pomelo', 'engines');
const pyenvPython = (root = enginesRoot()) => path.join(root, 'pyenv', 'Scripts', 'python.exe');

module.exports = { APP_ROOT, bundled, inApp, scriptPath, vendorRoots, enginesRoot, pyenvPython };

// SPDX-License-Identifier: AGPL-3.0-or-later
// Compiles installer/pomelo.iss into dist/installer/Pomelo-Setup-x64.exe. Run `npm run package` first.
//   npm run build:installer             the release build
//   npm run build:installer -- --fast   a test build in a fraction of the time
// Needs Inno Setup 6.3+ (https://jrsoftware.org/isinfo.php). Set ISCC to the path of ISCC.exe if it is somewhere unusual.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const pkg = require('../package.json');

const root = path.join(__dirname, '..');
const env = process.env;
const iscc = [
  env.ISCC,
  env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Inno Setup 6', 'ISCC.exe'),
  env.ProgramFiles && path.join(env.ProgramFiles, 'Inno Setup 6', 'ISCC.exe'),
  env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Inno Setup 6', 'ISCC.exe'),
].find((p) => p && fs.existsSync(p)) || 'iscc';

if (!fs.existsSync(path.join(root, 'dist', 'Pomelo-win32-x64', 'Pomelo.exe'))) { console.error('Nothing to install yet: run `npm run package` first.'); process.exit(1); }
const fast = process.argv.includes('--fast');             // quick local test build: lighter compression, a larger installer
const r = spawnSync(iscc, [`/DAppVersion=${pkg.version}`, ...(fast ? ['/DFastBuild'] : []), path.join(root, 'installer', 'pomelo.iss')], { stdio: 'inherit' });
if (r.error) { console.error('Could not run Inno Setup (ISCC.exe). Install Inno Setup 6.3 or later, or set the ISCC environment variable.'); process.exit(1); }
process.exit(r.status === null ? 1 : r.status);

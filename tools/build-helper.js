// SPDX-License-Identifier: AGPL-3.0-or-later
// Builds native/pomelo-input.cs into native/bin/pomelo-input.exe with the C# compiler that ships with Windows
// (.NET Framework 4.x), so no SDK is needed.   node tools/build-helper.js
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const framework = path.join(process.env.windir || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const csc = path.join(framework, 'csc.exe');
const src = path.join(__dirname, '..', 'native', 'pomelo-input.cs');
const out = path.join(__dirname, '..', 'native', 'bin', 'pomelo-input.exe');

// Nothing to do when the helper is already newer than its source (it also may be running right now, which locks the file).
if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs) { console.log('pomelo-input.exe is up to date'); process.exit(0); }
if (!fs.existsSync(csc)) { console.error(`C# compiler not found at ${csc}. Pomelo builds on Windows only.`); process.exit(1); }
fs.mkdirSync(path.dirname(out), { recursive: true });
const args = ['/nologo', '/optimize+', '/target:exe', '/platform:anycpu', `/out:${out}`, `/lib:${path.join(framework, 'WPF')}`,
  '/r:UIAutomationClient.dll', '/r:UIAutomationTypes.dll', '/r:WindowsBase.dll', '/r:Microsoft.CSharp.dll', src];
const r = spawnSync(csc, args, { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);

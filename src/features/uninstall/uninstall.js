// SPDX-License-Identifier: AGPL-3.0-or-later
// Removing Pomelo from inside the app.
//
// Installed with the installer: the Windows uninstaller (unins000.exe) does everything and shows its own progress window.
// It removes the engines Pomelo installed (the engine switches in engineCli.js), "Start with Windows", the program files and
// Pomelo's settings, so uninstalling here and from Windows Settings > Apps is the same thing.
// Running from source there is no installer: only the engines and "Start with Windows" are removed.
const { spawn } = require('child_process');

// What the user is told will be removed.
function plan(installer) {
  return { engines: installer.installed() };
}

function confirmText(p) {
  const lines = ['Pomelo, its settings and its "Start with Windows" entry will be removed.'];
  if (p.engines.length) lines.push('', 'Also removed, because Pomelo installed them for you:', ...p.engines.map((n) => `  • ${n}`));
  lines.push('', 'Anything you installed yourself is left alone. Your converted files are never touched.');
  return lines.join('\n');
}

// uninstaller: path of the installer's unins000.exe (null when running from source).
// -> { launched: true } once the Windows uninstaller is on its way (the caller should quit Pomelo now),
//    or { launched: false, engines: { removed, failed } } when it removed the engines itself.
async function uninstall({ installer, uninstaller = null, setLoginItem, note = () => {}, spawnDetached = detached }) {
  if (uninstaller) {
    spawnDetached(uninstaller, ['/SILENT']);       // /SILENT: the progress window, but no second "are you sure?"
    return { launched: true };
  }
  setLoginItem(false);
  return { launched: false, engines: await installer.uninstall(note) };
}

function detached(cmd, args) {
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

module.exports = { plan, confirmText, uninstall };

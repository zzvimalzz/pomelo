// SPDX-License-Identifier: AGPL-3.0-or-later
// Pomelo started again by an in-app update (--updated[=<version>]): say how it went, and drop the downloaded installer.

// argv: the command line. current: the running version. notify({ title, detail }): shows a message.
// -> true when this start followed an update.
function reportUpdate({ argv, current, notify, cleanup, log }) {
  const flag = argv.find((a) => a.startsWith('--updated'));
  if (!flag) return false;
  const wanted = flag.split('=')[1];
  cleanup();
  if (!wanted || wanted === current) notify({ title: `Pomelo is now on version ${current}`, detail: 'The update is installed.' });
  else {
    log('update did not install; still on', current, 'wanted', wanted);
    notify({ title: 'The update could not be installed', detail: `Pomelo is still on version ${current}. Open Settings from the tray icon and try again.` });
  }
  return true;
}

module.exports = { reportUpdate };

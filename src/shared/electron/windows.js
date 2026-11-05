// SPDX-License-Identifier: AGPL-3.0-or-later
// Window setup that Pomelo's windows share.
const { BrowserWindow } = require('electron');

// A page of Pomelo's own never navigates away and never opens another window.
function lockNavigation(win) {
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

// The small transparent windows that float above everything and never take focus: the wheel and the toast.
// level: the always-on-top level ('screen-saver' goes above full-screen apps, 'status' stays under menus).
function createFloatingWindow({ width, height, preload, level }) {
  const win = new BrowserWindow({
    width, height, show: false, frame: false, transparent: true, backgroundColor: '#00000000',
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false, hasShadow: false,
    focusable: false, skipTaskbar: true, alwaysOnTop: true,
    webPreferences: { preload, contextIsolation: true, sandbox: true },
  });
  win.setAlwaysOnTop(true, level);
  lockNavigation(win);
  return win;
}

module.exports = { createFloatingWindow };

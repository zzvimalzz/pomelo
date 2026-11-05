// SPDX-License-Identifier: AGPL-3.0-or-later
// Window setup that Pomelo's windows share.
const { BrowserWindow, screen } = require('electron');

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

// Sizes a window's content to `height` (never below `min`), as far as the screen it is on allows, and keeps the window on that screen.
function fitContentHeight(win, width, height, min = 0) {
  const wa = screen.getDisplayMatching(win.getBounds()).workArea;
  const frame = win.getBounds().height - win.getContentBounds().height;
  win.setContentSize(width, Math.round(Math.max(min, Math.min(height, wa.height - frame - 24))));
  const b = win.getBounds();
  if (b.y + b.height > wa.y + wa.height) win.setPosition(b.x, Math.max(wa.y, wa.y + wa.height - b.height - 12));
}

module.exports = { createFloatingWindow, lockNavigation, fitContentHeight };

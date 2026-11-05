// SPDX-License-Identifier: AGPL-3.0-or-later
// The guide window: the animation of the gesture and a short list of questions. One window at a time. It is as tall as its page, up to
// the screen, and appears once the page has reported its height, so it never shows at the wrong size.
const path = require('path');
const { BrowserWindow, nativeTheme } = require('electron');
const { lockNavigation, fitContentHeight } = require('#shared/electron/windows');

const WIDTH = 520;
let win = null;

// asset(name): the path of a file in assets/. onClosed(): called once when the user closes the window.
function open(asset, { onClosed } = {}) {
  if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: WIDTH, height: 600, useContentSize: true, resizable: false, maximizable: false, minimizable: true,
    fullscreenable: false, title: 'How Pomelo works', icon: asset('icon.png'), autoHideMenuBar: true, show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f6f4f1',
    webPreferences: { preload: path.join(__dirname, 'ui', 'preload.js'), contextIsolation: true, sandbox: true },
  });
  const mine = win;
  mine.setMenu(null);
  lockNavigation(mine);
  mine.loadFile(path.join(__dirname, 'ui', 'guide.html'));
  setTimeout(() => { if (!mine.isDestroyed() && !mine.isVisible()) mine.show(); }, 3000);        // should the page never report its height
  mine.on('closed', () => { if (win === mine) win = null; onClosed?.(); });
}

// The page reports its height; fit the window to it, and show it the first time.
function fit(sender, height) {
  if (!win || win.isDestroyed() || sender !== win.webContents) return;
  fitContentHeight(win, WIDTH, height);
  if (!win.isVisible()) { win.show(); win.focus(); }
}

module.exports = { open, fit, getWindow: () => win };

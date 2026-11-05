// SPDX-License-Identifier: AGPL-3.0-or-later
// The settings window. It sizes itself to its content (no scrollbars) and stays within the screen.
const path = require('path');
const { BrowserWindow, shell } = require('electron');
const { fitContentHeight } = require('#shared/electron/windows');
const log = require('#shared/node/log');

const WIDTH = 480;
const MIN_HEIGHT = 320;
let win = null;

function create(assetPath) {
  win = new BrowserWindow({
    width: WIDTH, height: 600, useContentSize: true, resizable: false, maximizable: false, minimizable: true, fullscreenable: false,
    title: 'Pomelo', icon: assetPath('icon.png'), autoHideMenuBar: true, show: false, backgroundColor: '#1c1c1e',
    webPreferences: { preload: path.join(__dirname, 'ui', 'preload.js'), contextIsolation: true, sandbox: true },
  });
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'ui', 'settings.html'));
  win.once('ready-to-show', () => { win.show(); win.focus(); log('settings window shown'); });
  win.on('closed', () => { win = null; });
}

function open(assetPath) {
  if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); return; }
  create(assetPath);
}

// The page reports its natural height; fit the window to it (up to the screen), scrollbars stay hidden. Only the Settings page is heard.
function fit(sender, height) {
  if (win && !win.isDestroyed() && sender === win.webContents) fitContentHeight(win, WIDTH, height, MIN_HEIGHT);
}

module.exports = { open, fit, getWindow: () => win };

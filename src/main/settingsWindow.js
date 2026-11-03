// SPDX-License-Identifier: AGPL-3.0-or-later
// The settings window. It sizes itself to its content (no scrollbars) and stays within the screen.
const path = require('path');
const { BrowserWindow, ipcMain, screen, clipboard, shell } = require('electron');
const log = require('./log');

const WIDTH = 480;
const MIN_HEIGHT = 320;
let win = null;

function create(assetPath) {
  win = new BrowserWindow({
    width: WIDTH, height: 600, useContentSize: true, resizable: false, maximizable: false, minimizable: true, fullscreenable: false,
    title: 'Pomelo', icon: assetPath('icon.png'), autoHideMenuBar: true, show: false, backgroundColor: '#1c1c1e',
    webPreferences: { preload: path.join(__dirname, '..', 'preload', 'settings.js'), contextIsolation: true, sandbox: true },
  });
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));
  win.once('ready-to-show', () => { win.show(); win.focus(); log('settings window shown'); });
  win.on('closed', () => { win = null; });
}

function open(assetPath) {
  if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); return; }
  create(assetPath);
}

// Renderer reports its natural height; fit the window to it (up to the screen), scrollbars stay hidden.
ipcMain.on('settings:fit', (e, height) => {
  if (!win || win.isDestroyed() || e.sender !== win.webContents) return;
  const wa = screen.getDisplayMatching(win.getBounds()).workArea;
  const frame = win.getBounds().height - win.getContentBounds().height;
  const h = Math.round(Math.max(MIN_HEIGHT, Math.min(height, wa.height - frame - 24)));
  win.setContentSize(WIDTH, h);
  const b = win.getBounds();
  if (b.y + b.height > wa.y + wa.height) win.setPosition(b.x, Math.max(wa.y, wa.y + wa.height - b.height - 12));
});
ipcMain.on('app:copy', (_e, text) => clipboard.writeText(String(text)));
ipcMain.on('app:open-logs', () => shell.showItemInFolder(log.path()));

module.exports = { open, getWindow: () => win };

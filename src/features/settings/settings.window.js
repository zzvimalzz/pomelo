// SPDX-License-Identifier: AGPL-3.0-or-later
// The settings window: a fixed 880 x 600 window (shorter on a screen that is) whose title bar is part of the page. Windows draws
// the minimise and close buttons over it, in colours that follow the theme.
const path = require('path');
const { BrowserWindow, nativeTheme, screen, shell } = require('electron');
const log = require('#shared/node/log');

const WIDTH = 880;
const HEIGHT = 600;
const TITLEBAR = 44;
const CHROME = { dark: { color: '#242427', symbolColor: '#f5f5f7' }, light: { color: '#efece8', symbolColor: '#1c1c1e' } };
let win = null;

const chrome = () => CHROME[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'];

// target: { page, check } opens on a section; check also starts an update check.
function create(assetPath, target) {
  win = new BrowserWindow({
    width: WIDTH, height: Math.min(HEIGHT, screen.getPrimaryDisplay().workArea.height - 24), useContentSize: true, resizable: false, maximizable: false, minimizable: true, fullscreenable: false,
    title: 'Pomelo', icon: assetPath('icon.png'), autoHideMenuBar: true, show: false, backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f6f4f1',
    titleBarStyle: 'hidden', titleBarOverlay: { ...chrome(), height: TITLEBAR - 1 },       // stops above the bar's 1 px bottom border, so the line runs the full width
    webPreferences: { preload: path.join(__dirname, 'ui', 'preload.js'), contextIsolation: true, sandbox: true },
  });
  const mine = win;
  const restyle = () => { if (!mine.isDestroyed()) mine.setTitleBarOverlay(chrome()); };
  nativeTheme.on('updated', restyle);
  mine.setMenu(null);
  mine.webContents.setWindowOpenHandler(({ url }) => { if (/^https:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  mine.webContents.on('will-navigate', (e) => e.preventDefault());
  mine.loadFile(path.join(__dirname, 'ui', 'settings.html'), { query: Object.fromEntries(Object.entries(target || {}).map(([k, v]) => [k, String(v)])) });
  mine.once('ready-to-show', () => { mine.show(); mine.focus(); log('settings window shown'); });
  mine.on('closed', () => { nativeTheme.off('updated', restyle); if (win === mine) win = null; });
}

function open(assetPath, target) {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (target) {
      const mine = win;
      const send = () => { if (!mine.isDestroyed()) mine.webContents.send('settings:go', target); };
      if (mine.webContents.isLoading()) mine.webContents.once('did-finish-load', send); else send();
    }
    return;
  }
  create(assetPath, target);
}

module.exports = { open, getWindow: () => win };

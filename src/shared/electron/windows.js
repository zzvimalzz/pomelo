// SPDX-License-Identifier: AGPL-3.0-or-later
// Window setup that Pomelo's windows share.
const os = require('os');
const { BrowserWindow, nativeTheme, screen, session } = require('electron');
const { startBounds, MIN } = require('../core/bounds');

const WINDOWS_11 = 22621;

// A page of Pomelo's own never navigates away and never opens another window.
function lockNavigation(win) {
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

// A page built from a user's document must not be able to call out to the internet (remote images, tracking pixels). Local files
// stay readable.
function blockNetwork(session) {
  session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] }, (_details, callback) => callback({ cancel: true }));
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

const TITLE_ROW = 44;
const CHROME = { dark: { color: '#242427', symbolColor: '#f5f5f7' }, light: { color: '#efece8', symbolColor: '#1c1c1e' } };
const chrome = () => CHROME[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'];
const overlay = (solid) => ({ color: solid ? chrome().color : '#00000000', symbolColor: chrome().symbolColor, height: TITLE_ROW });

// A resizable window whose title row is part of the page. Windows 11 draws acrylic behind it and the minimise, maximise and close
// buttons over the right-hand end. Before Windows 11 (or with `solid`) the window is opaque. Its session blocks the network, so nothing
// a document asks for can leave the PC.
// asset(name): path of a file shipped in assets/. solid: draw an opaque window (by default only before Windows 11, which is the first to
// have acrylic). saved: the stored place of the window.
// onBounds({ x, y, width, height, maximised, savedAt }): called, after a pause, whenever the user moved or resized it.
// partition: the session's name. preload: the page's preload script. page: the HTML file to load.
function createAppWindow({ asset, solid = Number(os.release().split('.')[2]) < WINDOWS_11, saved, onBounds, partition, preload, page }) {
  const primary = screen.getPrimaryDisplay();
  const areas = [primary, ...screen.getAllDisplays().filter((d) => d.id !== primary.id)].map((d) => d.workArea);
  const start = startBounds(saved, areas);
  const ses = session.fromPartition(partition);
  blockNetwork(ses);
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));

  const win = new BrowserWindow({
    x: start.x, y: start.y, width: start.width, height: start.height, minWidth: MIN.width, minHeight: MIN.height,
    title: 'Pomelo', icon: asset('icon.png'), autoHideMenuBar: true, show: false,
    ...(solid ? { backgroundColor: chrome().color } : { backgroundMaterial: 'acrylic', backgroundColor: '#00000000' }),
    titleBarStyle: 'hidden', titleBarOverlay: overlay(solid),
    webPreferences: { preload, contextIsolation: true, sandbox: true, session: ses, spellcheck: false },
  });
  const restyle = () => { if (!win.isDestroyed()) win.setTitleBarOverlay(overlay(solid)); };
  nativeTheme.on('updated', restyle);
  win.setMenu(null);
  lockNavigation(win);
  if (start.maximised) win.maximize();

  let timer = null;
  const save = () => { if (!win.isFullScreen()) onBounds({ ...win.getNormalBounds(), maximised: win.isMaximized(), savedAt: Date.now() }); };
  const later = () => { clearTimeout(timer); timer = setTimeout(save, 400); };
  for (const event of ['move', 'resize', 'maximize', 'unmaximize']) win.on(event, later);
  win.on('close', () => { clearTimeout(timer); save(); });
  win.on('closed', () => { clearTimeout(timer); nativeTheme.off('updated', restyle); });

  win.loadFile(page, solid ? { query: { solid: '1' } } : undefined);
  win.once('ready-to-show', () => { win.show(); win.focus(); });
  return win;
}

module.exports = { createAppWindow, createFloatingWindow, lockNavigation, blockNetwork };

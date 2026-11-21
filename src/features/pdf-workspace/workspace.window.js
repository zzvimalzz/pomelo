// SPDX-License-Identifier: AGPL-3.0-or-later
// The workspace window: resizable, with a title row that is part of the page. Windows 11 draws acrylic behind it and the minimise,
// maximise and close buttons over the right-hand end. Before Windows 11 (or with `solid`) the window is opaque. Its session blocks
// the network, so nothing a document asks for can leave the PC.
const path = require('path');
const { BrowserWindow, dialog, nativeTheme, screen, session } = require('electron');
const { blockNetwork, lockNavigation } = require('#shared/electron/windows');
const { startBounds, MIN } = require('./bounds');

const TITLE_ROW = 44;
const CHROME = { dark: { color: '#242427', symbolColor: '#f5f5f7' }, light: { color: '#efece8', symbolColor: '#1c1c1e' } };
const chrome = () => CHROME[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'];
const overlay = (solid) => ({ color: solid ? chrome().color : '#00000000', symbolColor: chrome().symbolColor, height: TITLE_ROW });

// asset(name): path of a file shipped in assets/. solid: draw an opaque window. saved: the stored place of the window.
// onBounds({ x, y, width, height, maximised }): called, after a pause, whenever the user moved or resized it.
function create({ asset, solid, saved, onBounds }) {
  const primary = screen.getPrimaryDisplay();
  const areas = [primary, ...screen.getAllDisplays().filter((d) => d.id !== primary.id)].map((d) => d.workArea);
  const start = startBounds(saved, areas);
  const ses = session.fromPartition('pomelo-workspace');
  blockNetwork(ses);
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));

  const win = new BrowserWindow({
    x: start.x, y: start.y, width: start.width, height: start.height, minWidth: MIN.width, minHeight: MIN.height,
    title: 'Pomelo', icon: asset('icon.png'), autoHideMenuBar: true, show: false,
    ...(solid ? { backgroundColor: chrome().color } : { backgroundMaterial: 'acrylic', backgroundColor: '#00000000' }),
    titleBarStyle: 'hidden', titleBarOverlay: overlay(solid),
    webPreferences: { preload: path.join(__dirname, 'ui', 'preload.js'), contextIsolation: true, sandbox: true, session: ses, spellcheck: false },
  });
  const restyle = () => { if (!win.isDestroyed()) win.setTitleBarOverlay(overlay(solid)); };
  nativeTheme.on('updated', restyle);
  win.setMenu(null);
  lockNavigation(win);
  if (start.maximised) win.maximize();

  let timer = null;
  const save = () => onBounds({ ...win.getNormalBounds(), maximised: win.isMaximized() });
  const later = () => { clearTimeout(timer); timer = setTimeout(save, 400); };
  for (const event of ['move', 'resize', 'maximize', 'unmaximize']) win.on(event, later);
  win.on('close', () => { clearTimeout(timer); save(); });
  win.on('closed', () => nativeTheme.off('updated', restyle));

  win.loadFile(path.join(__dirname, 'ui', 'workspace.html'), solid ? { query: { solid: '1' } } : undefined);
  win.once('ready-to-show', () => { win.show(); win.focus(); });
  return win;
}

async function choosePdf(parent) {
  const options = { title: 'Open a PDF', properties: ['openFile'], filters: [{ name: 'PDF files', extensions: ['pdf'] }] };
  const picked = await (parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options));
  return picked.canceled ? [] : picked.filePaths;
}

module.exports = { create, choosePdf };

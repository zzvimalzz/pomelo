// SPDX-License-Identifier: AGPL-3.0-or-later
// The transparent, always-on-top, non-activating window that hosts the wheel. It is also the drop target.
// (Progress, results and errors are shown by the bottom-right toast, see toast.js.)
const path = require('path');
const { BrowserWindow, screen, ipcMain } = require('electron');
const { extOf, groupOf } = require('./formats');
const log = require('./log');

const WHEEL = 400;

class Overlay {
  constructor({ onDrop }) {
    this.onDrop = onDrop;
    this.shown = false;
    this.loaded = new Promise((resolve) => { this.markLoaded = resolve; });
    this.hideTimer = null;
  }

  create() {
    this.win = new BrowserWindow({
      width: WHEEL, height: WHEEL, show: false, frame: false, transparent: true, backgroundColor: '#00000000',
      resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false, hasShadow: false,
      focusable: false, skipTaskbar: true, alwaysOnTop: true,
      webPreferences: { preload: path.join(__dirname, '..', 'preload', 'overlay.js'), contextIsolation: true, sandbox: true },
    });
    this.win.setAlwaysOnTop(true, 'screen-saver');
    this.win.setIgnoreMouseEvents(false);
    this.win.webContents.on('will-navigate', (e) => e.preventDefault());
    this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.win.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));

    ipcMain.on('overlay:log', (_e, msg) => log('overlay:', msg));
    ipcMain.once('overlay:ready', () => this.markLoaded());
    ipcMain.on('wheel:drop', (_e, { targetId, paths }) => { clearTimeout(this.hideTimer); this.hide(); this.onDrop(paths, targetId); });
    ipcMain.on('wheel:cancel', () => this.hide());
  }

  // Centre the wheel on the cursor, kept inside the display's work area.
  place() {
    const p = screen.getCursorScreenPoint();
    const wa = screen.getDisplayNearestPoint(p).workArea;
    const cx = Math.min(Math.max(p.x, wa.x + WHEEL / 2), wa.x + wa.width - WHEEL / 2);
    const cy = Math.min(Math.max(p.y, wa.y + WHEEL / 2), wa.y + wa.height - WHEEL / 2);
    this.win.setBounds({ x: Math.round(cx - WHEEL / 2), y: Math.round(cy - WHEEL / 2), width: WHEEL, height: WHEEL });
  }

  async openWheel(files, targets) {
    await this.loaded;
    clearTimeout(this.hideTimer);
    const first = files[0];
    const info = { name: path.basename(first), ext: extOf(first), group: groupOf(extOf(first)), count: files.length };
    this.place();
    this.win.webContents.send('wheel:open', { info, targets });
    this.win.showInactive();
    this.shown = true;
    log('wheel shown', this.win.getBounds(), targets.map((t) => t.id));
  }

  // Released without a drop on us: give the drop event a moment to arrive, then fold the wheel away.
  releaseSoon() {
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.hide(), 450);
  }

  hide() {
    clearTimeout(this.hideTimer);
    if (!this.shown) return;
    this.shown = false;
    this.win.webContents.send('wheel:close');
    this.hideTimer = setTimeout(() => this.win.hide(), 140);
  }
}

module.exports = { Overlay };

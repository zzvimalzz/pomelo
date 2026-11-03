// SPDX-License-Identifier: AGPL-3.0-or-later
// Progress, results and errors appear in a small toast stack in the bottom-right corner, just above the taskbar,
// instead of over whatever the user is working on. It never takes focus. What to show comes from jobs.js.
const path = require('path');
const { BrowserWindow, screen, ipcMain, shell } = require('electron');

const W = 408;          // card (380) plus a margin for its shadow
const CARD_H = 88;
const GAP = 8;
const PAD = 14;         // shadow margin around the stack
const EDGE = 4;         // gap to the work area edge (the work area already excludes the taskbar)

const heightFor = (n) => n * CARD_H + (n - 1) * GAP + 2 * PAD;

class Toast {
  // onRemove(id): a card finished fading out in the renderer. onCancel(id): the X in a progress ring was pressed.
  constructor({ onRemove, onCancel } = {}) {
    this.onRemove = onRemove || (() => {});
    this.onCancel = onCancel || (() => {});
    this.win = null;
    this.visible = false;
    this.count = 0;
    this.loaded = new Promise((resolve) => { this.markLoaded = resolve; });
  }

  create() {
    this.win = new BrowserWindow({
      width: W, height: heightFor(1), show: false, frame: false, transparent: true, backgroundColor: '#00000000',
      resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false, hasShadow: false,
      focusable: false, skipTaskbar: true, alwaysOnTop: true,
      webPreferences: { preload: path.join(__dirname, '..', 'preload', 'toast.js'), contextIsolation: true, sandbox: true },
    });
    this.win.setAlwaysOnTop(true, 'status');
    this.win.webContents.on('will-navigate', (e) => e.preventDefault());
    this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.win.loadFile(path.join(__dirname, '..', 'renderer', 'toast.html'));
    ipcMain.once('toast:ready', () => this.markLoaded());
    ipcMain.on('toast:reveal', (_e, file) => { if (file) shell.showItemInFolder(file); });
    ipcMain.on('toast:remove', (_e, id) => this.onRemove(id));
    ipcMain.on('toast:cancel', (_e, id) => this.onCancel(id));
  }

  // Bottom-right of the primary display (where the taskbar tray is), inside the work area. Grows upward.
  place(n) {
    const h = heightFor(n);
    const wa = screen.getPrimaryDisplay().workArea;
    this.win.setBounds({ x: wa.x + wa.width - W - EDGE, y: wa.y + wa.height - h - EDGE, width: W, height: h });
  }

  // view = { mode, cards: [...] } from Jobs.view(), newest card first.
  async update(view) {
    await this.loaded;
    if (this.win.isDestroyed()) return;
    const n = view.cards.length;
    if (!n) {
      if (this.visible) { this.win.hide(); this.visible = false; this.count = 0; }
      return;
    }
    if (n !== this.count || !this.visible) this.place(n);
    this.count = n;
    this.win.webContents.send('toast:view', view);
    if (!this.visible) { this.win.showInactive(); this.visible = true; }
  }
}

module.exports = { Toast, heightFor };

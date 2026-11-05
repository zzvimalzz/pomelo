// SPDX-License-Identifier: AGPL-3.0-or-later
// Progress, results and errors appear in a small toast stack in the bottom-right corner, just above the taskbar,
// instead of over whatever the user is working on. It never takes focus. What to show comes from jobs.js.
const path = require('path');
const { screen } = require('electron');
const { registerToastIpc } = require('./toast.ipc');
const { createFloatingWindow } = require('#shared/electron/windows');

const W = 408;          // card (380) plus a margin for its shadow
const CARD_H = 88;
const GAP = 8;
const PAD = 14;         // shadow margin around the stack
const EDGE = 4;         // gap to the work area edge (the work area already excludes the taskbar)

const heightFor = (n) => n * CARD_H + (n - 1) * GAP + 2 * PAD;

class Toast {
  // onRemove(id): a card finished fading out in the renderer. onCancel(id): the X in a progress ring was pressed.
  // onClick(id): a card that is a button was clicked.
  constructor({ onRemove, onCancel, onClick } = {}) {
    this.onRemove = onRemove || (() => {});
    this.onCancel = onCancel || (() => {});
    this.onClick = onClick || (() => {});
    this.win = null;
    this.visible = false;
    this.count = 0;
    this.loaded = new Promise((resolve) => { this.markLoaded = resolve; });
  }

  create() {
    this.win = createFloatingWindow({ width: W, height: heightFor(1), preload: path.join(__dirname, 'ui', 'preload.js'), level: 'status' });
    registerToastIpc({ onReady: () => this.markLoaded(), onRemove: (id) => this.onRemove(id), onCancel: (id) => this.onCancel(id), onClick: (id) => this.onClick(id) });
    this.win.loadFile(path.join(__dirname, 'ui', 'toast.html'));
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

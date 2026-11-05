// SPDX-License-Identifier: AGPL-3.0-or-later
// The transparent, always-on-top, non-activating window that hosts the wheel. It is also the drop target.
// (Progress, results and errors are shown by the bottom-right toast, see toast.js.)
const path = require('path');
const { screen } = require('electron');
const { registerWheelIpc } = require('./wheel.ipc');
const { createFloatingWindow } = require('#shared/electron/windows');
const log = require('#shared/node/log');

const WHEEL = 400;

class WheelWindow {
  constructor({ onDrop }) {
    this.onDrop = onDrop;
    this.shown = false;
    this.loaded = new Promise((resolve) => { this.markLoaded = resolve; });
    this.hideTimer = null;
  }

  create() {
    this.win = createFloatingWindow({ width: WHEEL, height: WHEEL, preload: path.join(__dirname, 'ui', 'preload.js'), level: 'screen-saver' });
    this.win.setIgnoreMouseEvents(false);
    registerWheelIpc({
      onLog: (msg) => log('overlay:', msg),
      onReady: () => this.markLoaded(),
      onDrop: (paths, targetId) => { clearTimeout(this.hideTimer); this.hide(); this.onDrop(paths, targetId); },
      onCancel: () => this.hide(),
    });
    this.win.loadFile(path.join(__dirname, 'ui', 'wheel.html'));
  }

  // Centre the wheel on the cursor, kept inside the display's work area.
  place() {
    const p = screen.getCursorScreenPoint();
    const wa = screen.getDisplayNearestPoint(p).workArea;
    const cx = Math.min(Math.max(p.x, wa.x + WHEEL / 2), wa.x + wa.width - WHEEL / 2);
    const cy = Math.min(Math.max(p.y, wa.y + WHEEL / 2), wa.y + wa.height - WHEEL / 2);
    this.win.setBounds({ x: Math.round(cx - WHEEL / 2), y: Math.round(cy - WHEEL / 2), width: WHEEL, height: WHEEL });
  }

  // info = { name, ext, group, count } describes the selection (built by the app from the format catalog); the name is already shortened.
  async openWheel(info, targets) {
    await this.loaded;
    clearTimeout(this.hideTimer);
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

module.exports = { WheelWindow };

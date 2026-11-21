// SPDX-License-Identifier: AGPL-3.0-or-later
// The transparent, always-on-top, non-activating window that hosts the wheel. It is also the drop target.
// (Progress, results and errors are shown by the bottom-right toast, see toast.js.) When a dropped file needs a password the wheel page
// turns into a card that asks for it, in the same window. The card behaves like an ordinary window: it takes focus, can be moved by its
// top, shows in the taskbar, sinks behind the windows the user goes on to use, lets clicks through around it, and closes by itself after
// IDLE_MS without focus.
const path = require('path');
const { screen } = require('electron');
const { registerWheelIpc } = require('./wheel.ipc');
const { createFloatingWindow } = require('#shared/electron/windows');
const log = require('#shared/node/log');

const WHEEL = 400;
const ABOVE = 64;       // room over the wheel for the pill that names the other wheel's key
const IDLE_MS = 5 * 60 * 1000;

class WheelWindow {
  // onDrop(paths, targetId) resolves with the files that need a password (the page asks for them), or none. onUnlock(request) answers
  // the card. onUnlockEnd(): the wheel is gone, so nothing waits for a password. onExpire(): the card is closing because nobody used it. icon: the taskbar icon of the card.
  // idleMs: how long the card may go without focus.
  constructor({ onDrop, onUnlock, onUnlockEnd, onExpire = () => {}, icon, idleMs = IDLE_MS }) {
    this.onDrop = onDrop;
    this.onUnlock = onUnlock;
    this.asking = false;        // the page is showing the password card
    this.onUnlockEnd = onUnlockEnd;
    this.onExpire = onExpire;
    this.icon = icon;
    this.idleMs = idleMs;
    this.idleTimer = null;
    this.card = null;           // where the card is in the window: { x, y, width, height }
    this.tracker = null;
    this.overCard = false;      // the pointer is over the card: the window takes the mouse there, and lets it through elsewhere
    this.busy = false;          // files were dropped and are being checked, or the card is asking: the mouse release must not fold the wheel
    this.shown = false;
    this.loaded = new Promise((resolve) => { this.markLoaded = resolve; });
    this.hideTimer = null;
    this.pickFiles = null;      // the files of a wheel opened from the right-click menu, which is clicked instead of dropped on
  }

  create() {
    this.win = createFloatingWindow({ width: WHEEL, height: WHEEL + ABOVE, preload: path.join(__dirname, 'ui', 'preload.js'), level: 'screen-saver' });
    this.win.setIgnoreMouseEvents(false);
    if (this.icon) this.win.setIcon(this.icon);
    this.win.setTitle('Pomelo: password needed');
    registerWheelIpc({
      onLog: (msg) => log('overlay:', msg),
      onReady: () => this.markLoaded(),
      onDrop: (paths, targetId) => this.drop(paths, targetId),
      onPick: (targetId) => { if (this.pickFiles) this.drop(this.pickFiles, targetId); else this.hide(); },
      onCancel: () => this.hide(),
      onUnlock: (request) => this.onUnlock(request),
      onCard: (rect) => this.setCard(rect),
      isWheel: (sender) => sender === this.win.webContents,
    });
    this.win.on('blur', () => {
      if (this.pickFiles) this.hide();
      else if (this.asking) this.idleTimer = setTimeout(() => this.expire(), this.idleMs);
    });
    this.win.on('focus', () => clearTimeout(this.idleTimer));
    this.win.loadFile(path.join(__dirname, 'ui', 'wheel.html'));
  }

  // Centre the wheel on the cursor, kept inside the display's work area.
  place() {
    const p = screen.getCursorScreenPoint();
    const wa = screen.getDisplayNearestPoint(p).workArea;
    const cx = Math.min(Math.max(p.x, wa.x + WHEEL / 2), wa.x + wa.width - WHEEL / 2);
    const cy = Math.min(Math.max(p.y, wa.y + ABOVE + WHEEL / 2), wa.y + wa.height - WHEEL / 2);
    this.win.setBounds({ x: Math.round(cx - WHEEL / 2), y: Math.round(cy - WHEEL / 2 - ABOVE), width: WHEEL, height: WHEEL + ABOVE });
  }

  // The wheel stays up while the files are checked, so the page can turn it into the card. Anything else folds it away.
  async drop(paths, targetId) {
    if (this.busy) return;
    clearTimeout(this.hideTimer);
    this.busy = true;
    let locked = [];
    try { locked = await this.onDrop(paths, targetId); } catch (e) { log('drop failed:', e.message); }
    if (locked.length && this.shown) this.ask(locked);
    else this.hide();
  }

  ask(files) {
    this.asking = true;
    this.pickFiles = null;
    this.overCard = false;
    this.card = null;
    clearInterval(this.tracker);
    this.tracker = setInterval(() => this.track(), 50);
    this.win.setAlwaysOnTop(false);
    this.win.setSkipTaskbar(false);
    this.win.setMovable(true);
    this.win.setFocusable(true);
    this.win.show();
    this.win.focus();
    this.letMouseThrough();
    this.win.webContents.send('wheel:unlock-open', { files });
  }

  // The card is only as big as the card: clicks around it go to what lies beneath.
  letMouseThrough() {
    if (!this.asking) { this.win.setIgnoreMouseEvents(false); return; }
    this.win.setIgnoreMouseEvents(!this.overCard, { forward: true });
  }

  expire() {
    if (!this.asking) return;
    log('password card closed after being left alone');
    this.onExpire();
    this.hide();
  }

  // The page reports where the card is, in window coordinates, or null when there is none. Whether the pointer is over it is found here,
  // since a page gets no mouse events over the part that moves the window.
  setCard(rect) {
    this.card = rect;
    this.track();
  }

  track() {
    if (!this.asking) return;
    const p = screen.getCursorScreenPoint();
    const b = this.win.getBounds();
    const r = this.card;
    const over = !!r && p.x >= b.x + r.x && p.x < b.x + r.x + r.width && p.y >= b.y + r.y && p.y < b.y + r.y + r.height;
    if (over === this.overCard) return;
    this.overCard = over;
    this.letMouseThrough();
  }

  // A new wheel is wanted while the card is open: the card fades, the window is hidden and shown again, so the new wheel is stacked as
  // a fresh window is (a window that stayed up ended behind the icon being dragged).
  async dismiss() {
    this.win.webContents.send('wheel:close');
    this.shown = false;
    this.endAsking();
    this.busy = false;
    this.onUnlockEnd();
    await new Promise((resolve) => setTimeout(resolve, 170));
    this.win.hide();
    this.win.setFocusable(false);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }

  endAsking() {
    this.asking = false;
    clearTimeout(this.idleTimer);
    clearInterval(this.tracker);
    this.win.setSkipTaskbar(true);
    this.win.setMovable(false);
    this.win.setIgnoreMouseEvents(false);
  }

  // info = { name, ext, group, count } describes the selection (built by the app from the format catalog); the name is already shortened.
  // pickFiles: set when the wheel comes from the right-click menu. It then takes focus, so that a click elsewhere or Esc closes it.
  // view: { wheel: 'convert' (the default) | 'open', droppable (default true), switchable }. droppable: the files can be dropped on this
  // wheel. switchable: the other wheel can be reached with its key, so the pill that names the key is shown.
  async openWheel(info, targets, pickFiles = null, view = {}) {
    await this.loaded;
    clearTimeout(this.hideTimer);
    if (this.asking) await this.dismiss();
    this.place();
    this.pickFiles = pickFiles;
    this.busy = false;
    this.onUnlockEnd();
    this.win.webContents.send('wheel:open', { info, targets, pick: !!pickFiles, ...view });
    if (pickFiles) { this.win.setFocusable(true); this.win.show(); this.win.focus(); } else { this.win.setFocusable(false); this.win.showInactive(); }
    this.win.setAlwaysOnTop(true, 'screen-saver');   // The topmost flag can be set while Windows keeps the wheel under the folder being dragged from; applying it again lifts it.
    this.shown = true;
    log('wheel shown', this.win.getBounds(), targets.map((t) => t.id));
  }

  // The wheel that is showing turns into the other one, same view options as openWheel.
  switchWheel(targets, view) {
    if (this.shown) this.win.webContents.send('wheel:switch', { targets, ...view });
  }

  // Released without a drop on us: give the drop event a moment to arrive, then fold the wheel away.
  releaseSoon() {
    if (this.busy) return;
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.hide(), 450);
  }

  hide() {
    clearTimeout(this.hideTimer);
    this.busy = false;
    if (this.asking) this.endAsking();
    this.onUnlockEnd();
    if (!this.shown) return;
    this.shown = false;
    this.pickFiles = null;
    this.win.webContents.send('wheel:close');
    this.hideTimer = setTimeout(() => { this.win.hide(); this.win.setFocusable(false); }, 140);
  }
}

module.exports = { WheelWindow };

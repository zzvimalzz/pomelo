// SPDX-License-Identifier: AGPL-3.0-or-later
// The "Pomelo Downloader" window: shows an update being downloaded and, once Pomelo has restarted, the extras the new version
// adds. The user can minimise it (the work carries on either way) but not close it while work goes on: its Cancel button, or
// Close once there is nothing left to do, ends it. Its page is in ui/.
const path = require('path');
const { BrowserWindow, nativeTheme } = require('electron');
const { lockNavigation } = require('#shared/electron/windows');

const WORKING = ['download', 'install', 'engines'];

class Downloader {
  // asset(name): the path of a file in assets/.
  constructor({ asset }) {
    this.asset = asset;
    this.win = null;
    this.state = null;            // the last thing the page was told, so a page that loads late still shows it
    this.loaded = false;
  }

  // inactive: appear without taking the keyboard from what the user is doing.
  show({ inactive = false } = {}) {
    if (this.win) {
      if (this.win.isMinimized()) this.win.restore();
      if (inactive) this.win.showInactive(); else { this.win.show(); this.win.focus(); }
      return;
    }
    this.win = new BrowserWindow({
      width: 420, height: 224, useContentSize: true, resizable: false, maximizable: false, minimizable: true, fullscreenable: false,
      title: 'Pomelo Downloader', icon: this.asset('icon.png'), autoHideMenuBar: true, show: false,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f6f4f1',
      webPreferences: { preload: path.join(__dirname, 'ui', 'preload.js'), contextIsolation: true, sandbox: true },
    });
    const win = this.win;
    win.setMenu(null);
    lockNavigation(win);
    win.loadFile(path.join(__dirname, 'ui', 'downloader.html'));
    win.once('ready-to-show', () => { if (inactive) win.showInactive(); else { win.show(); win.focus(); } });
    win.on('closed', () => { this.win = null; this.loaded = false; });
  }

  // state = { phase: 'download' | 'install' | 'engines' | 'done' | 'error', current, latest, fraction?, received?, total?, left?,
  // note?, message? } (see ui/downloader.js). The taskbar button shows the same progress.
  update(state) {
    this.state = state;
    if (!this.win) return;
    const busy = WORKING.includes(state.phase);
    this.win.setClosable(!busy);
    if (this.loaded) this.win.webContents.send('updates:state', state);
    this.win.setProgressBar(!busy ? -1 : Number.isFinite(state.fraction) ? state.fraction : 2);   // above 1 = "busy, no figure"
  }

  // The page has loaded: give it what it missed.
  ready() {
    this.loaded = true;
    if (this.state && this.win) this.win.webContents.send('updates:state', this.state);
  }

  // The work is over (or was cancelled): really close. The X is switched off while working, and that blocks close() too.
  close() {
    this.state = null;
    this.win?.setClosable(true);
    this.win?.close();
  }
}

module.exports = { Downloader };

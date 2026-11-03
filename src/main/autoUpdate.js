// SPDX-License-Identifier: AGPL-3.0-or-later
// "Check automatically": when the user turns it on, Pomelo looks for a newer version now and then and tells them.
// That is all it does. It never downloads or installs anything: the download starts only when the user presses the
// Download button in Settings. With the toggle off (the default) Pomelo makes no update request unless the user clicks
// "Check for updates". No Electron in here, so it can be tested on its own.
const DAY = 24 * 60 * 60 * 1000;

class AutoUpdate {
  // getSettings() / setSettings(patch): the stored settings (autoUpdate, lastUpdateCheck, updateNotified).
  // check(): the update check, -> { state, latest?, url?, ... }.   onAvailable(result): called once for each new version.
  constructor({ getSettings, setSettings, check, onAvailable, now = Date.now, startDelay = 30000, interval = DAY, retry = 2 * 60 * 60 * 1000, timers = { set: setTimeout, clear: clearTimeout } }) {
    Object.assign(this, { getSettings, setSettings, check, onAvailable, now, startDelay, interval, retry, timers });
    this.timer = null;
    this.available = null;           // the newest available-update result seen, until the app is updated or restarted
    this.running = false;
  }

  // Call at start-up and whenever the setting may have changed.
  apply() {
    this.stop();
    const s = this.getSettings();
    if (!s.autoUpdate) return;
    const due = (s.lastUpdateCheck || 0) + this.interval - this.now();      // checked in the last day? then wait out the rest of it
    this.schedule(Math.max(this.startDelay, due));
  }

  stop() {
    if (this.timer) this.timers.clear(this.timer);
    this.timer = null;
  }

  schedule(ms) {
    this.timer = this.timers.set(() => this.run(), ms);
    this.timer.unref?.();
  }

  async run() {
    this.timer = null;
    if (this.running || !this.getSettings().autoUpdate) return;
    this.running = true;
    let delay = this.interval;
    try {
      const result = await this.check();
      if (result.state === 'error') delay = this.retry;                      // offline: quietly try again a little later
      else this.setSettings({ lastUpdateCheck: this.now() });
      this.remember(result);
      if (result.state === 'available' && this.getSettings().updateNotified !== result.latest) {
        this.setSettings({ updateNotified: result.latest });                 // one notice per version, not one per day
        this.onAvailable(result);
      }
    } catch { delay = this.retry; } finally {
      this.running = false;
      if (this.getSettings().autoUpdate) this.schedule(delay);
    }
  }

  // A manual "Check for updates" teaches this what is known too, so Settings opens already knowing.
  remember(result) {
    this.available = result && result.state === 'available' ? result : null;
  }
}

module.exports = { AutoUpdate, DAY };

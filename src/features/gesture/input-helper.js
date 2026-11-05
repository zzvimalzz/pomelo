// SPDX-License-Identifier: AGPL-3.0-or-later
// Client for native/pomelo-input.cs: global input events plus "which files are being dragged?".
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const log = require('#shared/node/log');
const { inApp } = require('#shared/node/paths');

const EXE = inApp('native', 'bin', 'pomelo-input.exe');

class InputHelper extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.ready = false;
    this.nextId = 1;
    this.pending = new Map();
    this.buf = '';
    this.stopped = false;
    this.key = 'ctrl';
  }

  start() {
    this.stopped = false;
    this.proc = spawn(EXE, [], { windowsHide: true });
    this.proc.on('error', (e) => { log('input helper could not start:', e.message, '(run npm run build:helper)'); console.warn('[pomelo-input]', e.message); });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (d) => this.onData(d));
    this.proc.stderr.on('data', (d) => console.warn('[pomelo-input]', String(d).trim().slice(0, 300)));
    this.proc.on('exit', () => {
      this.ready = false;
      for (const done of this.pending.values()) done({ files: [], explorer: false });
      this.pending.clear();
      if (!this.stopped) setTimeout(() => this.start(), 2000);   // helper died: bring it back
    });
  }

  onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      if (line[0] !== '{') { this.emit('input', line.split(' ')); continue; }   // md/mm/mu/kd events
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.ready) { this.ready = true; this.send(`key ${this.key}`); continue; }
      const done = this.pending.get(msg.id);
      if (done) { this.pending.delete(msg.id); if (!(msg.files || []).length && msg.why) log('no files:', msg.why); done({ files: msg.files || [], explorer: !!msg.explorer }); }
    }
  }

  send(line) { if (this.ready) this.proc.stdin.write(`${line}\n`); }

  // The one key (ctrl, alt or shift) the helper reports besides Esc. Applied again whenever the helper restarts.
  setKey(name) { this.key = name; this.send(`key ${name}`); }

  // Call at mouse-down: remembers which Explorer item is under (x, y), in physical screen pixels.
  down(x, y) { this.send(`down ${Math.round(x)} ${Math.round(y)}`); }

  // Call once a drag is under way. Resolves { files, explorer }: the selected files of the item's window, and
  // whether the drag started on an Explorer/desktop item at all (so we can say "can't convert that" for folders).
  files(timeoutMs = 3000) {
    if (!this.proc || !this.ready) return Promise.resolve({ files: [], explorer: false });
    return new Promise((resolve) => {
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ files: [], explorer: false }); }, timeoutMs);
      this.pending.set(id, (files) => { clearTimeout(timer); resolve(files); });
      this.send(`files ${id}`);
    });
  }

  stop() {
    this.stopped = true;
    try { this.proc?.stdin.end(); this.proc?.kill(); } catch { /* already gone */ }
  }
}

module.exports = { InputHelper };

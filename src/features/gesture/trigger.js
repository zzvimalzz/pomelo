// SPDX-License-Identifier: AGPL-3.0-or-later
// Gesture detector. Hold the left mouse button on a file, drag, then press the trigger key.
//   idle -> pressed (left down) -> dragging (moved past threshold, files probed) -> wheel (trigger key pressed)
// Input events come from the native input helper (see native/pomelo-input.cs).
const { EventEmitter } = require('events');
const log = require('#shared/node/log');

const DRAG_THRESHOLD_PX = 8;
const KEYS = ['ctrl', 'alt', 'shift'];

class Trigger extends EventEmitter {
  constructor(helper) {
    super();
    this.helper = helper;
    this.enabled = true;
    this.key = 'ctrl';
    this.state = 'idle';
    this.origin = null;
    this.files = null;        // Promise<string[]> once the drag starts
  }

  setKey(name) { if (KEYS.includes(name)) this.key = name; }
  setEnabled(on) { this.enabled = on; if (!on) this.reset(); }

  start() { this.helper.on('input', (ev) => this.onInput(ev)); }

  onInput([type, a, b]) {
    if (type === 'md') {
      log('mouse down', a, b);
      this.state = 'pressed';
      this.origin = { x: +a, y: +b };
      this.files = null;
      this.helper.down(this.origin.x, this.origin.y);
    } else if (type === 'mm') {
      if (this.state !== 'pressed' || !this.enabled) return;
      if (Math.hypot(+a - this.origin.x, +b - this.origin.y) < DRAG_THRESHOLD_PX) return;
      this.state = 'dragging';
      log('drag started; asking Explorer for the selection');
      this.files = this.helper.files();   // resolved by the time the key is tapped
    } else if (type === 'kd' && this.enabled) {
      if (a === 'esc' && this.state === 'wheel') { this.reset(); this.emit('cancel'); return; }
      log('key down', a, 'state=' + this.state);
      if (a !== this.key || this.state !== 'dragging') return;
      this.state = 'wheel';
      this.files.then(({ files, explorer }) => {
        log('selection:', files, 'explorer=' + explorer);
        if (this.state !== 'wheel') return;           // released while we were looking
        if (files.length) this.emit('open', files);
        else if (explorer) this.emit('unsupported');   // e.g. a folder: tell the user instead of staying silent
        else this.state = 'dragging';                  // not an Explorer drag; stay quiet
      });
    } else if (type === 'mu') {
      log('mouse up, state=' + this.state);
      const wasWheel = this.state === 'wheel';
      this.reset();
      if (wasWheel) this.emit('release');             // the drop event (if any) is delivered by the overlay window
    }
  }

  reset() { this.state = 'idle'; this.files = null; this.origin = null; }
}

module.exports = { Trigger };

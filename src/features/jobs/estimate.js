// SPDX-License-Identifier: AGPL-3.0-or-later
// What the toast says about how far a conversion has got and how long is left. No UI and no Electron in here.
//
// Engines that can measure their own progress (video and audio, page-by-page PDF work, archives) report it and the
// toast shows exactly that. For the rest (LibreOffice and friends, which give no progress at all) the figure is an
// estimate that moves with time, based on how long conversions of that kind have taken on this PC before, so the ring
// is never just spinning and a slow job is visibly slow.
const fs = require('fs');
const path = require('path');
const { extsInGroup, OFFICE } = require('./formats');

const MB = 1048576;

// Rough first guesses (milliseconds), used until Pomelo has timed a conversion of that kind itself.
const OFFICE_EXT = new Set(Object.values(OFFICE).flat());
const PICTURE = new Set(extsInGroup('image'));

function guessMs(from, to, size) {
  const mb = size / MB;
  if (from === 'pdf') return 3000 + Math.min(size / 70000, 400) * 1000;              // about a second a page
  if (OFFICE_EXT.has(from) || OFFICE_EXT.has(to)) return 6000 + mb * 3000;                  // LibreOffice starts slowly
  if (PICTURE.has(from)) return 800 + mb * 600;
  return 1500 + mb * 1000;
}

// Learned timings: key "from>to" -> milliseconds per (1 MB + 1), smoothed. Kept next to the settings.
class Timings {
  constructor(file) {
    this.file = file;
    this.data = {};
    try { this.data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }
  }

  expected(from, to, size) {
    const learned = this.data[`${from}>${to}`];
    return learned ? Math.max(500, learned * (1 + size / MB)) : guessMs(from, to, size);
  }

  record(from, to, size, ms) {
    if (!(ms > 300)) return;                                                          // too quick to teach anything
    const key = `${from}>${to}`;
    const per = ms / (1 + size / MB);
    this.data[key] = this.data[key] ? this.data[key] * 0.6 + per * 0.4 : per;
    if (!this.file) return;
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.data)); } catch { /* best effort */ }
  }
}

// The fraction to draw, 0..1, never going backwards, never claiming to be finished before it is.
// reported: what the engine said (or null); elapsed and expected in milliseconds.
function shownProgress(reported, elapsed, expected, previous = 0) {
  const value = reported != null ? reported : 0.92 * elapsed / (elapsed + 0.6 * expected);
  return Math.max(previous, Math.min(Math.max(0, value), 0.99));
}

// "about 40 s left", "about 2 min left", "about 1 min 30 s left"; null when there is nothing useful to say.
function timeLeft(ms) {
  if (!(ms >= 0)) return null;
  const s = Math.round(ms / 1000);
  if (s < 3) return 'almost done';
  if (s < 20) return `about ${s} s left`;
  if (s < 90) return `about ${Math.round(s / 5) * 5} s left`;
  const m = Math.floor(s / 60);
  const rest = Math.round((s % 60) / 15) * 15;
  if (m < 5) return rest === 60 ? `about ${m + 1} min left` : `about ${m} min${rest ? ` ${rest} s` : ''} left`;
  return `about ${Math.round(s / 60)} min left`;
}

// How long is left. Measured progress gives it from the pace so far; estimated progress from the expected duration.
// Returns { ms, text } with text possibly null; smoothed: pass the previous ms back in so the figure does not jump.
function remaining({ reported, elapsed, expected, previous }) {
  let ms;
  if (reported != null) {
    if (reported < 0.03 || elapsed < 1500) return { ms: null, text: null };
    ms = elapsed * (1 - reported) / reported;
  } else {
    if (elapsed < 1000) return { ms: null, text: null };                      // no point guessing before anything has happened
    if (elapsed > expected * 2 + 15000) return { ms: null, text: 'taking longer than usual' };
    ms = Math.max(0, expected - elapsed);
    if (elapsed > expected) return { ms: 0, text: 'finishing up' };
  }
  if (previous != null) ms = previous * 0.6 + ms * 0.4;
  return { ms, text: timeLeft(ms) };
}

module.exports = { Timings, shownProgress, remaining, guessMs };

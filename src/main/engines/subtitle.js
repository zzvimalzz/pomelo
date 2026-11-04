// SPDX-License-Identifier: AGPL-3.0-or-later
// Subtitles: SRT <-> VTT, and plain-text export. Pure JS.
const fs = require('fs');
const { uniquePath, readText } = require('../convert/util');

const TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;

function toMs(stamp) {
  const m = TIME.exec(stamp);
  if (!m) return null;
  return (+(m[1] || 0)) * 3600000 + (+m[2]) * 60000 + (+m[3]) * 1000 + +m[4].padEnd(3, '0');
}

function fmt(ms, sep) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)}${sep}${p(ms % 1000, 3)}`;
}

// -> [{ start, end, text }]. Works for both formats: a cue is any block with a "-->" line.
function parse(text) {
  const blocks = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;                                    // WEBVTT header, NOTE, STYLE, REGION blocks
    const [a, b] = lines[at].split('-->');
    const start = toMs(a), end = toMs(b || '');
    if (start === null || end === null) continue;
    const body = lines.slice(at + 1).join('\n').trim();
    if (body) cues.push({ start, end, text: body });
  }
  return cues;
}

const plain = (s) => s.replace(/\{\\[^}]*\}/g, '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

module.exports = {
  name: 'subtitle',
  supports: (from, to) => (from === 'srt' && (to === 'vtt' || to === 'txt')) || (from === 'vtt' && (to === 'srt' || to === 'txt')),
  async run({ src, to, dir, base }) {
    const cues = parse(readText(src));
    if (!cues.length) throw new Error('No subtitle cues found in this file');
    const out = uniquePath(dir, base, to);
    let body;
    if (to === 'srt') body = cues.map((c, i) => `${i + 1}\n${fmt(c.start, ',')} --> ${fmt(c.end, ',')}\n${c.text}\n`).join('\n');
    else if (to === 'vtt') body = 'WEBVTT\n\n' + cues.map((c) => `${fmt(c.start, '.')} --> ${fmt(c.end, '.')}\n${c.text}\n`).join('\n');
    else body = cues.map((c) => plain(c.text)).filter(Boolean).join('\n') + '\n';
    fs.writeFileSync(out, body, 'utf8');
    return [out];
  },
};

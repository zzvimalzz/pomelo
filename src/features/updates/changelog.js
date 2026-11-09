// SPDX-License-Identifier: AGPL-3.0-or-later
// Reads CHANGELOG.md (the copy shipped with the app) into releases for the release history in Settings.
const fs = require('fs');

// An item is "**Title.** text" or plain text. The bold lead becomes the title.
function item(raw) {
  const m = /^\*\*(.+?)\*\*(.*)$/.exec(raw);
  if (!m) return { title: '', text: raw };
  return { title: m[1].replace(/[.:\s]+$/, ''), text: m[2].replace(/^[:.\s]+/, '') };
}

// -> [{ version, date, sections: [{ name, items: [{ title, text }] }] }], newest first as in the file. Unreleased is left out.
function parseChangelog(text) {
  const releases = [];
  let release = null;
  let section = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    let m;
    if ((m = /^## \[(\d+\.\d+\.\d+[^\]]*)\](?: - (.+))?$/.exec(line))) {
      release = { version: m[1], date: m[2] || '', sections: [] };
      releases.push(release);
      section = null;
    } else if (/^## /.test(line)) {
      release = section = null;
    } else if (release && (m = /^### (.+)$/.exec(line))) {
      section = { name: m[1].trim(), raw: [] };
      release.sections.push(section);
    } else if (section && (m = /^- (.+)$/.exec(line))) {
      section.raw.push(m[1]);
    } else if (section?.raw.length && /^\s+\S/.test(line)) {
      section.raw[section.raw.length - 1] += ` ${line.trim()}`;
    }
  }
  return releases.map((r) => ({ ...r, sections: r.sections.map((s) => ({ name: s.name, items: s.raw.map(item) })).filter((s) => s.items.length) }));
}

// A missing or unreadable file gives an empty history, never an error.
function readChangelog(file) {
  try { return parseChangelog(fs.readFileSync(file, 'utf8')); } catch { return []; }
}

module.exports = { parseChangelog, readChangelog };

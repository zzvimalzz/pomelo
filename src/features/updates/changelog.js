// SPDX-License-Identifier: AGPL-3.0-or-later
// Reads CHANGELOG.md (the copy shipped with the app) into releases for the release history in Settings.
// The changelog is written for developers; the history keeps only each item's headline and leaves out the Internal section.
const fs = require('fs');

// An item is "**Headline.** detail". Without a bold lead its first sentence is the headline.
function headline(raw) {
  const lead = /^\*\*(.+?)\*\*/.exec(raw);
  return (lead ? lead[1] : raw.split(/(?<=[.!?])\s/)[0]).replace(/[.:\s]+$/, '');
}

// -> [{ version, date, sections: [{ name, items: [headline] }] }], newest first as in the file. Unreleased is left out.
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
  return releases
    .map((r) => ({ ...r, sections: r.sections.filter((s) => s.raw.length && !/^internal$/i.test(s.name)).map((s) => ({ name: s.name, items: s.raw.map(headline) })) }))
    .filter((r) => r.sections.length);
}

// A missing or unreadable file gives an empty history, never an error.
function readChangelog(file) {
  try { return parseChangelog(fs.readFileSync(file, 'utf8')); } catch { return []; }
}

module.exports = { parseChangelog, readChangelog };

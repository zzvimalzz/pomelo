// SPDX-License-Identifier: AGPL-3.0-or-later
// Dev tool: keeps private notes, plans and agent instructions out of what is pushed. Lists tracked files that belong to those, and
// text in tracked files that points at them.   node tools/check-public.js [root]   Exits 1 when it finds anything.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PRIVATE_PATHS = /^(docs\/|\.claude\/|AGENTS\.md$|CLAUDE\.md$|PLAN[^/]*\.md$|ROADMAP[^/]*\.md$|STAMP\.md$)/;
const PRIVATE_TEXT = [
  [/refactor[- ]plan|plan-v\d|plan-review/i, 'refers to a private plan'],
  [/\b(?:AGENTS|CLAUDE)\.md\b|\.claude\//, 'refers to the private agent instructions'],
  [/\bPhase [A-G]\b|\bnext phase\b/i, 'names a phase of a private plan'],
  [/\bknown follow-?up\b/i, 'is a note to self'],
  [/\bN\d{1,2}\b|\bCI-\d{1,2}\b/, 'names an item of a private review'],
];
// These two hold the patterns and the samples they are tested with.
const SELF = new Set(['tools/check-public.js', 'test/unit/tools/check-public.test.js']);

function scan(file, text) {
  const found = [];
  if (PRIVATE_PATHS.test(file)) found.push(`${file}: a private file is tracked`);
  if (SELF.has(file)) return found;
  text.split(/\r?\n/).forEach((line, i) => {
    for (const [re, why] of PRIVATE_TEXT) if (re.test(line)) found.push(`${file}:${i + 1}: ${why}: ${line.trim().slice(0, 100)}`);
  });
  return found;
}

function scanTracked(root) {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 }).split('\0').filter(Boolean);
  return files.flatMap((file) => {
    const buf = fs.existsSync(path.join(root, file)) ? fs.readFileSync(path.join(root, file)) : null;
    return scan(file, buf && !buf.includes(0) ? buf.toString('utf8') : '');
  });
}

if (require.main === module) {
  const found = scanTracked(path.resolve(process.argv[2] || path.join(__dirname, '..')));
  found.forEach((f) => console.log(f));
  console.log(found.length ? `\n${found.length} private references in tracked files` : 'no private notes or plans in tracked files');
  process.exitCode = found.length ? 1 : 0;
}

module.exports = { scan, scanTracked };

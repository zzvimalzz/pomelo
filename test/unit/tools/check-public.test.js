// SPDX-License-Identifier: AGPL-3.0-or-later
// tools/check-public.js must flag a tracked private file and text that points at a private plan, and leave ordinary text alone.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { scan, scanTracked } = require('../../../tools/check-public');
const { expect } = require('../../support/expect');
const finish = require('../../support/finish');
const tmp = require('../../support/tmp');

const hits = (file, text) => scan(file, text).length;

console.log('what is flagged');
expect('a tracked private file', hits('docs/anything.md', 'x') === 1 && hits('AGENTS.md', 'x') === 1 && hits('.claude/skills/a/SKILL.md', 'x') === 1);
expect('a pointer at the plan or the agent instructions', hits('a.js', '// see docs/pomelo-refactor-plan-v2.md') === 1 && hits('a.md', 'rules are in AGENTS.md') === 1);
expect('a phase label, a review item and a note to self', hits('a.js', '// Phase C moves this') === 1 && hits('a.js', '// the N21 bug') === 1 && hits('a.js', '// a known follow-up') === 1);
expect('the line number is reported', scan('a.js', 'ok\n// Phase D').join().startsWith('a.js:2:'));

console.log('what is left alone');
expect('ordinary text', hits('a.md', 'A private Python environment, a plan for each conversion, N-up printing, phase: install') === 0);
expect('the tool and its test, which hold the patterns', hits('tools/check-public.js', 'AGENTS.md Phase A') === 0);

console.log('in a repository');
{
  const dir = tmp.dir('public');
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  fs.writeFileSync(path.join(dir, 'readme.md'), 'Hello\n');
  fs.writeFileSync(path.join(dir, 'notes.md'), 'see the refactor plan\n');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'x\n');
  fs.writeFileSync(path.join(dir, 'icon.bin'), Buffer.from([0, 1, 2, 0x41]));
  git('add', '.');
  const found = scanTracked(dir);
  expect('tracked files are scanned, binary ones are skipped', found.length === 2 && found.some((f) => /^notes\.md:1/.test(f)) && found.some((f) => /^CLAUDE\.md/.test(f)), found.join(' | '));
  fs.writeFileSync(path.join(dir, 'untracked.md'), 'Phase A\n');
  expect('an untracked file is not looked at', scanTracked(dir).length === 2);
}
finish();

// SPDX-License-Identifier: AGPL-3.0-or-later
// The changelog reader behind the release history in Settings: a sample for each shape it understands, and the real CHANGELOG.md,
// so a change to the file's layout that the reader cannot follow fails here instead of showing an empty history.
const fs = require('fs');
const path = require('path');
const { expect } = require('../../support/expect');
const finish = require('../../support/finish');
const { parseChangelog, readChangelog } = require('../../../src/features/updates/changelog');

const sample = [
  '# Changelog', '', 'Intro [Keep a Changelog](https://keepachangelog.com/).', '',
  '## [Unreleased]', '', '### Added', '- **Not shipped yet.** Detail.', '',
  '## [0.2.0] - 05-12-2026', '',
  '### Added', '- **A new thing.** It does this, and `that`.', '- Plain item with no bold lead. It goes on.', '',
  '### Fixed', '- **Update now**: no longer opens the browser.', '- **Wrapped.** The text runs', '  over two lines.', '',
  '### Internal', '- **A test harness.** For developers only.', '',
  '## [0.1.1] - 04-11-2026', '', '### Internal', '- **Only for developers.** Nothing a user sees.', '',
  '## [0.1.0] - 03-11-2026', '', '### Added', '- **First.** Detail.', '',
  '[0.2.0]: https://example.com/compare',
].join('\r\n');

const r = parseChangelog(sample);
expect('Unreleased is left out and the releases keep the file order', r.map((x) => x.version).join() === '0.2.0,0.1.0', r.map((x) => x.version).join());
expect('each release has its date and its sections in order', r[0].date === '05-12-2026' && r[0].sections.map((s) => s.name).join() === 'Added,Fixed');
expect('the history keeps the bold headline without its full stop and drops the detail', JSON.stringify(r[0].sections[0].items[0]) === JSON.stringify('A new thing'), JSON.stringify(r[0].sections[0].items[0]));
expect('an item with no bold lead is shown as its first sentence', r[0].sections[0].items[1] === 'Plain item with no bold lead', r[0].sections[0].items[1]);
expect('a colon after the headline is dropped too', r[0].sections[1].items[0] === 'Update now');
expect('a wrapped item is joined into one', r[0].sections[1].items[1] === 'Wrapped', r[0].sections[1].items[1]);
expect('the Internal section is left out, and a release with nothing else is left out whole', !r[0].sections.some((s) => s.name === 'Internal') && !r.some((x) => x.version === '0.1.1'));
expect('link lines at the end and text before the first release are ignored', r[1].sections[0].items.length === 1 && r.length === 2);
expect('a missing file is an empty history, not an error', readChangelog(path.join(__dirname, 'no-such-file.md')).length === 0);

const file = path.join(__dirname, '..', '..', '..', 'CHANGELOG.md');
const real = readChangelog(file);
const order = (a, b) => a.split('.').map(Number).reduce((d, n, i) => d || n - Number(b.split('.')[i]), 0);
expect('the real changelog has releases, newest first', real.length > 0 && real.every((x, i) => i === 0 || order(real[i - 1].version, x.version) > 0), real.map((x) => x.version).join());
expect('every release has a date, a section and a headline for each item', real.every((x) => /^\d\d-\d\d-\d{4}$/.test(x.date) && x.sections.length > 0 && x.sections.every((s) => s.items.every(Boolean))));
expect('the newest entry is the version in package.json', real[0].version === require('../../../package.json').version, `${real[0].version} vs ${require('../../../package.json').version}`);

// A bold headline on every item is what keeps the history short and readable without anyone writing it twice.
const unheaded = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => /^- /.test(l) && !/^- \*\*.+?\*\*/.test(l));
expect('every changelog item starts with a bold headline', unheaded.length === 0, unheaded.join(' | '));

finish();

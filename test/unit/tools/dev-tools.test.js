// SPDX-License-Identifier: AGPL-3.0-or-later
// The two lint-like tools in tools/, run on small fixture trees: unused-exports must see the cases a word search misses, and
// check-boundaries must flag each kind of bad import and leave good ones alone.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { expect } = require('../../support/expect');
const finish = require('../../support/finish');
const tmp = require('../../support/tmp');

function tree(files) {
  const dir = tmp.dir('tools');
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}
const run = (tool, dir) => execFileSync(process.execPath, [path.join(__dirname, '..', '..', '..', 'tools', tool), dir], { encoding: 'utf8' });

console.log('unused-exports');
{
  const out = run('unused-exports.js', tree({
    'src/app/a.js': [
      'const used = 1, dead = 2, parse = 3, run = 4, live = 5, idle = 6;',
      'function createThing() {',
      '  return {',
      '    // a comment, with commas, inside the returned object',
      '    live,',
      '    idle,',
      '  };',
      '}',
      'module.exports = { used, dead, parse, async run() {}, createThing };',
    ].join('\n'),
    'src/app/b.js': ["const { used, createThing } = require('./a');", "JSON.parse('1');", 'createThing().live;'].join('\n'),
    'src/app/shim.js': "module.exports = require('./target');",
    'src/app/target.js': 'const viaShim = 1, unreadByAnyone = 2;\nmodule.exports = { viaShim, unreadByAnyone };',
    'src/app/user.js': "const { viaShim } = require('./shim');",
    'src/features/conversion/engines/one/index.js': "module.exports = { name: 'one', supports() {}, run() {}, detect() {}, extra: 1 };",
    'src/features/conversion/engines/one/helper.js': 'module.exports = { run() {}, detect() {} };',
  }));
  expect('an export that is read is not reported', !/"used"|"createThing"/.test(out));
  expect('a name that only appears as JSON.parse is reported', /"parse"/.test(out));
  expect('an `async` method is checked under its own name', /"run"/.test(out) && !/"async"/.test(out));
  expect('the API a factory returns is checked: unused key reported, used key not', /"idle"/.test(out) && !/"live"/.test(out));
  expect('a plain unused export is reported', /"dead"/.test(out));
  expect('what is read through a one-line re-export counts as used, what is not does not', !/"viaShim"/.test(out) && /"unreadByAnyone"/.test(out));
  const engineLines = out.split('\n').filter((l) => /engines[\\/]one[\\/]index\.js/.test(l));
  expect('an engine\'s interface names are not reported, its other exports are', engineLines.length === 1 && /"extra"/.test(engineLines[0]), engineLines.join(' | '));
  expect('a helper next to an engine gets no such exemption', /helper\.js: "run"/.test(out) && /helper\.js: "detect"/.test(out));
}

console.log('check-boundaries');
{
  const dir = tree({
    'src/shared/core/text.js': "const fs = require('../node/fs');",
    'src/shared/node/fs.js': '',
    'src/features/settings/index.js': '',
    'src/features/jobs/index.js': "const s = require('../settings/index');",
    'src/features/jobs/jobs.js': "const { app } = require('electron');",
    'src/features/gesture/wheel.window.js': "const { BrowserWindow } = require('electron');",
    'src/features/conversion/engines/ffmpeg/index.js': "const other = require('../pandoc/index');\nconst mime = require('../../lib/mime');",
    'src/features/conversion/engines/pandoc/index.js': '',
    'src/features/conversion/lib/mime.js': '',
    'src/features/conversion/lib/print-pdf.js': "const { BrowserWindow } = require('electron');",
    'src/features/conversion/engines/builtin/images.js':"function f() {\n  const { nativeImage } = require('electron');\n}",
    'src/app/main.js': "const a = require('../features/jobs/jobs');\nconst b = require('../features/gesture/index');",
    'src/features/gesture/index.js': '',
    'src/preload/overlay.js': "const path = require('path');",
  });
  const lines = run('check-boundaries.js', dir).split('\n').filter((l) => l.includes(': '));
  const about = (file, rule) => lines.some((l) => l.startsWith(`${file}: ${rule}:`));
  expect('shared/core importing shared/node is flagged', about('shared/core/text.js', 'shared'));
  expect('one feature importing another is flagged', about('features/jobs/index.js', 'features'));
  expect('a logic file requiring electron is flagged', about('features/jobs/jobs.js', 'logic'));
  expect('an engine importing another engine is flagged, importing lib is not', about('features/conversion/engines/ffmpeg/index.js', 'conversion') && lines.filter((l) => l.startsWith('features/conversion/engines/ffmpeg')).length === 1);
  expect('in conversion, a top-level electron require is flagged and a lazy one is not', about('features/conversion/lib/print-pdf.js', 'electron-lazy') && !lines.some((l) => l.startsWith('features/conversion/engines/builtin/images.js')));
  expect('app/ reaching past a feature index is flagged, using the index is not', about('app/main.js', 'app') && lines.filter((l) => l.startsWith('app/main.js')).length === 1);
  expect('a preload requiring anything but electron is flagged', about('preload/overlay.js', 'preload'));
  expect('a window file may require electron', !lines.some((l) => l.startsWith('features/gesture/wheel.window.js')));
}

finish();

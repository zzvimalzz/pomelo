// SPDX-License-Identifier: AGPL-3.0-or-later
// Where conversions are saved: the chosen folder, the fallback when it stops working, and the files really landing there.
//   node test/unit/app/output-dir.test.js
const fs = require('fs');
const path = require('path');
const { createOutputDir } = require('../../../src/app/output-dir');
const conversion = require('../../../src/features/conversion');
const { expect } = require('../../support/expect');
const finish = require('../../support/finish');
const { dir: tmpDir } = require('../../support/tmp');

(async () => {
  const root = tmpDir('outdir');
  const chosen = path.join(root, 'Converted ünï');
  fs.mkdirSync(chosen);

  console.log('choosing the folder');
  let setting = '';
  const told = [];
  const pick = createOutputDir({ getDir: () => setting, notify: (d) => told.push(d) });
  expect('no folder chosen: next to the original', pick() === undefined && !told.length);
  setting = chosen;
  expect('a folder that exists is used', pick() === chosen);
  setting = path.join(root, 'gone');
  expect('a folder that does not exist falls back', pick() === undefined);
  pick(); pick();
  expect('and the user is told once, not for every file', told.length === 1 && told[0] === setting, told.join());
  fs.mkdirSync(setting);
  expect('the folder coming back is used again', pick() === setting);
  fs.rmSync(setting, { recursive: true });
  pick();
  expect('and losing it again is reported again', told.length === 2);
  const file = path.join(root, 'a-file');
  fs.writeFileSync(file, 'x');
  setting = file;
  expect('a file where the folder should be falls back', pick() === undefined);

  console.log('converting into it');
  conversion.detectEngines();
  const src = path.join(root, 'notes.txt');
  fs.writeFileSync(src, 'hello from Pomelo');
  const outs = await conversion.convertFile(src, 'html', { outDir: chosen });
  expect('the result is in the chosen folder, flat', outs.length === 1 && path.dirname(outs[0]) === chosen && fs.existsSync(outs[0]), outs.join());
  expect('nothing is written next to the original', fs.readdirSync(root).filter((f) => f.endsWith('.html')).length === 0);
  const again = await conversion.convertFile(src, 'html', { outDir: chosen });
  expect('a second conversion does not overwrite the first', again[0] !== outs[0] && fs.existsSync(outs[0]) && fs.existsSync(again[0]), path.basename(again[0]));
  const beside = await conversion.convertFile(src, 'html');
  expect('without a folder it still goes next to the original', path.dirname(beside[0]) === root, beside.join());

  finish();
})().catch((e) => { console.error(e); finish(1); });

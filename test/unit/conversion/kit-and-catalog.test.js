// SPDX-License-Identifier: AGPL-3.0-or-later
// The small shared pieces of the conversion feature that the slow engine suites only reach indirectly: progress scaling, the time
// limit for the Python helpers and their progress lines, the "no output" check, the context that carries the cancel signal, and
// the reasons shown when the wheel has nothing to offer.
const fs = require('fs');
const path = require('path');
const { scaled } = require('../../../src/features/conversion/engine-kit/progress');
const { timeoutFor, progressReader } = require('../../../src/features/conversion/engine-kit/python');
const { assertProduced, uniquePath } = require('../../../src/features/conversion/engine-kit/outputs');
const { withContext, currentContext, killOnCancel } = require('../../../src/features/conversion/engine-kit/context');
const { explainNoTargets } = require('../../../src/features/conversion/catalog/explain');
const { expect } = require('../../support/expect');
const finish = require('../../support/finish');
const tmp = require('../../support/tmp');

console.log('progress');
{
  const seen = [];
  scaled((f) => seen.push(f), 0.5, 0.25)(0.4);
  expect('scaled maps a step onto its share of the whole job', Math.abs(seen[0] - 0.6) < 1e-9, String(seen));
  expect('and gives nothing when nobody is listening', scaled(undefined, 0, 1) === undefined);
  const lines = [];
  const read = progressReader((f) => lines.push(f));
  ['POMELO_PROGRESS 0.4', 'chatter', 'POMELO_PROGRESS 1.5'].forEach(read);
  expect('the helper scripts\' POMELO_PROGRESS lines are read and capped below 1', lines.join() === '0.4,0.99', lines.join());
  expect('no listener, no reader', progressReader(undefined) === undefined);
}

console.log('time limit for a helper');
{
  const dir = tmp.dir('kit');
  const file = (name, bytes) => { const f = path.join(dir, name); fs.writeFileSync(f, Buffer.alloc(bytes)); return f; };
  expect('a small PDF gets ten minutes plus two for its first ten pages', timeoutFor(file('small.pdf', 1000)) === 600000 + 120000);
  expect('two more minutes for every further ten pages (about 60 kB each)', timeoutFor(file('big.pdf', 60000 * 25)) === 600000 + 3 * 120000);
  expect('a file that is not there still gets a limit', timeoutFor(path.join(dir, 'nope.pdf')) === 600000 + 120000);
  expect('and it never exceeds four hours', timeoutFor(file('huge.pdf', 60000 * 2000)) === 4 * 3600 * 1000);
}

console.log('outputs and the conversion context');
{
  const dir = tmp.dir('kit');
  let e;
  try { assertProduced(path.join(dir, 'missing.docx'), 'PDF engine'); } catch (x) { e = x; }
  expect('assertProduced names the engine that wrote nothing', e?.message === 'PDF engine produced no output', e?.message);
  fs.writeFileSync(path.join(dir, 'there.docx'), 'x');
  expect('and is quiet when the file exists', (assertProduced(path.join(dir, 'there.docx'), 'PDF engine'), true));

  fs.writeFileSync(path.join(dir, 'a.pdf'), 'x');
  const ctx = { signal: undefined, outputs: [] };
  const chosen = withContext(ctx, () => [uniquePath(dir, 'a', 'pdf'), uniquePath(dir, 'b', 'pdf'), currentContext() === ctx]);
  expect('uniquePath never overwrites and notes each path in the conversion\'s context', chosen[0] === path.join(dir, 'a (1).pdf') && chosen[1] === path.join(dir, 'b.pdf') && chosen[2] && ctx.outputs.length === 2, ctx.outputs.join(' | '));
  expect('outside a conversion there is no context', currentContext() === undefined);
  expect('killOnCancel outside a conversion listens to nothing', typeof killOnCancel({ pid: 0 }) === 'function');
}

console.log('why the wheel has nothing to offer');
{
  expect('mixed kinds', explainNoTargets(['a.docx', 'b.png']).title === 'These items are different kinds');
  expect('a shortcut', explainNoTargets(['a.lnk']).title === 'Shortcuts can\'t be converted');
  expect('a format Pomelo does not know', explainNoTargets(['a.xyz']).title === 'Can\'t convert .xyz files');
  expect('a file with no extension', explainNoTargets(['README']).title === 'Can\'t convert these files');
  expect('a format it knows but has no engine for', explainNoTargets(['a.docx']).title === 'No converter available for .docx files');
}

finish();

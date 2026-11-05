// SPDX-License-Identifier: AGPL-3.0-or-later
// engines/registry.js: detectEngines() builds the engines map from whatever each engine's detect() reports. The keys are a
// contract (settings, the installer and the planner read them), so they are checked under the 9 engine cases.
const { detectEngines, getEngines } = require('../../../src/features/conversion/engines/registry');
const { expect } = require('../../support/expect');
const finish = require('../../support/finish');

const KEYS = ['soffice', 'pandoc', 'pdf', 'ocr', 'heic', 'ffmpeg', 'sevenZip'];
const CASES = { all: [], none: KEYS, ...Object.fromEntries(KEYS.map((k) => [`without-${k}`, [k]])) };

console.log('the engines map under 9 cases');
for (const [name, missing] of Object.entries(CASES)) {
  // one fake engine per key, as the real ones are split (pdf-python answers for pdf and ocr)
  const fake = KEYS.map((k) => ({ detect: () => ({ [k]: missing.includes(k) ? null : `C:/engines/${k}.exe` }) }));
  const map = detectEngines(fake);
  const ok = Object.keys(map).join() === KEYS.join() && KEYS.every((k) => !!map[k] === !missing.includes(k));
  expect(`${name}: the seven keys, in order, found exactly where they should be`, ok, JSON.stringify(map));
}
expect('the map holds exactly the keys the engines report', Object.keys(detectEngines([{ detect: () => ({}) }])).length === 0 && Object.keys(detectEngines([{ detect: () => ({ pdf: null, ocr: null }) }])).join() === 'pdf,ocr');

console.log('the real engines');
{
  const map = detectEngines();
  expect('the keys are the same seven', Object.keys(map).join() === KEYS.join(), Object.keys(map).join());
  expect('each is a path or null', Object.values(map).every((v) => v === null || typeof v === 'string'));
  expect('getEngines() returns that same object', getEngines() === map);
  expect('FFmpeg and 7-Zip ship with Pomelo, so they are always found', !!map.ffmpeg && !!map.sevenZip);
}

finish();

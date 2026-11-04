// SPDX-License-Identifier: AGPL-3.0-or-later
// Pins which engines handle each (from, to) pair, in the order convertFile tries them, and what the wheel offers per extension,
// under 9 engine combinations. A routing change has to show up in routing.snapshot.json on purpose.
//   node test/unit/conversion/routing.test.js [--update]
const fs = require('fs');
const path = require('path');
const { plansFor } = require('../../../src/main/convert');
const { ALIASES, TARGET_ORDER, targetsForFiles } = require('../../../src/main/formats');
const { expect } = require('../../support/expect');
const finish = require('../../support/finish');

const FILE = path.join(__dirname, 'routing.snapshot.json');
const KEYS = ['soffice', 'pandoc', 'pdf', 'ocr', 'heic', 'ffmpeg', 'sevenZip'];
const CASES = { all: [], none: KEYS, ...Object.fromEntries(KEYS.map((k) => [`without-${k}`, [k]])) };
const FROMS = Object.keys(TARGET_ORDER).sort();
const TOS = [...new Set(Object.values(TARGET_ORDER).flat())].sort();     // video and audio reach targets that no wheel lists for them

function build() {
  const cases = {};
  for (const [name, missing] of Object.entries(CASES)) {
    const engines = Object.fromEntries(KEYS.map((k) => [k, !missing.includes(k)]));
    const plans = {};
    for (const from of FROMS) {
      for (const to of TOS) {
        const found = from === to ? [] : plansFor(from, to, engines);
        if (found.length) plans[`${from}>${to}`] = found.map((plan) => plan.map((s) => `${s.engine.name}:${s.from}>${s.to}`).join(' + '));
      }
    }
    const wheel = {};
    for (const ext of [...FROMS, ...Object.keys(ALIASES)]) wheel[ext] = targetsForFiles([`x.${ext}`], (f, t) => plansFor(f, t, engines).length > 0).map((t) => t.id);
    cases[name] = { engines, pairs: Object.keys(plans).length, plans, wheel };
  }
  return cases;
}

const differing = (now, then) => [...new Set([...Object.keys(now), ...Object.keys(then)])].filter((k) => JSON.stringify(now[k]) !== JSON.stringify(then[k]));

const now = build();
const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));

if (process.argv.includes('--update')) {
  fs.writeFileSync(FILE, JSON.stringify({ ...saved, cases: now }, null, 2) + '\n');
  console.log(`updated ${path.relative(process.cwd(), FILE)}. Set "generatedFrom" to the commit you made it at.`);
} else {
  console.log('routing snapshot');
  for (const name of Object.keys(CASES)) {
    const then = saved.cases[name] || { plans: {}, wheel: {} };
    const bad = differing(now[name].plans, then.plans);
    expect(`${name}: ${now[name].pairs} convertible pairs, same engines in the same order`, bad.length === 0, bad.slice(0, 5).join(', '));
    const wheel = differing(now[name].wheel, then.wheel);
    expect(`${name}: the wheel offers the same targets for ${Object.keys(now[name].wheel).length} extensions`, wheel.length === 0, wheel.slice(0, 5).join(', '));
  }
  expect('the snapshot holds exactly these engine combinations', Object.keys(saved.cases).join() === Object.keys(CASES).join());
}
finish();

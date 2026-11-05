// SPDX-License-Identifier: AGPL-3.0-or-later
// What Pomelo does when an in-app update starts it again: say how it went, add the engines the new version expects, show them in
// the Downloader window and close it.   node test/unit/updates/post-update.test.js
const { reportUpdate, updatedStart } = require('../../../src/features/updates/post-update');
const { expect } = require('../../support/expect');
const finish = require('../../support/finish');

// Everything reportUpdate is handed, recorded.
function setup({ argv, current = '0.2.0', missing = [], add = async () => ({ ok: true }) }) {
  const t = { toasts: [], states: [], shown: [], closed: 0, cleaned: 0, logs: [], added: [] };
  const run = () => reportUpdate({
    argv, current, log: (...a) => t.logs.push(a.join(' ')), cleanup: () => { t.cleaned++; }, sleep: async () => {},
    notify: (m) => t.toasts.push(m),
    ui: { show: (o) => t.shown.push(o), update: (s) => t.states.push(s), close: () => { t.closed++; } },
    engines: { missing: () => missing, add: (key, note) => { t.added.push(key); return add(key, note); } },
  });
  return { t, run };
}

(async () => {
  console.log('which starts follow an update');
  expect('an ordinary start does not', !updatedStart(['Pomelo.exe', '--hidden'], '0.2.0'));
  expect('--updated alone does', updatedStart(['--updated'], '0.2.0'));
  expect('--updated with the running version does', updatedStart(['--updated=0.2.0'], '0.2.0'));
  expect('--updated with another version does not (the old one is still running)', !updatedStart(['--updated=0.3.0'], '0.2.0'));

  console.log('a normal start');
  let s = setup({ argv: ['Pomelo.exe', '--hidden'] });
  expect('does nothing', (await s.run()) === false && !s.t.toasts.length && !s.t.cleaned);

  console.log('an update that landed, with nothing to add');
  s = setup({ argv: ['--hidden', '--updated=0.2.0'] });
  expect('reports it', (await s.run()) === true);
  expect('removes the downloaded installer', s.t.cleaned === 1);
  expect('one toast: the new version', s.t.toasts.length === 1 && s.t.toasts[0].title === 'Pomelo is now on version 0.2.0' && s.t.toasts[0].detail === 'The update is installed.', JSON.stringify(s.t.toasts));
  expect('the Downloader window is not opened', !s.t.shown.length && !s.t.states.length);

  console.log('an update that did not land');
  s = setup({ argv: ['--updated=0.3.0'], missing: [{ key: 'ocr', label: 'OCR' }] });
  await s.run();
  expect('says so and adds nothing', /could not be installed/.test(s.t.toasts[0].title) && /still on version 0\.2\.0/.test(s.t.toasts[0].detail) && !s.t.added.length);
  expect('still removes the installer', s.t.cleaned === 1);

  console.log('an update that adds an engine');
  const python = { key: 'ocr', label: 'PDF, OCR and HEIC components' };
  s = setup({ argv: ['--hidden', '--updated=0.2.0'], missing: [python], add: async (key, note) => { note('Creating a private Python environment…', 0.05); note('pip says something'); note('Checking the components…', 0.85); return { ok: true }; } });
  await s.run();
  const engineStates = s.t.states.filter((x) => x.phase === 'engines');
  expect('the window opens without taking focus', s.t.shown.length === 1 && s.t.shown[0].inactive === true);
  expect('the engine is installed by its key', s.t.added.join() === 'ocr');
  expect('the window starts with no figure, then follows the engine', engineStates[0].fraction === undefined && engineStates.some((x) => x.fraction === 0.05) && engineStates.at(-1).fraction === 0.85, JSON.stringify(engineStates.map((x) => x.fraction)));
  expect('a note from the engine with no figure keeps the last one', engineStates.some((x) => x.note === 'pip says something' && x.fraction === 0.05));
  expect('both versions in the window are the new one', engineStates.every((x) => x.current === '0.2.0' && x.latest === '0.2.0'));
  expect('then "done", then the window closes by itself', s.t.states.at(-1).phase === 'done' && /Added PDF, OCR and HEIC components/.test(s.t.states.at(-1).message) && s.t.closed === 1);
  expect('the toast says what was added', s.t.toasts.length === 1 && s.t.toasts[0].detail === 'The update is installed. Added PDF, OCR and HEIC components.', JSON.stringify(s.t.toasts));

  console.log('an engine that cannot be added');
  s = setup({ argv: ['--updated=0.2.0'], missing: [python], add: async () => ({ ok: false, message: 'No internet' }) });
  await s.run();
  expect('the window stays, saying what is left to do', s.t.closed === 0 && s.t.states.at(-1).phase === 'done' && /Updated, with one thing left/.test(s.t.states.at(-1).title) && /Settings, Advanced/.test(s.t.states.at(-1).message), JSON.stringify(s.t.states.at(-1)));
  expect('the toast says the update is in and what failed', s.t.toasts[0].title === 'Pomelo is now on version 0.2.0' && /could not be added/.test(s.t.toasts[0].detail));
  expect('the failure is logged', s.t.logs.some((l) => /failed: No internet/.test(l)));

  s = setup({ argv: ['--updated=0.2.0'], missing: [python], add: async () => { throw new Error('boom'); } });
  await s.run();
  expect('an install that throws is treated as a failed one', /could not be added/.test(s.t.toasts[0].detail));

  finish();
})();

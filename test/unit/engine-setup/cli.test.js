// SPDX-License-Identifier: AGPL-3.0-or-later
// The installer's headless switches, with a fake installer: nothing is installed or removed.   node test/unit/engine-setup/cli.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parse, run, fileProgress } = require('../../../src/features/engine-setup/cli');

const { expect, failed } = require('../../support/expect');
const finish = require('../../support/finish');

// A fake installer: `failing` lists the engine keys that fail.
const fake = (failing = [], removalFails = []) => {
  const calls = [];
  return {
    calls,
    install: async (key) => { calls.push(`install ${key}`); return failing.includes(key) ? { ok: false, message: 'boom' } : { ok: true }; },
    uninstall: async () => { calls.push('uninstall'); return { removed: [], failed: removalFails }; },
  };
};

(async () => {
  console.log('reading the command line');
  expect('a normal start is not headless', parse(['Pomelo.exe', '--hidden']) === null);
  const parsed = parse(['Pomelo.exe', '--install-engines=pdf, soffice,pandoc']);
  expect('install list', parsed.action === 'install' && parsed.keys.join() === 'pdf,soffice,pandoc');
  expect('empty install list', parse(['--install-engines=']).keys.length === 0);
  expect('uninstall', parse(['--uninstall-engines']).action === 'uninstall');

  console.log('installing');
  let installer = fake();
  let code = await run({ action: 'install', keys: ['pdf', 'ocr', 'heic', 'soffice', 'pandoc'] }, { installer, setLoginItem: () => {}, say: () => {} });
  expect('installs each engine once (PDF, OCR and HEIC are one install)', installer.calls.join() === 'install pdf,install soffice,install pandoc', installer.calls.join());
  expect('exit code 0', code === 0);

  const said = [];
  installer = fake(['soffice']);
  code = await run({ action: 'install', keys: ['soffice', 'pandoc'] }, { installer, setLoginItem: () => {}, say: (l) => said.push(l) });
  expect('one failure does not stop the others', installer.calls.join() === 'install soffice,install pandoc');
  expect('exit code 1 and the reason is printed', code === 1 && said.includes('soffice: boom'));

  code = await run({ action: 'install', keys: ['nonsense'] }, { installer: { install: async () => ({ ok: false, message: 'Unknown engine' }) }, setLoginItem: () => {}, say: () => {} });
  expect('an unknown engine name fails', code === 1);
  code = await run({ action: 'install', keys: [] }, { installer: fake(), setLoginItem: () => {}, say: () => {} });
  expect('nothing selected: nothing to do', code === 0);

  console.log('progress for the wizard');
  expect('--progress-file is read from the command line', parse(['--install-engines=pandoc', '--progress-file=C:\\a b\\p.txt']).progressFile === 'C:\\a b\\p.txt' && parse(['--uninstall-engines']).progressFile === null);
  {
    const file = path.join(os.tmpdir(), `pomelo-progress-${process.pid}.txt`);
    const seen = [];
    const write = fileProgress(file);
    const installer = {
      install: async (key, note) => { note(`Downloading ${key}…`, 0.5); note('  ██▒▒ 45%  ünïcode', undefined); seen.push(fs.readFileSync(file, 'utf8')); return key === 'pandoc' ? { ok: false, message: 'boom' } : { ok: true }; },
    };
    await run({ action: 'install', keys: ['pdf', 'pandoc'] }, { installer, setLoginItem: () => {}, say: () => {}, progress: write });
    const field = (text, name) => (new RegExp(`^${name}=(.*)$`, 'm').exec(text) || [])[1];
    expect('shows which engine is being installed, out of how many', field(seen[0], 'text') === 'Installing PDF, OCR and HEIC components (1 of 2)', field(seen[0], 'text'));
    expect('the bar is a fraction of the weighted total, between 0 and 1000', +field(seen[0], 'permille') > 0 && +field(seen[0], 'permille') < 1000, field(seen[0], 'permille'));
    expect('the detail line is plain ASCII (no block characters)', /^[\x20-\x7e]*$/.test(field(seen[0], 'detail')) && /45%/.test(field(seen[0], 'detail')), field(seen[0], 'detail'));
    expect('the bar moves on as engines complete', +field(seen[1], 'permille') > +field(seen[0], 'permille'));
    const last = fs.readFileSync(file, 'utf8');
    expect('the end is marked done at 100% and names what failed', field(last, 'done') === '1' && field(last, 'permille') === '1000' && field(last, 'failed') === 'Pandoc', last.replace(/\n/g, ' | '));
    expect('no half-written temp file is left', !fs.existsSync(`${file}.tmp`));
    fs.rmSync(file, { force: true });
    expect('no progress file given: no file, no error', typeof fileProgress(null) === 'function' && fileProgress(null)({ fraction: 0, text: '' }) === undefined);
  }

  console.log('uninstalling');
  let login = 'unset', menu = 'unset';
  installer = fake();
  code = await run({ action: 'uninstall' }, { installer, setLoginItem: (v) => { login = v; }, removeShellMenu: async () => { menu = 'removed'; }, say: () => {} });
  expect('switches off Start with Windows and removes the engines', login === false && installer.calls.join() === 'uninstall' && code === 0);
  expect('and takes the right-click menu entries out', menu === 'removed');
  code = await run({ action: 'uninstall' }, { installer: fake([], ['Pandoc']), setLoginItem: () => {}, say: (l) => said.push(l) });
  expect('a removal that fails is reported, exit code 1', code === 1 && said.some((l) => /Could not remove Pandoc/.test(l)));

  console.log(failed() ? `\n${failed()} failed` : '\nall passed');
  finish();
})();

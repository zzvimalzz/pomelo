// SPDX-License-Identifier: AGPL-3.0-or-later
// Uninstall planning and hand-over with fakes: nothing real is removed or started.   node test/unit/uninstall/uninstall.test.js
const fs = require('fs');
const path = require('path');
const { plan, confirmText, uninstall } = require('../../../src/features/uninstall/uninstall');
const { createInstaller } = require('../../../src/features/engine-setup/installer');

const { expect, failed } = require('../../support/expect');
const finish = require('../../support/finish');
const { dir: tmpDir } = require('../../support/tmp');
const tmp = () => tmpDir('un');

(async () => {
  const root = path.join(tmp(), 'Pomelo', 'engines');
  fs.mkdirSync(path.join(root, 'pyenv'), { recursive: true });
  fs.mkdirSync(path.join(root, 'libreoffice', 'program'), { recursive: true });
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ pyenv: true, soffice: true, winget: [{ id: 'Python.Python.3.12', name: 'Python' }] }));
  const winget = [];
  const installer = createInstaller({ root, run: async (cmd, args) => { winget.push([cmd, ...args]); return { code: 0, out: '' }; } });

  console.log('what the confirmation says');
  const p = plan(installer);
  expect('lists only what Pomelo installed', p.engines.join() === 'PDF, OCR and HEIC components,LibreOffice,Python', p.engines.join());
  const text = confirmText(p);
  expect('says user-installed software and converted files are safe', /installed yourself is left alone/.test(text) && /converted files are never touched/.test(text));
  expect('nothing installed by Pomelo -> no engine list', !/Also removed/.test(confirmText({ engines: [] })));

  console.log('installed with the installer: the Windows uninstaller does the work');
  const unins = path.join(tmp(), 'unins000.exe');
  const started = []; let login = 'unset';
  const r = await uninstall({ installer, uninstaller: unins, setLoginItem: (v) => { login = v; }, spawnDetached: (...a) => started.push(a) });
  expect('starts unins000.exe with its progress window and nothing else (no cmd, no ping)', r.launched && started.length === 1 && started[0][0] === unins && started[0][1].join() === '/SILENT', JSON.stringify(started));
  expect('leaves the engines and Start with Windows to that uninstaller (it runs --uninstall-engines)', login === 'unset' && winget.length === 0 && fs.existsSync(path.join(root, 'pyenv')));

  console.log('running from source: no installer, so the engines go right away');
  const rootB = path.join(tmp(), 'Pomelo', 'engines');
  fs.mkdirSync(path.join(rootB, 'libreoffice'), { recursive: true });
  fs.writeFileSync(path.join(rootB, 'manifest.json'), JSON.stringify({ pyenv: false, soffice: true, winget: [] }));
  const s2 = [];
  let menuRemoved = false;
  const q = await uninstall({ installer: createInstaller({ root: rootB, run: async () => ({ code: 0, out: '' }) }), uninstaller: null, setLoginItem: (v) => { login = v; }, removeShellMenu: async () => { menuRemoved = true; }, spawnDetached: (...a) => s2.push(a) });
  expect('removes the engines, the right-click menu and Start with Windows, starts nothing', !q.launched && q.engines.removed.join() === 'LibreOffice' && login === false && menuRemoved && s2.length === 0 && !fs.existsSync(rootB));
  expect('and does not leave an empty Pomelo folder behind', !fs.existsSync(path.dirname(rootB)));
  const rootC = path.join(tmp(), 'Pomelo', 'engines');
  fs.mkdirSync(rootC, { recursive: true });
  fs.writeFileSync(path.join(path.dirname(rootC), 'something-else.txt'), 'keep me');
  await createInstaller({ root: rootC, run: async () => ({ code: 0, out: '' }) }).uninstall();
  expect('but never deletes a Pomelo folder that holds anything else', fs.existsSync(path.join(path.dirname(rootC), 'something-else.txt')));

  console.log(failed() ? `\n${failed()} failed` : '\nall passed');
  finish();
})();

// SPDX-License-Identifier: AGPL-3.0-or-later
// Builds the private Python environment for real in a temp folder and removes it again. Needs Python 3.9 to 3.13 and downloads
// about 60 MB, so it runs in the nightly tier only.   node test/run.js --tier=nightly
const fs = require('fs');
const path = require('path');
const { createInstaller } = require('../../../src/main/engineInstaller');
const { expect, failed } = require('../../support/expect');
const finish = require('../../support/finish');
const tmp = require('../../support/tmp');

(async () => {
  console.log('real private Python environment');
  const root = tmp.dir('real');
  const inst = createInstaller({ root, redetect: () => ({ pdf: 'ok', ocr: 'ok', heic: 'ok' }) });
  const r = await inst.install('pdf', (n) => process.stdout.write(`    ${n}\n`));
  expect('creates the environment and the packages import', r.ok && fs.existsSync(path.join(root, 'pyenv', 'Scripts', 'python.exe')), r.message || '');
  const u = await inst.uninstall();
  expect('and removes it again', !fs.existsSync(root) && u.failed.length === 0, JSON.stringify(u));

  console.log(failed() ? `\n${failed()} failed` : '\nall passed');
  finish();
})();

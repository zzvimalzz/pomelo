// SPDX-License-Identifier: AGPL-3.0-or-later
// Starts the real app (src/app/main.js) hidden, with its own user-data folder, and waits for the "ready" line in its debug log:
// every feature was created and wired without an error. Then it stops the app.
//
// Starting Pomelo applies the "Start with Windows" setting, which writes (or removes) the login entry of the Electron app that is
// running. On a developer PC that is the developer's own entry, so this runs only on CI, or when asked for with --i-understand.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { APP_ROOT } = require('../../../src/shared/node/paths');
const { expect } = require('../../support/expect');
const finish = require('../../support/finish');
const tmp = require('../../support/tmp');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!process.env.CI && !process.argv.includes('--i-understand')) {
    console.log('  starting the app changes "Start with Windows" on this PC; it runs on CI, or here with --i-understand: skipped');
    return finish(0);
  }
  console.log('the app starts');
  const dir = tmp.dir('app');
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ openAtLogin: false }));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [APP_ROOT, '--hidden', `--user-data-dir=${dir}`], { env, stdio: 'ignore' });
  const logFile = path.join(dir, 'debug.log');
  const text = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '');
  let ready = false;
  for (let t = 0; t < 60000 && !ready && child.exitCode === null; t += 250) {
    await sleep(250);
    ready = /\bready\b/.test(text());
  }
  expect('the log says ready (all features were created and connected)', ready, text().split('\n').slice(-4).join(' | '));
  expect('and it announced the version and the build', /--- started v\d+\.\d+\.\d+ build [0-9a-f]{12}/.test(text()));
  expect('the app is still running', child.exitCode === null);
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  await sleep(500);
  finish();
})();

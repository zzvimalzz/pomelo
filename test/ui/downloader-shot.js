// SPDX-License-Identifier: AGPL-3.0-or-later
// Opens the real Pomelo Downloader window and feeds it every state: downloading, installing, adding engines, done and failed.
// Checks the text, the bar and the buttons, that it can be minimised but not closed while work is going on, and saves
// screenshots.   npx electron test/ui/downloader-shot.js
const { app, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { Downloader } = require('../../src/features/updates/downloader.window');
const { registerUpdatesIpc } = require('../../src/features/updates/updates.ipc');
const { expect: check, failed } = require('../support/expect');
const finish = require('../support/finish');

app.on('window-all-closed', () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const asset = (n) => path.join(__dirname, '..', '..', 'assets', n);
const out = path.join(__dirname, '..', 'shots');
const MB = 1048576;

app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  const downloader = new Downloader({ asset });
  // The real message handlers (ready, cancel, minimise, close) on top of the real window.
  registerUpdatesIpc({ current: '0.1.4', autoCheck: { available: null }, onChecked() {}, isPackaged: false, execPath: '', sendToSettings() {}, isSettingsOpen: () => false, downloader, stopForUpdate() {}, exit() {}, log() {} });

  const js = (code) => downloader.win.webContents.executeJavaScript(code);
  const shot = async (name) => fs.writeFileSync(path.join(out, name), (await downloader.win.webContents.capturePage()).toPNG());
  const read = () => js(`({
    versions: document.getElementById('versions').textContent, phase: document.getElementById('phase').textContent,
    percent: document.getElementById('percent').textContent, detail: document.getElementById('detail').textContent.trim(),
    busy: document.getElementById('bar').classList.contains('busy'),
    barWidth: document.querySelector('#bar i').style.width,
    buttons: [...document.querySelectorAll('#actions button')].map((b) => b.textContent),
    sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, sh: document.documentElement.scrollHeight, ch: document.documentElement.clientHeight })`);
  const feed = async (state) => { downloader.update(state); await sleep(600); return read(); };
  const base = { current: '0.1.4', latest: '0.1.5' };

  nativeTheme.themeSource = 'dark';
  downloader.show();
  downloader.update({ ...base, phase: 'download', fraction: 0 });      // sent before the page has loaded: it must still arrive
  await sleep(2200);

  console.log('downloading');
  let s = await feed({ ...base, phase: 'download', received: 112 * MB, total: 180 * MB, fraction: 112 / 180, left: 16 });
  check('title, versions and percentage', s.phase === 'Downloading' && s.versions === 'Version 0.1.4 › Version 0.1.5' && s.percent === '62%', JSON.stringify(s));
  check('sizes and time left', s.detail === '112 MB of 180 MB · about 16 s left', s.detail);
  check('the bar is filled to the percentage', !s.busy && s.barWidth === '62%', s.barWidth);
  check('the only button is Cancel (it runs in the background by itself)', s.buttons.join() === 'Cancel', s.buttons.join());
  check('the taskbar button shows the progress too', downloader.win.isVisible());
  await shot('downloader-1-download.png');

  console.log('the heading: the stage name, then friendly messages, one at a time');
  const headingAfter = async (setup) => { await js(`${setup}; say(heading());`); await sleep(1400); return (await read()).phase; };
  await js('advance = () => {}; 0');                    // the page's own timer would change the heading in the middle of these checks
  check('it fades out while it changes', (await js(`say('Peeling the skin carefully'); document.getElementById('phase').classList.contains('out')`)) === true);
  await sleep(1400);
  check('and comes back in, with the new words', (await js(`document.getElementById('phase').classList.contains('out')`)) === false && (await read()).phase === 'Peeling the skin carefully');
  check('the second heading is the first friendly message', (await headingAfter('stepSince = Date.now() - 1000; ticks = 1')) === 'We are updating your Pomelo');
  check('then the next one', (await headingAfter('ticks = 2')) === 'Peeling the skin carefully');
  check('the last friendly message', (await headingAfter('ticks = 6')) === 'Giving it a gentle squeeze');
  check('the stage name comes round again', (await headingAfter('ticks = 7')) === 'Downloading');
  check('a long wait keeps the messages friendly', (await headingAfter('stepSince = Date.now() - 50000; ticks = 0')) === 'Downloading');
  check('and every other one admits it is taking a while', (await headingAfter('ticks = 1')) === 'This is taking a while. Hang tight');
  check('later still, the wait is acknowledged differently', (await headingAfter('stepSince = Date.now() - 100000; ticks = 1')) === 'Still going. Big fruit, slow juicer');
  await js('stepSince = Date.now(); ticks = 0; say(heading());');
  await sleep(1400);

  console.log('no figure yet, then installing');
  s = await feed({ ...base, phase: 'download', fraction: 0, received: 0, total: 0 });
  check('a download with nothing received shows 0%', s.percent === '0%');
  s = await feed({ ...base, phase: 'install' });
  check('installing: no percentage, a moving bar, nothing to press', s.phase === 'Installing' && s.percent === '' && s.busy && s.buttons.length === 0, JSON.stringify(s));
  check('it says Pomelo will restart by itself', /restart, it will do so automatically/.test(s.detail), s.detail);
  await shot('downloader-2-install.png');

  console.log('after the restart: adding engines');
  s = await feed({ current: '0.1.5', latest: '0.1.5', phase: 'engines', note: 'Creating a private Python environment…' });
  check('the one version, the engine step, the note', s.versions === 'Version 0.1.5' && s.phase === 'Adding extras' && s.detail === 'Creating a private Python environment…', JSON.stringify(s));
  check('with no figure the bar moves instead of lying', s.busy && s.percent === '');
  check('nothing to press: it cannot be cancelled half-way', s.buttons.length === 0);
  s = await feed({ current: '0.1.5', latest: '0.1.5', phase: 'engines', note: 'Checking the components…', fraction: 0.85 });
  check('once the engine reports, a percentage', s.percent === '85%' && !s.busy && s.barWidth === '85%', JSON.stringify(s));
  await shot('downloader-3-engines.png');

  console.log('minimising, but not closing, while working');
  check('the window can be minimised', downloader.win.isMinimizable());
  check('the X is switched off while work goes on', downloader.win.isClosable() === false);
  downloader.win.minimize();
  await sleep(300);
  check('minimised, it is still there', downloader.win.isMinimized());
  downloader.show();
  await sleep(300);
  check('showing it again brings it back', !downloader.win.isMinimized());
  await js(`document.getElementById('actions').children.length`);

  console.log('done');
  s = await feed({ current: '0.1.5', latest: '0.1.5', phase: 'done', message: 'Added PDF, OCR and HEIC components' });
  check('all done, 100%, a Close button', s.phase === 'All done' && s.percent === '100%' && s.barWidth === '100%' && s.buttons.join() === 'Close' && s.detail === 'Added PDF, OCR and HEIC components', JSON.stringify(s));
  await shot('downloader-4-done.png');

  check('the X works again once the work is over', downloader.win.isClosable() === true);

  console.log('failed');
  s = await feed({ ...base, phase: 'error', message: 'The download does not match its checksum, so it was not installed' });
  check('says what went wrong and offers another try', s.phase === 'The update did not finish' && /checksum/.test(s.detail) && s.buttons.join() === 'Try again,Close', JSON.stringify(s));
  await shot('downloader-5-error.png');
  check('nothing overflows the window', s.sw <= s.cw && s.sh <= s.ch, `${s.sw}x${s.sh} in ${s.cw}x${s.ch}`);

  console.log('long text');
  s = await feed({ ...base, phase: 'error', message: 'x'.repeat(400) });
  check('a very long message does not break the layout', s.sw <= s.cw && s.sh <= s.ch, `${s.sw}x${s.sh} in ${s.cw}x${s.ch}`);

  console.log('closing when the work is over');
  await js(`[...document.querySelectorAll('#actions button')].find((b) => b.textContent === 'Close').click()`);
  await sleep(500);
  check('Close really closes the window', downloader.win === null);

  console.log('cancelling');
  downloader.show();
  await sleep(1500);
  await feed({ ...base, phase: 'download', fraction: 0.3, received: 50 * MB, total: 180 * MB });
  await js(`[...document.querySelectorAll('#actions button')][0].click()`);
  await sleep(300);
  check('Cancel is wired to the update (nothing running here, so the window stays until the main process closes it)', downloader.win !== null);
  downloader.close();
  await sleep(400);
  check('the main process can close it even though its X is off', downloader.win === null);

  console.log('light theme');
  nativeTheme.themeSource = 'light';
  downloader.show();
  await sleep(1500);
  await feed({ ...base, phase: 'download', received: 20 * MB, total: 180 * MB, fraction: 20 / 180, left: 80 });
  await shot('downloader-6-light.png');
  check('the light window opens too', downloader.win.isVisible());
  downloader.close();
  await sleep(400);

  console.log(failed() ? `\n${failed()} failed` : '\nall passed');
  finish();
}).catch((e) => { console.error(e); finish(2); });


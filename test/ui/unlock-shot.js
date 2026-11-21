// SPDX-License-Identifier: AGPL-3.0-or-later
// The real wheel page turning into the password card: the morph, a wrong and a right password, several files, a protection that is
// not supported, Esc, and the light and dark looks. The main process is played by this script.
//   npx electron test/ui/unlock-shot.js
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { targetsForFiles } = require('../../src/features/conversion/catalog/formats');
const { expect: check } = require('../support/expect');
const finish = require('../support/finish');

app.on('window-all-closed', () => {});
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
const out = path.join(__dirname, '..', 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  const win = new BrowserWindow({ width: 400, height: 464, x: 200, y: 200, frame: false, transparent: true, skipTaskbar: true, alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, '..', '..', 'src', 'features', 'gesture', 'ui', 'preload.js'), contextIsolation: true, sandbox: true } });
  await win.loadFile(path.join(__dirname, '..', '..', 'src', 'features', 'gesture', 'ui', 'wheel.html'));
  const run = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => fs.writeFileSync(path.join(out, name), await sharp((await win.webContents.capturePage()).toPNG()).flatten({ background: '#d9d6d0' }).toBuffer());

  let cancels = 0;
  const requests = [];
  let answer = () => ({ state: 'wrong' });
  ipcMain.on('wheel:cancel', () => { cancels++; });
  ipcMain.handle('wheel:unlock', (_e, request) => { requests.push(request); return answer(request); });

  const type = (text) => run(`(() => { const f = document.getElementById('pw'); f.value = ${JSON.stringify(text)}; f.dispatchEvent(new Event('input')); })()`);
  const click = (id) => run(`document.getElementById(${JSON.stringify(id)}).click()`);
  const text = (selector) => run(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
  const press = (key) => run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }))`);
  const enterOnField = () => run(`document.getElementById('pw').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);

  const FILE = (name, ext, group, kind = 'needed') => ({ token: `${name}-token`, kind, name, ext, group });
  const open = async (files, early) => {
    win.webContents.send('wheel:open', { info: { name: files[0].name, ext: files[0].ext, group: files[0].group, count: files.length }, targets: targetsForFiles(['x.pdf'], () => true), wheel: 'convert' });
    await sleep(500);
    win.webContents.send('wheel:unlock-open', { files });
    if (early) { await sleep(60); await early(); }
    await sleep(900);
  };

  for (const scheme of ['light', 'dark']) {
    nativeTheme.themeSource = scheme;
    console.log(`one protected file (${scheme})`);
    requests.length = 0; cancels = 0;
    await open([FILE('Quarterly report.pdf', 'pdf', 'pdf')], async () => {
      await type('hunter2');
      await enterOnField();
    });
    check('Enter in the first moments sends nothing', requests.length === 0);
    check('the card replaces the wheel', (await run(`document.getElementById('stage').classList.contains('asking') && !!document.getElementById('ucard')`)) === true);
    check('it says the file is password protected and names it', (await text('#ut')) === 'Password protected' && (await text('.ut span')) === 'Quarterly report.pdf');
    check('the field has the focus', (await run(`document.activeElement.id === 'pw'`)) === true);
    check('the card is inside the 400 px window', (await run(`(() => { const b = document.getElementById('ucard').getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight; })()`)) === true);
    await shot(`unlock-${scheme}-ask.png`);

    await run(`document.getElementById('pw').focus()`);
    answer = () => ({ state: 'wrong' });
    await enterOnField();
    await sleep(300);
    check('Enter after that sends the password for that file', requests.length === 1 && requests[0].password === 'hunter2' && requests[0].token === 'Quarterly report.pdf-token' && requests[0].all === false, JSON.stringify(requests));
    check('a wrong password says so and the button reads Try Again', (await text('.emsg p')) === 'Wrong Password' && (await text('#go')) === 'Try Again');
    check('the card stays open', cancels === 0);
    await shot(`unlock-${scheme}-wrong.png`);

    await type('pomelo');
    answer = () => ({ state: 'ok', done: ['Quarterly report.pdf-token'], mismatch: false });
    await click('go');
    await sleep(900);
    check('the right password closes the card', cancels === 1, `cancels ${cancels}`);

    console.log(`Esc (${scheme})`);
    await open([FILE('Notes.pdf', 'pdf', 'pdf')]);
    await press('Escape');
    check('Esc closes the card', cancels === 2, `cancels ${cancels}`);
  }

  console.log('several protected files');
  nativeTheme.themeSource = 'light';
  requests.length = 0; cancels = 0;
  const three = [FILE('Report.pdf', 'pdf', 'pdf'), FILE('Contract.docx', 'docx', 'doc'), FILE('Board notes.pdf', 'pdf', 'pdf')];
  await open(three);
  check('a tray shows a tile for each file', (await run(`document.querySelectorAll('.tray .tile').length`)) === 3 && (await run(`document.querySelectorAll('.tile.on').length`)) === 1);
  check('there is a "Same for all" switch, on', (await run(`document.getElementById('ucard').querySelector('.sw')?.getAttribute('aria-checked')`)) === 'true');
  await shot('unlock-light-batch.png');
  await type('pomelo');
  answer = () => ({ state: 'ok', done: ['Report.pdf-token', 'Contract.docx-token'], mismatch: true });
  await click('go');
  await sleep(1100);
  check('the password was offered for all of them', requests[0].all === true);
  check('the file that did not fit is left, with a short line', (await text('.ut span')) === 'Board notes.pdf' && (await text('.emsg p')) === 'Different password needed', await text('.ut span'));
  check('and the switch is gone, as one file is left', (await run(`!document.querySelector('.sw')`)) === true);
  await shot('unlock-light-batch-left.png');
  await type('other');
  answer = () => ({ state: 'ok', done: ['Board notes.pdf-token'], mismatch: false });
  await click('go');
  await sleep(900);
  check('the last one closes the card', cancels === 1, `cancels ${cancels}`);

  console.log('not supported');
  await open([FILE('Lease.odt', 'odt', 'doc', 'unsupported')]);
  check('a protection that cannot be opened has no field', (await text('#ut')) === "Can't open this file" && (await run(`!document.getElementById('pw')`)) === true);
  check('it says why', (await text('.emsg p')) === "OpenDocument passwords aren't supported");
  await shot('unlock-light-unsupported.png');
  await run(`document.querySelector('.urow .btn').click()`);
  await sleep(100);
  check('OK closes it', cancels === 2, `cancels ${cancels}`);

  console.log('a long name');
  await open([FILE('Q3 consolidated financial statements final v2 (signed).pdf', 'pdf', 'pdf')]);
  check('is shortened in the middle', /…/.test(await text('.ut span')) && (await text('.ut span')).length <= 30, await text('.ut span'));
  await shot('unlock-light-long.png');

  console.log('where the card is');
  const cards = [];
  ipcMain.on('wheel:card', (_e, rect) => cards.push(rect));
  await open([FILE('Report.pdf', 'pdf', 'pdf')]);
  const box = await run(`(() => { const c = document.getElementById('ucard'); return { x: c.offsetLeft, width: c.offsetWidth, height: c.offsetHeight }; })()`);
  const last = cards[cards.length - 1];
  check('the page tells the main process where the card is, at its full size', !!last && last.width === box.width && last.height === box.height && last.x > 0 && last.y > 0 && last.x + last.width < 400 && last.y + last.height < 464, JSON.stringify([last, box]));
  const region = (sel) => run(`getComputedStyle(document.querySelector(${JSON.stringify(sel)})).webkitAppRegion`);
  check('the whole card moves the window, the title row and its edges included', (await region('.ucard')) === 'drag');
  check('and the field, the message and the buttons do not', (await region('.fwrap')) === 'no-drag' && (await region('.urow')) === 'no-drag' && (await region('.emsg')) === 'no-drag');
  await press('Escape');

  console.log('files dragged over the card');
  await open([FILE('Report.pdf', 'pdf', 'pdf')]);
  const offered = await run(`(() => { const e = new Event('dragover', { cancelable: true }); e.dataTransfer = { dropEffect: '' }; window.dispatchEvent(e); return e.dataTransfer.dropEffect; })()`);
  check('the card takes no files: a drag over it is refused', offered === 'none', offered);
  cancels = 0;
  await press('Escape');

  console.log('the wheel again');
  win.webContents.send('wheel:open', { info: { name: 'a.pdf', ext: 'pdf', group: 'pdf', count: 1 }, targets: targetsForFiles(['x.pdf'], () => true), wheel: 'convert' });
  await sleep(700);
  check('a new wheel replaces the card', (await run(`!document.getElementById('ucard') && !document.getElementById('stage').classList.contains('asking') && document.querySelectorAll('.seg').length > 1`)) === true);

  finish();
});

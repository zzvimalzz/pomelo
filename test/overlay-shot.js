// SPDX-License-Identifier: AGPL-3.0-or-later
// Renders the real wheel page with sample data: segments, hover, drop-target behaviour, and per-kind icon colours.
//   npx electron test/overlay-shot.js
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { targetsForFiles } = require('../src/main/formats');

app.on('window-all-closed', () => {});
const out = path.join(__dirname, 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const check = (name, ok, extra = '') => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); };

app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  const win = new BrowserWindow({ width: 400, height: 400, x: 200, y: 200, frame: false, transparent: true, focusable: false, skipTaskbar: true, alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'preload', 'overlay.js'), contextIsolation: true, sandbox: true } });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'overlay.html'));
  const shot = async (name) => fs.writeFileSync(path.join(out, name), await sharp((await win.webContents.capturePage()).toPNG()).flatten({ background: '#d9d6d0' }).toBuffer());
  const dragover = (x, y) => win.webContents.executeJavaScript(`(() => { const e = new Event('dragover', { cancelable: true }); e.clientX = ${x}; e.clientY = ${y}; e.dataTransfer = { dropEffect: '' }; window.dispatchEvent(e); return e.dataTransfer.dropEffect; })()`);
  const segments = () => win.webContents.executeJavaScript(`document.querySelectorAll('.seg').length`);

  // pretend every engine is present, so the wheel shows its full 8 segments
  const everything = () => true;
  for (const [file, info] of [
    ['docx', { name: 'Quarterly report final.docx', ext: 'docx', group: 'doc', count: 1 }],
    ['mp4', { name: 'holiday-clip.mp4', ext: 'mp4', group: 'video', count: 1 }],
    ['folder', { name: 'Project v1.2', ext: 'folder', group: 'folder', count: 1 }],
  ]) {
    const targets = targetsForFiles([file === 'folder' ? 'x.zip' : `x.${file}`], everything);
    win.webContents.send('wheel:open', { info, targets });
    await sleep(700);
    check(`${file}: ${await segments()} segments drawn (${targets.map((t) => t.id).join(', ')})`, (await segments()) === targets.length && targets.length >= 2);
    await shot(`wheel-${file}.png`);
  }

  win.webContents.send('wheel:open', { info: { name: 'Quarterly report final.docx', ext: 'docx', group: 'doc', count: 1 }, targets: targetsForFiles(['x.docx'], everything) });
  await sleep(700);
  check('dropping on a segment is allowed (copy)', (await dragover(330, 205)) === 'copy');
  await sleep(300);
  await shot('wheel-hover.png');
  check('dropping on the centre is refused', (await dragover(200, 200)) === 'none');
  check('dropping outside the ring is refused', (await dragover(5, 5)) === 'none');

  win.webContents.send('wheel:close');
  await sleep(300);
  check('after closing, nothing can be dropped (no stale segments)', (await dragover(330, 205)) === 'none');

  console.log(bad ? `\n${bad} failed` : '\nall passed');
  app.exit(bad ? 1 : 0);
});

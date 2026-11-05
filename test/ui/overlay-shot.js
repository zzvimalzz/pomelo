// SPDX-License-Identifier: AGPL-3.0-or-later
// Renders the real wheel page with sample data: segments, hover, drop-target behaviour, and per-kind icon colours.
//   npx electron test/ui/overlay-shot.js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { targetsForFiles, groupOf, TARGET_ORDER } = require('../../src/features/conversion/catalog/formats');
const { middleEllipsis } = require('../../src/shared/core/text');

app.on('window-all-closed', () => {});
// Without this, a window that another app covers on screen cannot be captured ("display surface not available").
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
const out = path.join(__dirname, '..', 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { expect: check, failed } = require('../support/expect');
const finish = require('../support/finish');

app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  const win = new BrowserWindow({ width: 400, height: 400, x: 200, y: 200, frame: false, transparent: true, focusable: false, skipTaskbar: true, alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, '..', '..', 'src', 'features', 'gesture', 'ui', 'preload.js'), contextIsolation: true, sandbox: true } });
  await win.loadFile(path.join(__dirname, '..', '..', 'src', 'features', 'gesture', 'ui', 'wheel.html'));
  const shot = async (name) => fs.writeFileSync(path.join(out, name), await sharp((await win.webContents.capturePage()).toPNG()).flatten({ background: '#d9d6d0' }).toBuffer());
  const dragover = (x, y) => win.webContents.executeJavaScript(`(() => { const e = new Event('dragover', { cancelable: true }); e.clientX = ${x}; e.clientY = ${y}; e.dataTransfer = { dropEffect: '' }; window.dispatchEvent(e); return e.dataTransfer.dropEffect; })()`);
  const segments = () => win.webContents.executeJavaScript(`document.querySelectorAll('.seg').length`);
  const insideDisc = () => win.webContents.executeJavaScript(`(() => {
    const disc = document.querySelector('#center .disc').getBoundingClientRect();
    const cx = disc.x + disc.width / 2, cy = disc.y + disc.height / 2, r = disc.width / 2;
    return [...document.querySelectorAll('#center .doc path, #center .doc circle, #center .doc rect, #center .name')].every((n) => {
      const b = n.getBoundingClientRect();
      return [[b.left, b.top], [b.right, b.top], [b.left, b.bottom], [b.right, b.bottom]].every(([x, y]) => Math.hypot(x - cx, y - cy) <= r);
    });
  })()`);

  // pretend every engine is present, so the wheel shows its full 8 segments
  const everything = () => true;
  for (const [file, info] of [
    ['docx', { name: 'Quarterly report final.docx', ext: 'docx', group: 'doc', count: 1 }],
    ['mp4', { name: 'holiday-clip.mp4', ext: 'mp4', group: 'video', count: 1 }],
    ['folder', { name: 'Project v1.2', ext: 'folder', group: 'folder', count: 1 }],
    ['zip', { name: 'backup-2026.zip', ext: 'zip', group: 'archive', count: 1 }],
  ]) {
    const targets = targetsForFiles([file === 'folder' ? 'x.zip' : `x.${file}`], everything);
    win.webContents.send('wheel:open', { info: { ...info, name: middleEllipsis(info.name, 15) }, targets });
    await sleep(700);
    check(`${file}: ${await segments()} segments drawn (${targets.map((t) => t.id).join(', ')})`, (await segments()) === targets.length && targets.length >= 2);
    check(`${file}: the centre content stays inside the disc`, await insideDisc());
    await shot(`wheel-${file}.png`);
  }

  const noPicture = [], outside = [], seen = new Map();
  const hasPicture = () => win.webContents.executeJavaScript(`document.querySelectorAll('#center .doc .g, #center .doc .gl, #center .doc .gt').length > 0 || !!document.querySelector('#center .edge')`);
  for (const ext of Object.keys(TARGET_ORDER)) {
    win.webContents.send('wheel:open', { info: { name: `file.${ext}`, ext, group: groupOf(ext), count: 1 }, targets: targetsForFiles([`x.${ext}`], everything) });
    await sleep(120);
    if (!(await hasPicture())) noPicture.push(ext);
    const picture = await win.webContents.executeJavaScript(`(() => { const c = document.querySelector('#center .doc').cloneNode(true); c.querySelector('.badge')?.remove(); return c.innerHTML.replace(/ fill="#[0-9a-f]{6}"/g, ''); })()`);
    (seen.get(picture) || seen.set(picture, []).get(picture)).push(ext);
    if (!(await insideDisc())) outside.push(ext);
  }
  check(`every format has a picture on its icon (${Object.keys(TARGET_ORDER).length} formats)`, !noPicture.length, noPicture.join(', '));
  const shared = [...seen.values()].filter((list) => list.length > 1).map((list) => list.join('=')).join(' ');
  check('no two formats share a picture', !shared, shared);
  check('every icon stays inside the disc', !outside.length, outside.join(', '));

  win.webContents.send('wheel:open', { info: { name: 'a.pdf', ext: 'pdf', group: 'pdf', count: 12 }, targets: targetsForFiles(['x.pdf'], everything) });
  await sleep(700);
  check('several files: the centre shows a stack with a count', (await win.webContents.executeJavaScript(`document.querySelector('#center .countText').textContent + '|' + document.querySelector('#center .name').textContent`)) === '12|12 files');
  await shot('wheel-many.png');
  check('several files: the stack stays inside the disc', await insideDisc());
  win.webContents.send('wheel:open', { info: { name: 'x', ext: 'folder', group: 'folder', count: 3 }, targets: targetsForFiles(['x.zip'], everything) });
  await sleep(700);
  check('several folders: the stack stays inside the disc', await insideDisc());
  await shot('wheel-many-folders.png');

  win.webContents.send('wheel:open', { info: { name: middleEllipsis('Quarterly report final.docx', 15), ext: 'docx', group: 'doc', count: 1 }, targets: targetsForFiles(['x.docx'], everything) });
  await sleep(700);
  check('dropping on a segment is allowed (copy)', (await dragover(330, 205)) === 'copy');
  await sleep(300);
  await shot('wheel-hover.png');
  check('dropping on the centre is refused', (await dragover(200, 200)) === 'none');
  check('dropping outside the ring is refused', (await dragover(5, 5)) === 'none');

  console.log('opened from the right-click menu: a click picks, nothing is dropped');
  const docx = targetsForFiles(['x.docx'], everything);
  const picked = [], cancelled = [];
  ipcMain.on('wheel:pick', (_e, id) => picked.push(id));
  ipcMain.on('wheel:cancel', () => cancelled.push(1));
  const input = (event) => win.webContents.executeJavaScript(`window.dispatchEvent(${event})`);
  const mouse = (type, x, y) => input(`new MouseEvent('${type}', { clientX: ${x}, clientY: ${y} })`);
  const lit = () => win.webContents.executeJavaScript(`document.querySelectorAll('.seg.hot').length`);
  win.webContents.send('wheel:open', { info: { name: 'report.docx', ext: 'docx', group: 'doc', count: 1 }, targets: docx, pick: true });
  await sleep(700);
  await mouse('mousemove', 330, 205);
  check('pointing at a format lights it up', (await lit()) === 1);
  await shot('wheel-pick.png');
  await mouse('click', 330, 205);
  await sleep(100);
  check('clicking a format picks it', picked.join() === docx[2].id, picked.join());
  await mouse('click', 200, 200);
  await input(`new KeyboardEvent('keydown', { key: 'Escape' })`);
  await sleep(100);
  check('a click on the centre or Esc asks to close', cancelled.length === 2, String(cancelled.length));
  win.webContents.send('wheel:open', { info: { name: 'report.docx', ext: 'docx', group: 'doc', count: 1 }, targets: docx });
  await sleep(700);
  await mouse('click', 330, 205);
  await sleep(100);
  check('in the drag gesture a click does nothing', picked.length === 1 && cancelled.length === 2);

  win.webContents.send('wheel:close');
  await sleep(300);
  check('after closing, nothing can be dropped (no stale segments)', (await dragover(330, 205)) === 'none');

  console.log(failed() ? `\n${failed()} failed` : '\nall passed');
  finish();
}).catch((e) => { console.error(e); finish(2); });

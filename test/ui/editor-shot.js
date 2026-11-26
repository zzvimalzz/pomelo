// SPDX-License-Identifier: AGPL-3.0-or-later
// Opens the real image editor on pictures made here: that a rotated photo stands upright, that the chequerboard shows only under a
// transparent picture, the tabs, the pictures that are refused, the zoom readout and menu, the panel that hides, full screen and the
// notice when graphics acceleration is gone; then edits, undo, Compare and saving over a file or as a copy, and the Crop tool: the
// frame, the aspect chips, Straighten, Esc and Enter. Saves light and dark screenshots.
//   npx electron test/ui/editor-shot.js
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { createEditor } = require('../../src/features/image-editor');
const { readImage, writeImage, uniquePath, QUALITY, extOf } = require('../../src/features/conversion');
const { expect: check, failed } = require('../support/expect');
const finish = require('../support/finish');
const { dir: tmpDir } = require('../support/tmp');

app.on('window-all-closed', () => {});
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const asset = (n) => path.join(__dirname, '..', '..', 'assets', n);
const out = path.join(__dirname, '..', 'shots');
const root = tmpDir('editor');

let settings = { imageView: { window: null } };
const notices = [];
const channels = ['state', 'pixels', 'pixels-done', 'close', 'drop', 'show', 'view', 'full-screen', 'save', 'dirty', 'close-window'].map((c) => `imged:${c}`);

// One editor per scenario: the IPC handlers belong to one at a time.
const fresh = (chooseSavePath = async () => null) => {
  for (const channel of channels) ipcMain.removeHandler(channel);
  notices.length = 0;
  const editor = createEditor({ asset, getSettings: () => settings, setSettings: (patch) => { settings = { ...settings, ...patch }; }, notify: (m) => notices.push(m), log: () => {}, readImage, writeImage, uniquePath, qualities: QUALITY, showInFolder: () => {}, extOf, solid: true, chooseSavePath });
  editor.registerIpc();
  return editor;
};
const windowOf = () => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
const js = (win, code) => win.webContents.executeJavaScript(code);
const shot = async (win, name) => fs.writeFileSync(path.join(out, name), (await win.webContents.capturePage()).toPNG());
const until = async (what, fn, ms = 20000) => {
  for (let waited = 0; waited < ms; waited += 100) { if (await fn()) return true; await sleep(100); }
  console.log(`  (gave up waiting for ${what})`);
  return false;
};
const key = (win, k, ctrl = false, shift = false) => js(win, `window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, ctrlKey: ${ctrl}, shiftKey: ${shift}, bubbles: true, cancelable: true }))`);
const closeAll = async (editor) => {
  editor.closeAll();
  for (const w of BrowserWindow.getAllWindows()) w.destroy();
  await sleep(200);
};

const put = (name, buffer) => { const file = path.join(root, name); fs.writeFileSync(file, buffer); return file; };

async function makePictures() {
  const photo = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: { r: 40, g: 120, b: 220 } } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const glass = Buffer.alloc(800 * 600 * 4);
  for (let y = 0; y < 600; y++) for (let x = 400; x < 800; x++) glass.set([230, 80, 110, 255], (y * 800 + x) * 4);
  const gif = Buffer.concat([
    Buffer.from('GIF89a', 'latin1'), Buffer.from([1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255]),
    ...[0, 1].map(() => Buffer.from([0x21, 0xf9, 4, 0, 10, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0])),
    Buffer.from([0x3b]),
  ]);
  const ramp = Buffer.alloc(200 * 100 * 3);
  for (let y = 0; y < 100; y++) for (let x = 0; x < 200; x++) ramp.set([x, y, 128], (y * 200 + x) * 3);
  const square = Buffer.alloc(512 * 512 * 3);
  for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) square.set([x >> 1, y >> 1, (x + y) >> 2], (y * 512 + x) * 3);
  const dated = await sharp({ create: { width: 100, height: 60, channels: 3, background: { r: 90, g: 90, b: 200 } } }).withExif({ IFD0: { Make: 'Pomelo test camera', DateTime: '2024:05:17 14:03:00' } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const small = await sharp({ create: { width: 50, height: 50, channels: 3, background: { r: 200, g: 60, b: 90 } } }).png().toBuffer();
  return {
    photo: put('photo.jpg', photo),
    glass: put('glass.png', await sharp(glass, { raw: { width: 800, height: 600, channels: 4 } }).png().toBuffer()),
    still: put('still.gif', await sharp(Buffer.alloc(200 * 100 * 3, 128), { raw: { width: 200, height: 100, channels: 3 } }).gif().toBuffer()),
    moving: put('moving.gif', gif),
    wide: put('wide.png', await sharp({ create: { width: 16400, height: 1, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer()),
    flat: put('flat.jpg', await sharp({ create: { width: 4000, height: 3000, channels: 3, background: { r: 60, g: 140, b: 220 } } }).jpeg().toBuffer()),
    ramp: put('ramp.png', await sharp(ramp, { raw: { width: 200, height: 100, channels: 3 } }).png().toBuffer()),
    square: put('square.png', await sharp(square, { raw: { width: 512, height: 512, channels: 3 } }).png().toBuffer()),
    dated: put('dated.jpg', dated),
    readonly: put('locked.png', small),
    many: Array.from({ length: 11 }, (_, n) => put(`small-${n}.png`, small)),
  };
}

const luminance = ([r, g, b]) => [r, g, b].map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

// The window's pixels, for reading colours at device pixel positions.
async function pixelsOf(win) {
  const image = await win.webContents.capturePage();
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap();
  return { width, height, at: (x, y) => { const i = (Math.round(y) * width + Math.round(x)) * 4; return [bitmap[i + 2], bitmap[i + 1], bitmap[i]]; } };
}
const near = (c, [r, g, b], tolerance = 24) => Math.abs(c[0] - r) <= tolerance && Math.abs(c[1] - g) <= tolerance && Math.abs(c[2] - b) <= tolerance;

// The box that the picture's colour covers in the well.
async function boxOf(win, colour) {
  const { width, height, at } = await pixelsOf(win);
  const rect = await js(win, `(() => { const r = document.getElementById('well').getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom, devicePixelRatio]; })()`);
  const [left, top, right, bottom] = rect.slice(0, 4).map((v) => Math.round(v * rect[4]));
  let [x0, y0, x1, y1] = [width, height, -1, -1];
  for (let y = top; y < Math.min(bottom, height); y += 2) for (let x = left; x < Math.min(right, width); x += 2) if (near(at(x, y), colour)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return { width: x1 - x0, height: y1 - y0 };
}

const firstShown = (win) => until('the first picture', () => js(win, `document.getElementById('stage').classList.contains('first') && document.getElementById('zoomval').textContent !== ''`));
const tabNames = (win) => js(win, `[...document.querySelectorAll('#tabs .tab')].map((t) => t.title + (t.classList.contains('on') ? '*' : '')).join()`);

app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  const files = await makePictures();
  fs.chmodSync(files.readonly, 0o444);

  console.log('a rotated photo stands upright, and has no chequerboard');
  let editor = fresh();
  await editor.open([files.photo]);
  let win = windowOf();
  const errors = [];
  win.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
  check('the window opens on the picture', !!win && await firstShown(win));
  await sleep(500);
  check('its name is on the title row', (await js(win, `document.getElementById('imgname').textContent`)) === 'photo.jpg');
  check('and there is no tab strip for one picture', (await js(win, `document.getElementById('tabs').hidden`)) === true);
  const box = await boxOf(win, [40, 120, 220]);
  check('a 4000 by 3000 photo with a rotated tag is shown 3 by 4', Math.abs(box.width / box.height - 0.75) < 0.02, `${box.width} by ${box.height}`);
  check('the chequerboard stays away from a picture with no transparency', (await js(win, `document.getElementById('checker').hidden`)) === true);
  check('the zoom reads Fit', (await js(win, `document.getElementById('zoomval').textContent`)) === 'Fit');
  check('the page has no error', errors.length === 0, errors.join('\n'));

  console.log('a transparent picture shows the chequerboard through its clear half');
  await editor.open([files.glass]);
  await sleep(700);
  check('the second picture adds a tab, and the tab strip shows', (await tabNames(win)) === 'photo.jpg,glass.png*', await tabNames(win));
  check('the chequerboard is under it', (await js(win, `!document.getElementById('checker').hidden`)) === true);
  const squares = await js(win, `(() => { const r = document.getElementById('checker').getBoundingClientRect(); return [r.left, r.top, r.width, devicePixelRatio]; })()`);
  const read = await pixelsOf(win);
  const [sx, sy, sw, scale] = squares;
  const a = read.at((sx + 4) * scale, (sy + 4) * scale), b = read.at((sx + 12) * scale, (sy + 4) * scale);
  check('two neighbouring squares differ', JSON.stringify(a) !== JSON.stringify(b), `${a} ${b}`);
  console.log(`  (squares ${a} and ${b}: contrast ${contrast(a, b).toFixed(2)})`);
  const solid = read.at((sx + sw * 0.75) * scale, (sy + 100) * scale);
  check('and the opaque half is drawn over it', near(solid, [230, 80, 110], 12), String(solid));
  await js(win, `document.querySelector('#tabs .tab:not(.on)').click()`);
  await sleep(500);
  check('a click on a tab shows that picture, and the chequerboard goes', (await tabNames(win)) === 'photo.jpg*,glass.png' && (await js(win, `document.getElementById('checker').hidden`)) === true);
  await editor.open([files.photo]);
  await sleep(300);
  check('a picture that is open is shown, not opened twice', (await tabNames(win)) === 'photo.jpg*,glass.png');
  check('a GIF is not offered the editor', editor.editable(files.still) === false && editor.editable(files.square) === true);
  await editor.open([files.square]);
  await sleep(700);
  check('another picture adds a tab', (await tabNames(win)) === 'photo.jpg,glass.png,square.png*', await tabNames(win));
  await js(win, `document.querySelector('#tabs .tab.on .x').click()`);
  await sleep(500);
  check('closing a tab shows its neighbour', (await tabNames(win)) === 'photo.jpg,glass.png*', await tabNames(win));
  await js(win, `document.querySelector('#tabs .tab.on .x').click()`);
  await sleep(500);
  check('with one picture left the strip goes and the name returns', (await js(win, `document.getElementById('tabs').hidden && document.getElementById('imgname').textContent`)) === 'photo.jpg');

  console.log('pictures that are refused');
  await editor.open([files.moving]);
  check('an animated picture is refused with a notice, and no tab', notices.at(-1)?.title === "Can't edit an animated image" && (await tabNames(win)) === 'photo.jpg*', JSON.stringify(notices));
  await editor.open([files.wide]);
  check('a picture over the edge limit is refused', notices.at(-1)?.title === 'This image is too large to edit', JSON.stringify(notices.at(-1)));
  await editor.open([path.join(root, 'gone.png')]);
  check('a file that is not there is refused', notices.at(-1)?.title === "Can't open this image" && notices.at(-1)?.detail === 'The file is no longer there.', JSON.stringify(notices.at(-1)));
  await closeAll(editor);

  console.log('ten tabs at most');
  editor = fresh();
  await editor.open(files.many.slice(0, 10));
  win = windowOf();
  await firstShown(win);
  await sleep(1500);
  check('ten pictures open as ten tabs', (await js(win, `document.querySelectorAll('#tabs .tab').length`)) === 10);
  await editor.open([files.many[10]]);
  check('the eleventh is refused with a notice', notices.at(-1)?.title === 'Too many images open' && (await js(win, `document.querySelectorAll('#tabs .tab').length`)) === 10, JSON.stringify(notices));
  await closeAll(editor);

  console.log('zoom, the menu, the panel and full screen');
  editor = fresh();
  await editor.open([files.photo]);
  win = windowOf();
  win.setSize(1100, 760);
  await firstShown(win);
  await sleep(600);
  const text = (id) => js(win, `document.getElementById('${id}').textContent`);
  await key(win, '1', true);
  await sleep(500);
  check('Ctrl+1 shows the picture at 100%', (await text('zoomval')) === '100%', await text('zoomval'));
  await key(win, '0', true);
  await sleep(500);
  check('Ctrl+0 shows Fit again', (await text('zoomval')) === 'Fit', await text('zoomval'));
  await js(win, `document.getElementById('zoomin').click()`);
  await sleep(500);
  const zoomed = await text('zoomval');
  check('Zoom in leaves Fit for a percentage', /^\d+%$/.test(zoomed), zoomed);
  await js(win, `document.getElementById('zoomval').click()`);
  await sleep(300);
  const items = () => js(win, `[...document.querySelectorAll('#zmenu .mi')].map((b) => b.firstChild.textContent + (b.classList.contains('on') ? '*' : '') + (b.disabled ? '-' : '')).join()`);
  check('the zoom value opens a menu of Fit and six zooms, and ticks the one in use', (await js(win, `!document.getElementById('zmenu').hidden`)) && (await items()) === 'Fit,25%*,50%,100%,200%,400%,800%', await items());
  await js(win, `[...document.querySelectorAll('#zmenu .mi')].find((b) => b.firstChild.textContent === '200%').click()`);
  await sleep(500);
  check('choosing 200% sets it and closes the menu', (await text('zoomval')) === '200%' && (await js(win, `document.getElementById('zmenu').hidden`)) === true, await text('zoomval'));
  await js(win, `document.getElementById('zoomval').click()`);
  await sleep(300);
  check('the menu then ticks 200%', (await items()).includes('200%*'), await items());
  await key(win, 'Escape');
  check('Esc closes the menu', (await js(win, `document.getElementById('zmenu').hidden`)) === true);
  await js(win, `document.getElementById('zoomval').click()`);
  await sleep(200);
  await js(win, `[...document.querySelectorAll('#zmenu .mi')].find((b) => b.firstChild.textContent === 'Fit').click()`);
  await sleep(500);
  check('Fit in the menu goes back to Fit', (await text('zoomval')) === 'Fit', await text('zoomval'));
  await key(win, '0', true);
  await sleep(400);

  const widths = () => js(win, `[document.getElementById('well').getBoundingClientRect().width, document.getElementById('panel').classList.contains('open')]`);
  const [open, panelOn] = await widths();
  check('the panel is open at first', panelOn === true);
  await key(win, 'b', true);
  await sleep(700);
  const [shut, panelOff] = await widths();
  check('Ctrl+B hides the panel and the well takes its place', panelOff === false && Math.round(shut - open) === 320, `${open} ${shut}`);
  check('the choice is remembered', settings.imageView.panel === false, JSON.stringify(settings.imageView));
  await key(win, 'b', true);
  await sleep(700);
  check('and Ctrl+B shows it again', (await widths())[1] === true && Math.round((await widths())[0] - open) === 0);
  await key(win, 'c');
  await sleep(300);
  check('the C key picks Crop', (await js(win, `document.querySelector('#tools [aria-checked="true"]').dataset.tool`)) === 'crop');

  await key(win, 'F11');
  check('F11 enters full screen', await until('full screen', () => win.isFullScreen()) && await until('the page to know', () => js(win, `document.body.classList.contains('full')`)));
  await key(win, 'Escape');
  await sleep(500);
  check('the first Esc leaves Crop and keeps full screen', win.isFullScreen() && (await js(win, `document.querySelector('#tools [aria-checked="true"]').dataset.tool`)) === 'adjust');
  await key(win, 'Escape');
  check('the next Esc leaves full screen', await until('the window to leave full screen', () => !win.isFullScreen()) && await until('the page to know', () => js(win, `!document.body.classList.contains('full')`)));
  await closeAll(editor);

  console.log('a small picture is not enlarged to fit');
  editor = fresh();
  await editor.open([files.still]);
  win = windowOf();
  await firstShown(win);
  await sleep(500);
  await js(win, `document.getElementById('zoomval').click()`);
  await sleep(300);
  check('Fit shows a 200 by 100 picture at 100%, so 100% can be chosen and smaller zooms are greyed out', (await js(win, `[...document.querySelectorAll('#zmenu .mi')].map((b) => b.firstChild.textContent + (b.classList.contains('on') ? '*' : '') + (b.disabled ? '-' : '')).join()`)) === 'Fit*,25%-,50%-,100%,200%,400%,800%');
  await closeAll(editor);

  console.log('graphics acceleration gone');
  editor = fresh();
  await editor.open([files.glass]);
  win = windowOf();
  await firstShown(win);
  await sleep(500);
  await js(win, `document.getElementById('canvas').dispatchEvent(new Event('webglcontextlost', { cancelable: true }))`);
  await sleep(300);
  check('the card says the picture cannot be shown', (await js(win, `!document.getElementById('gpu').hidden && document.getElementById('well').classList.contains('gpu-off')`)) === true);
  await closeAll(editor);

  console.log('edits, undo, compare and saving');
  let saveTo = null;
  const dialogs = [];
  editor = fresh(() => { dialogs.push('asked'); return saveTo; });
  await editor.open([files.flat]);
  win = windowOf();
  win.setSize(1100, 760);
  await firstShown(win);
  await sleep(600);
  const state = () => js(win, `({ undo: !document.getElementById('undo').disabled, redo: !document.getElementById('redo').disabled, save: !document.getElementById('savebtn').hidden, dot: !document.getElementById('imgdot').hidden, compare: !document.getElementById('compare').disabled, reset: !document.querySelector('.textbtn').disabled })`);
  const is = (got, want) => JSON.stringify(got) === JSON.stringify(want);
  check('a picture nobody touched has nothing to undo, save or compare', is(await state(), { undo: false, redo: false, save: false, dot: false, compare: false, reset: false }), JSON.stringify(await state()));
  await key(win, 'R');
  await sleep(500);
  check('R turns it right: Undo, Save, the dot, Compare and Reset all wake up', is(await state(), { undo: true, redo: false, save: true, dot: true, compare: true, reset: true }), JSON.stringify(await state()));
  await key(win, 'z', true);
  await sleep(300);
  check('Ctrl+Z undoes it, and the changes go away', is(await state(), { undo: false, redo: true, save: false, dot: false, compare: false, reset: false }), JSON.stringify(await state()));
  await key(win, 'y', true);
  await sleep(300);
  check('Ctrl+Y brings it back', (await state()).dot === true && (await state()).redo === false);
  for (let n = 0; n < 3; n++) { await key(win, 'R'); await sleep(120); }
  await sleep(400);
  check('four turns to the right in all leave nothing to undo', is(await state(), { undo: false, redo: false, save: false, dot: false, compare: false, reset: false }), JSON.stringify(await state()));

  const pixelRows = async () => {
    const { width, height, at } = await pixelsOf(win);
    const rect = await js(win, `(() => { const r = document.getElementById('well').getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom, devicePixelRatio]; })()`);
    const [left, top, right, bottom] = rect.slice(0, 4).map((v) => Math.round(v * rect[4]));
    let [x0, y0, x1, y1] = [width, height, -1, -1];
    for (let y = top + 4; y < Math.min(bottom - 60, height); y += 2) for (let x = left + 4; x < Math.min(right - 4, width); x += 2) if (near(at(x, y), [60, 140, 220], 30)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    return { width: x1 - x0, height: y1 - y0 };
  };
  await js(win, `document.querySelector('#tools [data-tool="crop"]').click()`);
  await sleep(800);
  const wide = await pixelRows();
  await js(win, `document.querySelector('#view-crop .tools4 button:nth-child(2)').click()`);
  await sleep(700);
  const tall = await pixelRows();
  check('Rotate right in the Crop panel turns a wide picture into a tall one', wide.width > wide.height && tall.height > tall.width, `${wide.width}x${wide.height} then ${tall.width}x${tall.height}`);
  await js(win, `document.querySelector('.textbtn').click()`);
  await sleep(800);
  check('Reset puts it back', is(await pixelRows(), wide) && (await state()).dot === false);
  await key(win, 'R');
  await sleep(500);
  const tooltips = await js(win, `[...document.querySelectorAll('#view-crop .tools4 button, #undo, #redo, #compare, #more, #savebtn')].map((b) => b.title).join('|')`);
  check('the tooltips name the control and its key', tooltips === 'Undo (Ctrl+Z)|Redo (Ctrl+Y)|Save (Ctrl+S)|More|Compare (\\)|Rotate left (Shift+R)|Rotate right (R)|Flip horizontal|Flip vertical', tooltips);

  await key(win, 'a');
  await sleep(600);
  await js(win, `document.getElementById('compare').dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }))`);
  await sleep(500);
  const original = await pixelRows();
  await js(win, `document.getElementById('compare').dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))`);
  await sleep(500);
  const edited = await pixelRows();
  check('holding Compare shows the picture as it was, and letting go shows the edit', original.width > original.height && edited.height > edited.width, `${original.width}x${original.height} then ${edited.width}x${edited.height}`);
  check('the backslash key holds Compare too', (await js(win, `(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\\\', bubbles: true, cancelable: true })); return document.getElementById('compare').classList.contains('held'); })()`)) === true);
  await js(win, `window.dispatchEvent(new KeyboardEvent('keyup', { key: '\\\\', bubbles: true }))`);
  await sleep(300);
  check('and letting go of it lets go of Compare', (await js(win, `document.getElementById('compare').classList.contains('held')`)) === false);

  console.log('save a copy as a PNG');
  await js(win, `document.getElementById('more').click()`);
  await sleep(300);
  check('More opens a menu with Save a copy, Reset all and Show in folder', (await js(win, `[...document.querySelectorAll('#mmenu .mi')].map((b) => b.firstChild.textContent).join()`)) === 'Save a copy…,Reset all,Show in folder');
  await js(win, `document.querySelector('#mmenu .mi').click()`);
  await sleep(500);
  const card = () => js(win, `(() => { const c = document.querySelector('.card'); return c && { title: c.querySelector('h3').textContent, chips: [...c.querySelectorAll('.chip')].map((b) => b.textContent + (b.classList.contains('on') ? '*' : '')).join(), quality: !c.querySelector('.range').closest('.field').hidden, buttons: [...c.querySelectorAll('.btn')].map((b) => b.textContent).join() }; })()`);
  check('Save a copy asks for a format, a size and a quality', is(await card(), { title: 'Save a copy', chips: 'Same*,JPG,PNG,WebP,AVIF,HEIC,TIFF,BMP,GIF,PDF,Original*,Custom', quality: true, buttons: 'Cancel,Save…' }), JSON.stringify(await card()));
  await js(win, `[...document.querySelectorAll('.card .chip')].find((b) => b.textContent === 'PNG').click()`);
  await sleep(200);
  check('PNG has no quality', (await card()).quality === false && (await card()).chips.includes('PNG*'));
  await js(win, `[...document.querySelectorAll('.card .chip')].find((b) => b.textContent === 'Custom').click()`);
  await js(win, `(() => { const f = document.querySelector('.card .num-input'); f.value = '5000'; f.dispatchEvent(new Event('input')); })()`);
  check('a long edge over the picture\'s own is not accepted', (await js(win, `document.querySelector('.card .btn.primary').disabled`)) === true);
  await js(win, `(() => { const f = document.querySelector('.card .num-input'); f.value = '2000'; f.dispatchEvent(new Event('input')); })()`);
  check('and a smaller one shows the size it makes', (await js(win, `[document.querySelector('.card .btn.primary').disabled, document.querySelectorAll('.card .level')[1].textContent]`)).join() === 'false,1500 × 2000', (await js(win, `document.querySelectorAll('.card .level')[1].textContent`)));
  check('the long edge field has no browser spin arrows and takes only digits', (await js(win, `(() => { const f = document.querySelector('.card .num-input'); f.value = '12ab'; f.dispatchEvent(new Event('input')); return [f.type, f.value]; })()`)).join() === 'text,12');
  await js(win, `(() => { const f = document.querySelector('.card .num-input'); f.value = '2000'; f.dispatchEvent(new Event('input')); f.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })); f.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true, cancelable: true })); })()`);
  check('the field is no wider than its buttons and five digits need', (await js(win, `document.querySelector('.card .numfield').getBoundingClientRect().width`)) <= 90);
  check('ArrowDown steps by 1 and Shift+ArrowDown by 10', (await js(win, `document.querySelector('.card .num-input').value`)) === '1989');
  await js(win, `document.querySelectorAll('.card .num-step')[1].click()`);
  check('the plus button steps up and never past the long edge of the picture', (await js(win, `document.querySelector('.card .num-input').value`)) === '1990' && (await js(win, `(() => { const f = document.querySelector('.card .num-input'); f.value = '4000'; f.dispatchEvent(new Event('input')); document.querySelectorAll('.card .num-step')[1].click(); return f.value; })()`)) === '4000');
  await js(win, `(() => { const f = document.querySelector('.card .num-input'); f.value = '2000'; f.dispatchEvent(new Event('input')); })()`);
  await js(win, `[...document.querySelectorAll('.card .chip')].find((b) => b.textContent === 'Original').click()`);
  saveTo = path.join(root, 'flat-turned.png');
  await js(win, `document.querySelector('.card .btn.primary').click()`);
  check('the file is written where the user chose', await until('the copy', () => fs.existsSync(saveTo)));
  await sleep(500);
  const turnedMeta = await sharp(saveTo).metadata();
  check('a 4000 by 3000 picture turned right and saved as a PNG is 3000 by 4000', turnedMeta.format === 'png' && turnedMeta.width === 3000 && turnedMeta.height === 4000, `${turnedMeta.format} ${turnedMeta.width}x${turnedMeta.height}`);
  check('the dialog was asked once, and the copy opens in place of the edited picture, which is closed with no question', dialogs.length === 1 && await until('the copy tab', async () => (await js(win, `document.getElementById('imgname').textContent`)) === 'flat-turned.png') && (await state()).dot === false && (await js(win, `document.querySelector('.card')`)) === null);

  console.log('save over a file, and closing with changes');
  await closeAll(editor);
  editor = fresh();
  await editor.open([files.ramp]);
  win = windowOf();
  win.setSize(1100, 760);
  await firstShown(win);
  await sleep(600);
  await js(win, `document.querySelector('#tools [data-tool="crop"]').click()`);
  await sleep(300);
  await js(win, `document.querySelector('#view-crop .tools4 button:nth-child(3)').click()`);
  await sleep(600);
  await key(win, 's', true);
  await sleep(500);
  check('the first Save over a file asks Replace the original', (await js(win, `document.querySelector('.card h3')?.textContent`)) === 'Replace the original?');
  await js(win, `[...document.querySelectorAll('.card .btn')].find((b) => b.textContent === 'Replace').click()`);
  check('Replace writes over the file, the changes go away and Saved shows', await until('the save', async () => !(await state()).dot) && (await js(win, `document.getElementById('imgsaved').textContent`)) === 'Saved');
  const ramp = await sharp(files.ramp).raw().toBuffer({ resolveWithObject: true });
  const px = (x, y) => [...ramp.data.subarray((y * ramp.info.width + x) * ramp.info.channels, (y * ramp.info.width + x) * ramp.info.channels + 3)];
  check('after a flip across, pixel (10, 10) is what was at (W - 11, 10)', ramp.info.width === 200 && near(px(10, 10), [189, 10, 128], 3) && near(px(ramp.info.width - 11, 10), [10, 10, 128], 3), `${px(10, 10)} ${px(189, 10)}`);
  await key(win, 'R');
  await sleep(500);
  await key(win, 's', true);
  await sleep(400);
  check('the second Save does not ask again', (await js(win, `document.querySelector('.card')`)) === null && await until('the save', async () => !(await state()).dot));

  await key(win, 'R');
  await sleep(500);
  await key(win, 'a');
  await sleep(600);
  await js(win, `document.getElementById('zoomval').click()`);
  await sleep(300);
  await js(win, `[...document.querySelectorAll('#zmenu .mi')].find((b) => b.firstChild.textContent === '800%').click()`);
  await sleep(600);
  check('the picture is zoomed in far enough to pan', await js(win, `document.getElementById('well').classList.contains('pan')`));
  win.close();
  await sleep(600);
  check('closing the window with changes asks first, and does not close', !win.isDestroyed() && (await js(win, `document.querySelector('.card h3')?.textContent`)) === `Save changes to ramp.png?`);
  const [cx, cy] = await js(win, `(() => { const r = [...document.querySelectorAll('.card .btn')].find((b) => b.textContent === 'Cancel').getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })()`);
  win.webContents.sendInputEvent({ type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: cx, y: cy, button: 'left', clickCount: 1 });
  await sleep(300);
  check('a mouse click on Cancel works while the picture is zoomed in', await js(win, `document.querySelector('.card') === null`));
  check('Cancel keeps the window', !win.isDestroyed());
  win.close();
  await sleep(500);
  await js(win, `[...document.querySelectorAll('.card .btn')].find((b) => b.textContent === "Don't save").click()`);
  check('Don\'t save lets the window go', await until('the window to close', () => win.isDestroyed()));
  await closeAll(editor);

  console.log('the date taken survives, a read-only file says so');
  editor = fresh();
  await editor.open([files.dated]);
  win = windowOf();
  await firstShown(win);
  await sleep(500);
  await key(win, 'R');
  await sleep(400);
  await key(win, 's', true);
  await sleep(400);
  await js(win, `[...document.querySelectorAll('.card .btn')].find((b) => b.textContent === 'Replace').click()`);
  await until('the save', async () => !(await state()).dot);
  const written = fs.readFileSync(files.dated);
  check('a JPG saved over keeps its date taken and camera', written.includes('2024:05:17 14:03:00') && written.includes('Pomelo test camera'));
  check('and stands upright with orientation 1', (await sharp(files.dated).metadata()).orientation === 1);
  await closeAll(editor);
  editor = fresh();
  await editor.open([files.readonly]);
  win = windowOf();
  await firstShown(win);
  await sleep(500);
  await key(win, 'R');
  await sleep(400);
  await key(win, 's', true);
  await sleep(400);
  await js(win, `[...document.querySelectorAll('.card .btn')].find((b) => b.textContent === 'Replace').click()`);
  await sleep(1500);
  check('a read-only file shows the read-only sentence and keeps the changes', notices.at(-1)?.title === "Can't save" && notices.at(-1)?.detail === 'locked.png is read-only. Save a copy instead.' && (await state()).dot === true, JSON.stringify(notices.at(-1)));
  await closeAll(editor);
  fs.chmodSync(files.readonly, 0o666);

  console.log('what is saved is what is shown');
  editor = fresh(async () => saveTo);
  await editor.open([files.square]);
  win = windowOf();
  win.setSize(1100, 760);
  await firstShown(win);
  await sleep(500);
  await js(win, `document.querySelector('#tools [data-tool="crop"]').click()`);
  await sleep(300);
  await js(win, `document.querySelector('#view-crop .tools4 button:nth-child(4)').click()`);
  await sleep(300);
  await js(win, `document.querySelector('#view-crop .tools4 button:nth-child(2)').click()`);
  await sleep(500);
  await key(win, 'a');
  await sleep(600);
  await key(win, '1', true);
  await js(win, `document.getElementById('panelbtn').click()`);
  await sleep(1200);
  const seen = await pixelsOf(win);
  const where = await js(win, `(() => { const w = document.getElementById('well').getBoundingClientRect(), c = document.getElementById('canvas'), d = devicePixelRatio; return [w.left * d + Math.round((c.width - 512) / 2), w.top * d + Math.round((c.height - 512) / 2)]; })()`);
  saveTo = path.join(root, 'square-edited.png');
  await key(win, 'S', true, true);
  await sleep(500);
  await js(win, `[...document.querySelectorAll('.card .chip')].find((b) => b.textContent === 'PNG').click()`);
  await js(win, `document.querySelector('.card .btn.primary').click()`);
  await until('the copy', () => fs.existsSync(saveTo));
  await sleep(500);
  const saved = await sharp(saveTo).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let worst = 0;
  for (let y = 0; y < 512; y += 7) for (let x = 0; x < 512; x += 7) {
    const shownPixel = seen.at(where[0] + x, where[1] + y), i = (y * 512 + x) * 3;
    worst = Math.max(worst, Math.abs(shownPixel[0] - saved.data[i]), Math.abs(shownPixel[1] - saved.data[i + 1]), Math.abs(shownPixel[2] - saved.data[i + 2]));
  }
  check('the picture on screen and the file saved agree to within 2 of 255 in every channel', saved.info.width === 512 && worst <= 2, `worst ${worst}`);
  await closeAll(editor);

  console.log('crop: aspect ratio, apply, cancel');
  // A move with the button down has to say so, or Chromium drops the pointer capture a drag holds.
  const mouse = (type, x, y, down = false) => win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, modifiers: down ? ['leftbuttondown'] : [] });
  const rectOf = (selector) => js(win, `(() => { const r = document.querySelector('${selector}').getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height, dpr: devicePixelRatio }; })()`);
  const press = async (from, to) => {
    mouse('mouseMove', from[0], from[1]);
    mouse('mouseDown', from[0], from[1]);
    for (let n = 1; n <= 8; n++) { mouse('mouseMove', from[0] + ((to[0] - from[0]) * n) / 8, from[1] + ((to[1] - from[1]) * n) / 8, true); await sleep(30); }
    await sleep(300);
  };
  const release = async (to) => {
    mouse('mouseUp', to[0], to[1]);
    await sleep(600);
  };
  const drag = async (from, to) => {
    await press(from, to);
    await release(to);
  };
  const tool = () => js(win, `document.querySelector('#tools [aria-checked="true"]').dataset.tool`);
  const chipsOf = () => js(win, `[...document.querySelectorAll('#view-crop .chip')].map((b) => b.textContent + (b.classList.contains('on') ? '*' : '')).join()`);
  const chip = (name) => js(win, `[...document.querySelectorAll('#view-crop .chip')].find((b) => b.textContent === '${name}').click()`);
  const copyAsPng = async (file) => {
    saveTo = file;
    await key(win, 'S', true, true);
    await sleep(500);
    await js(win, `[...document.querySelectorAll('.card .chip')].find((b) => b.textContent === 'PNG').click()`);
    await js(win, `document.querySelector('.card .btn.primary').click()`);
    await until('the copy', () => fs.existsSync(file));
    await sleep(500);
  };
  const flatEditor = async (file, resize = true) => {
    editor = fresh(async () => saveTo);
    await editor.open([file]);
    win = windowOf();
    if (resize) win.setSize(1100, 760);
    await firstShown(win);
    await sleep(600);
    await key(win, 'c');
    await sleep(800);
  };

  await flatEditor(files.flat);
  check('Crop shows the frame, and the aspect chips start on Free', (await js(win, `document.getElementById('frame').classList.contains('on')`)) === true && (await chipsOf()) === 'Free*,Original,Square,4:5,3:2,16:9', await chipsOf());
  check('the frame starts on the whole picture, and the pill is gone', (await js(win, `document.getElementById('pill').classList.contains('away')`)) === true && (await state()).dot === false);
  const veilSample = async () => {
    const f = await rectOf('#frame');
    const px = await pixelsOf(win);
    return { outside: px.at((f.left - 14) * f.dpr, (f.top + f.height / 2) * f.dpr), inside: px.at((f.left + 14) * f.dpr, (f.top + f.height / 2) * f.dpr) };
  };
  await chip('Square');
  await sleep(700);
  const squareFrame = await rectOf('#frame');
  check('Square makes the frame square, and the chip is on', Math.abs(squareFrame.width - squareFrame.height) <= 1.5 && (await chipsOf()).includes('Square*'), `${squareFrame.width}x${squareFrame.height}`);
  const veil = await veilSample();
  check('what the frame leaves out is darkened', luminance(veil.outside) < luminance(veil.inside) * 0.6, `${veil.outside} against ${veil.inside}`);
  check('the choice makes a change: Save and the dot show', (await state()).dot === true && (await state()).undo === true);
  check('the orientation button is off for Square', (await js(win, `document.querySelector('#view-crop .orient').disabled`)) === true);
  await key(win, 'Enter');
  await sleep(700);
  check('Enter applies the crop and goes to Adjust', (await tool()) === 'adjust' && (await js(win, `document.getElementById('frame').classList.contains('on')`)) === false);
  const croppedBox = await boxOf(win, [60, 140, 220]);
  check('the picture is now shown square', Math.abs(croppedBox.width - croppedBox.height) <= 6, `${croppedBox.width}x${croppedBox.height}`);
  await copyAsPng(path.join(root, 'flat-square.png'));
  const squareMeta = await sharp(path.join(root, 'flat-square.png')).metadata();
  check('a 4000 by 3000 picture cropped to a square and saved is 3000 by 3000', squareMeta.width === 3000 && squareMeta.height === 3000, `${squareMeta.width}x${squareMeta.height}`);
  await closeAll(editor);

  await flatEditor(files.flat);
  await chip('16:9');
  await sleep(600);
  await key(win, 'Escape');
  await sleep(700);
  check('Esc puts back what Crop was entered with, and leaves nothing to undo', (await tool()) === 'adjust' && is(await state(), { undo: false, redo: false, save: false, dot: false, compare: false, reset: false }), JSON.stringify(await state()));
  await key(win, 'c');
  await sleep(700);
  check('Crop shows Free again, and the frame is whole', (await chipsOf()).startsWith('Free*'));
  await chip('3:2');
  await sleep(600);
  await key(win, 'a');
  await sleep(700);
  check('choosing another tool applies the crop', (await state()).dot === true);
  await key(win, 'z', true);
  await sleep(500);
  check('and one Undo takes it back', (await state()).dot === false && (await state()).undo === false);
  await editor.open([files.square]);
  await sleep(700);
  await key(win, 'c');
  await sleep(700);
  await js(win, `(() => { [...document.querySelectorAll('#view-crop .chip')].find((b) => b.textContent === '16:9').click(); document.querySelector('#tabs .tab:not(.on)').click(); })()`);
  await sleep(700);
  const otherTab = await state();
  await js(win, `document.querySelector('#tabs .tab:not(.on)').click()`);
  await sleep(700);
  check('a tab picked while the frame is easing keeps its own picture, and the first one keeps its new shape', otherTab.dot === false && (await state()).dot === true && (await chipsOf()).includes('16:9*'), `${JSON.stringify(otherTab)} ${await chipsOf()}`);
  await closeAll(editor);

  console.log('crop: the frame and its handles');
  await flatEditor(files.square);
  const start = await rectOf('#frame');
  const room = await rectOf('#well');
  const centred = (r) => Math.abs(r.left + r.width / 2 - room.left - room.width / 2) <= 2 && Math.abs(r.top + r.height / 2 - room.top - room.height / 2) <= 2;
  const say = (r) => `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`;
  check('the frame starts in the middle of the well', centred(start), say(start));
  // Where to press on the bottom right handle of the frame as it is now, and where a drag by (dx, dy) from there ends.
  const handleDrag = async (dx, dy) => {
    const corner = await rectOf('#frame .h.se');
    return [[corner.left + 6, corner.top + 6], [corner.left + 6 + dx, corner.top + 6 + dy]];
  };
  const [from, to] = await handleDrag(-100, -100);
  await press(from, to);
  await key(win, 'Escape');
  await sleep(700);
  mouse('mouseMove', to[0] - 60, to[1] - 60, true);
  await release([to[0] - 60, to[1] - 60]);
  check('Esc during a drag gives the drag up, and the pointer changes nothing after it', (await tool()) === 'adjust' && (await state()).dot === false && (await state()).undo === false, JSON.stringify(await state()));
  await key(win, 'c');
  await sleep(700);
  await press(...(await handleDrag(-100, -100)));
  const held = await rectOf('#frame');
  check('while the bottom right handle is dragged by 100 pixels the frame follows it and the other sides stay put', Math.abs(start.width - held.width - 100) <= 3 && Math.abs(start.height - held.height - 100) <= 3 && Math.abs(held.left - start.left) <= 1 && Math.abs(held.top - start.top) <= 1, `${say(start)} to ${say(held)}`);
  // The frame's middle and width at every screen refresh for 900 ms.
  const watching = js(win, `new Promise((done) => { const seen = [], from = performance.now(); const step = () => { const r = document.getElementById('frame').getBoundingClientRect(); seen.push([r.left + r.width / 2, r.top + r.height / 2, r.width]); if (performance.now() - from < 900) requestAnimationFrame(step); else done(seen); }; step(); })`);
  await sleep(50);
  await release([from[0] - 100, from[1] - 100]);
  const refit = await rectOf('#frame');
  check('let go, the smaller frame is enlarged and centred again', centred(refit) && Math.abs(refit.width - start.width) <= 2, say(refit));
  const path2 = await watching;
  const [first, last] = [path2[0], path2[path2.length - 1]];
  const steps = path2.slice(1).map((at, n) => at[2] - path2[n][2]);
  const moving = steps.filter((by) => by > 0.01).length;
  const strays = Math.max(...path2.map(([x, y]) => Math.abs((x - first[0]) * (last[1] - first[1]) - (y - first[1]) * (last[0] - first[0])) / Math.hypot(last[0] - first[0], last[1] - first[1])));
  check('and it gets there evenly: many small steps, never back, along a straight line', moving >= 10 && Math.min(...steps) > -1 && Math.max(...steps) < (last[2] - first[2]) / 4 && strays <= 2, `${moving} steps, largest ${Math.max(...steps).toFixed(1)} of ${(last[2] - first[2]).toFixed(1)}, ${strays.toFixed(1)} off the line`);
  const outward = await handleDrag(2000, 2000);
  await press(...outward);
  const grown = await rectOf('#frame');
  check('a frame dragged outward past the well stays in sight', grown.left >= room.left + 46 && grown.top >= room.top + 46 && grown.left + grown.width <= room.left + room.width - 46 && grown.top + grown.height <= room.top + room.height - 46 && Math.abs(grown.width - start.width) <= 2, say(grown));
  await release(outward[1]);
  await drag(...(await handleDrag(-100, -100)));
  const middle = [room.left + room.width / 2, room.top + room.height / 2];
  const cornerPixel = async () => (await pixelsOf(win)).at((refit.left + 4) * refit.dpr, (refit.top + 4) * refit.dpr);
  const atCorner = await cornerPixel();
  await press(middle, [middle[0] - 5000, middle[1] - 5000]);
  const moved = await rectOf('#frame');
  const across = await cornerPixel();
  check('dragging the picture moves it under a frame that stays where it is', centred(moved) && Math.abs(moved.width - refit.width) <= 2 && !near(across, atCorner, 8), `${say(moved)}, ${atCorner} then ${across}`);
  await release([middle[0] - 5000, middle[1] - 5000]);
  await drag([room.left + 12, room.top + 12], [room.left + 5000, room.top + 5000]);
  const back = await cornerPixel();
  check('a drag beside the frame moves the picture too, and it stops at the picture\'s edge', near(back, atCorner, 3), `${back} against ${atCorner}`);
  await key(win, 'Enter');
  await sleep(700);
  await copyAsPng(path.join(root, 'square-cut.png'));
  const cut = await sharp(path.join(root, 'square-cut.png')).raw().toBuffer({ resolveWithObject: true });
  const wantSize = Math.round(512 - (100 * 512) / start.width);
  check('the saved file is the part inside the frame, cut from the corner', Math.abs(cut.info.width - wantSize) <= 3 && Math.abs(cut.info.height - wantSize) <= 3 && near([...cut.data.subarray(0, 3)], [0, 0, 0], 3), `${cut.info.width}x${cut.info.height}, first pixel ${[...cut.data.subarray(0, 3)]}`);
  await closeAll(editor);

  console.log('crop: straighten');
  await flatEditor(files.flat);
  const ruler = await rectOf('#view-crop .ruler');
  const whole = await rectOf('#frame');
  await drag([ruler.left + ruler.width / 2, ruler.top + ruler.height / 2], [ruler.left + ruler.width / 2 - 80, ruler.top + ruler.height / 2]);
  check('dragging the ruler 80 pixels to the left levels the picture by +10.0°', (await js(win, `document.querySelector('#view-crop .glabel:nth-of-type(3) span').textContent`)) === '+10.0°', await js(win, `document.querySelector('#view-crop .glabel:nth-of-type(3) span').textContent`));
  const levelled = await rectOf('#frame');
  const radians = (10 * Math.PI) / 180, fit = Math.min(1, 4000 / (4000 * Math.cos(radians) + 3000 * Math.sin(radians)), 3000 / (4000 * Math.sin(radians) + 3000 * Math.cos(radians)));
  check('the frame keeps its shape and its size on screen while the picture behind it is enlarged', Math.abs(levelled.width - whole.width) <= 2 && Math.abs(levelled.height - whole.height) <= 2, `${whole.width}x${whole.height} to ${levelled.width}x${levelled.height}`);
  // A point above the box the picture filled before it was tilted, where one of its corners now reaches.
  const perPixel = levelled.width / (4000 * fit);
  const poking = (await pixelsOf(win)).at((levelled.left + levelled.width / 2 - 1500 * perPixel) * levelled.dpr, (levelled.top + levelled.height / 2 - 1600 * perPixel) * levelled.dpr);
  check('the tilted picture is drawn whole, darkened round the frame', near(poking, [27, 63, 99], 4), `${poking}`);
  await shot(win, 'editor-crop-tilted.png');
  await key(win, 'Enter');
  await sleep(700);
  await copyAsPng(path.join(root, 'flat-level.png'));
  const level = await sharp(path.join(root, 'flat-level.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  check('a picture levelled by 10 degrees and saved is the largest frame that fits, in the same shape', Math.abs(level.info.width - 4000 * fit) <= 4 && Math.abs(level.info.height - 3000 * fit) <= 4, `${level.info.width}x${level.info.height}, wanted ${Math.round(4000 * fit)}x${Math.round(3000 * fit)}`);
  let clear = 0;
  const alphaAt = (x, y) => level.data[(y * level.info.width + x) * 4 + 3];
  for (let x = 0; x < level.info.width; x += 5) clear += (alphaAt(x, 0) < 255) + (alphaAt(x, level.info.height - 1) < 255);
  for (let y = 0; y < level.info.height; y += 5) clear += (alphaAt(0, y) < 255) + (alphaAt(level.info.width - 1, y) < 255);
  clear += [[0, 0], [level.info.width - 1, 0], [0, level.info.height - 1], [level.info.width - 1, level.info.height - 1]].filter(([x, y]) => alphaAt(x, y) < 255).length;
  check('no pixel along the edges or in the corners of the levelled picture is transparent', clear === 0, `${clear} clear`);
  await closeAll(editor);

  for (const theme of ['light', 'dark']) {
    console.log(`${theme} screenshots`);
    nativeTheme.themeSource = theme;
    editor = fresh();
    await editor.open([files.photo, files.glass]);
    win = windowOf();
    win.setSize(1100, 760);
    await firstShown(win);
    await sleep(900);
    const sq = await js(win, `(() => { const r = document.getElementById('checker').getBoundingClientRect(); return [r.left, r.top, devicePixelRatio]; })()`);
    const squares = await pixelsOf(win);
    const [p, q] = [squares.at((sq[0] + 4) * sq[2], (sq[1] + 4) * sq[2]), squares.at((sq[0] + 12) * sq[2], (sq[1] + 4) * sq[2])];
    console.log(`  (${theme} squares ${p} and ${q}: contrast ${contrast(p, q).toFixed(2)})`);
    check(`${theme}: the chequerboard squares can be told apart`, contrast(p, q) >= (theme === 'light' ? 1.1 : 1.25), `${p} ${q}`);
    const tabs = await js(win, `(() => { const on = document.querySelector('#tabs .tab.on').getBoundingClientRect(), off = document.querySelector('#tabs .tab:not(.on)').getBoundingClientRect(); return [on.left + 8, on.top + on.height / 2, off.left + 8, off.top + off.height / 2, devicePixelRatio]; })()`);
    const [chosen, other] = [squares.at(tabs[0] * tabs[4], tabs[1] * tabs[4]), squares.at(tabs[2] * tabs[4], tabs[3] * tabs[4])];
    check(`${theme}: the tab on show is told from the others`, JSON.stringify(chosen) !== JSON.stringify(other), `${chosen} ${other}`);
    console.log(`  (tab on show ${chosen}, others ${other}: contrast ${contrast(chosen, other).toFixed(2)})`);
    await shot(win, `editor-${theme}-transparent.png`);
    await js(win, `document.getElementById('zoomval').click()`);
    await sleep(500);
    await shot(win, `editor-${theme}-zoom-menu.png`);
    await js(win, `document.getElementById('zoomval').click()`);
    await js(win, `document.querySelector('#tabs .tab:not(.on)').click()`);
    await sleep(600);
    await shot(win, `editor-${theme}-photo.png`);
    await key(win, 'c');
    await sleep(900);
    const cropChips = await js(win, `(() => { const rect = (n) => { const r = n.getBoundingClientRect(); return [r.left, r.top + r.height / 2]; }; return [rect(document.querySelector('#view-crop .chip.on')), rect(document.querySelector('#view-crop .chip:not(.on)')), devicePixelRatio]; })()`);
    const cropPixels = await pixelsOf(win);
    const [onChip, offChip] = [cropPixels.at(cropChips[0][0] * cropChips[2] + 6, cropChips[0][1] * cropChips[2]), cropPixels.at(cropChips[1][0] * cropChips[2] + 6, cropChips[1][1] * cropChips[2])];
    const ring = [0, 1, 2].map((n) => cropPixels.at(Math.floor(cropChips[0][0] * cropChips[2]) + n, cropChips[0][1] * cropChips[2])).sort((p, q) => contrast(q, offChip) - contrast(p, offChip))[0];
    console.log(`  (${theme} aspect chip fill ${onChip}, others ${offChip}: contrast ${contrast(onChip, offChip).toFixed(2)}; its ring ${ring}: contrast ${contrast(ring, offChip).toFixed(2)})`);
    check(`${theme}: the chosen aspect chip is told from the others by a tint and a ring`, JSON.stringify(onChip) !== JSON.stringify(offChip) && contrast(ring, offChip) >= 3, `${onChip} ${offChip} ${ring}`);
    await shot(win, `editor-${theme}-crop.png`);
    await js(win, `[...document.querySelectorAll('#view-crop .chip')].find((b) => b.textContent === '3:2').click()`);
    await sleep(700);
    const levelRuler = await js(win, `(() => { const r = document.querySelector('#view-crop .ruler').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    await press(levelRuler, [levelRuler[0] - 48, levelRuler[1]]);
    await shot(win, `editor-${theme}-crop-level.png`);
    await release([levelRuler[0] - 48, levelRuler[1]]);
    await key(win, 'Escape');
    await sleep(800);
    await key(win, 'R');
    await sleep(600);
    await js(win, `document.getElementById('more').click()`);
    await sleep(400);
    const menuFill = await js(win, `getComputedStyle(document.getElementById('mmenu')).backgroundColor`);
    check(`${theme}: the More menu is opaque and follows the theme`, menuFill === (theme === 'dark' ? 'rgb(44, 44, 48)' : 'rgb(255, 255, 255)'), menuFill);
    await shot(win, `editor-${theme}-edited.png`);
    await js(win, `document.querySelector('#mmenu .mi').click()`);
    await sleep(600);
    const chips = await js(win, `(() => { const rect = (n) => { const r = n.getBoundingClientRect(); return [r.left + 6, r.top + r.height / 2]; }; return [rect(document.querySelector('.card .chip.on')), rect(document.querySelector('.card .chip:not(.on)')), devicePixelRatio]; })()`);
    const cardPixels = await pixelsOf(win);
    const [pickedChip, otherChip] = [cardPixels.at(chips[0][0] * chips[2], chips[0][1] * chips[2]), cardPixels.at(chips[1][0] * chips[2], chips[1][1] * chips[2])];
    console.log(`  (${theme} chip chosen ${pickedChip}, others ${otherChip}: contrast ${contrast(pickedChip, otherChip).toFixed(2)})`);
    check(`${theme}: the chosen chip is told from the others`, JSON.stringify(pickedChip) !== JSON.stringify(otherChip) && contrast(pickedChip, otherChip) >= 1.1, `${pickedChip} ${otherChip}`);
    await shot(win, `editor-${theme}-save-card.png`);
    await js(win, `[...document.querySelectorAll('.card .chip')].find((b) => b.textContent === 'Custom').click()`);
    await sleep(300);
    await shot(win, `editor-${theme}-save-card-custom.png`);
    await closeAll(editor);
  }
  nativeTheme.themeSource = 'light';

  console.log(failed() ? `\n${failed()} failed` : '\nall passed');
  finish();
  app.quit();
});

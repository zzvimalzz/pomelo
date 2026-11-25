// SPDX-License-Identifier: AGPL-3.0-or-later
// Saving the editor's pixels: over the original, as a copy, and every way it can stop.   node test/unit/image-editor/save.test.js
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { createImages } = require('../../../src/features/image-editor/images');
const { createSave } = require('../../../src/features/image-editor/save');
const { readImage, writeImage } = require('../../../src/features/conversion/engines/builtin/images');
const { uniquePath } = require('../../../src/features/conversion/engine-kit/outputs');
const { extOf } = require('../../../src/features/conversion/catalog/formats');
const { expect } = require('../../support/expect');
const finish = require('../../support/finish');
const { dir } = require('../../support/tmp');

const root = dir('editor-save');
sharp.cache(false);
const W = 40, H = 30;
const pixels = (r, g, b, a = 255) => { const data = new Uint8Array(W * H * 4); for (let i = 0; i < W * H; i++) data.set([r, g, b, a], i * 4); return data; };
const sizes = { width: W, height: H };
const threw = async (fn) => { try { await fn(); return false; } catch { return true; } };

(async () => {
  const notices = [];
  let nextPath = null;
  const shown = [];
  const images = createImages({ readImage: async () => ({ data: Buffer.alloc(W * H * 4), width: W, height: H, hasAlpha: false }), extOf });
  const { save } = createSave({ images, writeImage, uniquePath, notify: (m) => notices.push(m), log: () => {}, chooseSavePath: async () => nextPath, show: async (file) => { shown.push(file); return true; } });

  const photo = async (name) => {
    const file = path.join(root, name);
    await sharp({ create: { width: W, height: H, channels: 3, background: { r: 10, g: 200, b: 90 } } }).withExif({ IFD0: { Copyright: 'Pomelo test', Make: 'Camera' } }).jpeg().toFile(file);
    return { file, token: (await images.open(file)).token };
  };
  const look = async (file) => { const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); const meta = await sharp(file).metadata(); return { ...info, first: [...data.subarray(0, 4)], exif: !!meta.exif, format: meta.format }; };

  console.log('over the original');
  let { file, token } = await photo('over.jpg');
  const before = fs.statSync(file).size;
  expect('a JPG is written over, and the answer is ok', (await save(token, pixels(200, 20, 20), { mode: 'replace', format: 'same', ...sizes }))?.ok === true);
  let now = await look(file);
  expect('it is still a JPG of the same size, now red', now.format === 'jpeg' && now.width === W && now.height === H && now.first[0] > 180 && now.first[1] < 60 && fs.statSync(file).size !== before, JSON.stringify(now));
  expect('and it keeps the camera and copyright tags', now.exif === true);
  expect('a second save works, because the new identity was kept', (await save(token, pixels(20, 20, 200), { mode: 'replace', format: 'same', ...sizes }))?.ok === true && (await look(file)).first[2] > 180);
  expect('nothing is left in the folder but the file', fs.readdirSync(root).filter((n) => n.includes('over')).join() === 'over.jpg');

  console.log('another program got there first');
  ({ file, token } = await photo('changed.jpg'));
  await new Promise((r) => setTimeout(r, 30));
  fs.appendFileSync(file, 'x');
  expect('a file that was changed is not written over', (await save(token, pixels(1, 2, 3), { mode: 'replace', format: 'same', ...sizes }))?.stop === 'changed' && notices.length === 0);
  fs.rmSync(file);
  expect('and neither is one that was deleted', (await save(token, pixels(1, 2, 3), { mode: 'replace', format: 'same', ...sizes }))?.stop === 'changed');

  console.log('a read-only file');
  ({ file, token } = await photo('locked.jpg'));
  fs.chmodSync(file, 0o444);
  expect('a read-only file stops the save, with the sentence for it', (await save(token, pixels(1, 2, 3), { mode: 'replace', format: 'same', ...sizes }))?.stop === 'read-only' && notices.at(-1)?.title === "Can't save" && notices.at(-1)?.detail === 'locked.jpg is read-only. Save a copy instead.', JSON.stringify(notices.at(-1)));
  fs.chmodSync(file, 0o666);

  console.log('a picture that was read can be deleted');
  const webp = path.join(root, 'read.webp');
  await sharp({ create: { width: 8, height: 8, channels: 3, background: '#4a8' } }).webp().toFile(webp);
  sharp.cache(true);
  await readImage(webp, { maxPixels: 1e6, maxEdge: 1e4 });
  expect('a WebP the editor has read is not held open', await fs.promises.rm(webp).then(() => true, () => false));

  console.log('a copy');
  ({ file, token } = await photo('copy.jpg'));
  nextPath = path.join(root, 'copy (edited).png');
  expect('a copy in another format is written where the user chose, and is opened as a tab', (await save(token, pixels(200, 20, 20, 255), { mode: 'copy', format: 'png', ...sizes }))?.copy === true && (await look(nextPath)).format === 'png' && shown.at(-1) === nextPath);
  expect('and the original is as it was', (await look(file)).first[1] > 150);
  nextPath = path.join(root, 'small.webp');
  expect('a smaller long edge scales the picture', (await save(token, pixels(200, 20, 20), { mode: 'copy', format: 'webp', quality: 70, longEdge: 20, ...sizes }))?.ok === true && (await look(nextPath)).width === 20 && (await look(nextPath)).height === 15);
  nextPath = path.join(root, 'noext.txt');
  expect('a name with the wrong extension gets the right one, and nothing is overwritten', (await save(token, pixels(1, 2, 3), { mode: 'copy', format: 'png', ...sizes }))?.ok === true && fs.existsSync(path.join(root, 'noext.txt.png')) && !fs.existsSync(nextPath));
  nextPath = null;
  expect('cancelling the dialog stops quietly and writes nothing', (await save(token, pixels(1, 2, 3), { mode: 'copy', format: 'png', ...sizes }))?.stop === 'cancelled' && fs.readdirSync(root).every((n) => !n.includes('tmp')));
  nextPath = file;
  const reread = fs.statSync(file).mtimeMs;
  expect('a copy chosen over the original itself is a save over it, so a second one works', (await save(token, pixels(5, 5, 200), { mode: 'copy', format: 'jpg', ...sizes }))?.copy === undefined && (await save(token, pixels(5, 200, 5), { mode: 'replace', format: 'same', ...sizes }))?.ok === true && fs.statSync(file).mtimeMs !== reread);

  console.log('what the page may not do');
  expect('pixels of the wrong length are refused', await threw(() => save(token, new Uint8Array(10), { mode: 'copy', format: 'png', ...sizes })));
  expect('so is something that is not a byte array', await threw(() => save(token, [1, 2, 3], { mode: 'copy', format: 'png', ...sizes })));
  expect('a token that is not open', await threw(() => save('f'.repeat(64), pixels(1, 2, 3), { mode: 'copy', format: 'png', ...sizes })));
  expect('a save over the original in another format, or smaller', await threw(() => save(token, pixels(1, 2, 3), { mode: 'replace', format: 'png', ...sizes })) && await threw(() => save(token, pixels(1, 2, 3), { mode: 'replace', format: 'same', longEdge: 20, ...sizes })));
  const heic = path.join(root, 'phone.heic');
  fs.writeFileSync(heic, 'x');
  const phone = (await images.open(heic)).token;
  expect('a HEIC file cannot be written over, nor saved as "same"', await threw(() => save(phone, pixels(1, 2, 3), { mode: 'replace', format: 'same', ...sizes })) && await threw(() => save(phone, pixels(1, 2, 3), { mode: 'copy', format: 'same', ...sizes })));
  nextPath = path.join(root, 'phone.jpg');
  expect('but a copy of it as a JPG is fine', (await save(phone, pixels(1, 2, 3), { mode: 'copy', format: 'jpg', ...sizes }))?.ok === true && (await look(nextPath)).format === 'jpeg');

  console.log('a save at a time');
  const busy = images.get(token);
  busy.saving = true;
  expect('a second save while one runs is turned away', (await save(token, pixels(1, 2, 3), { mode: 'copy', format: 'png', ...sizes }))?.stop === 'busy');
  busy.saving = false;
  finish();
})().catch((e) => { console.error(e); finish(2); });

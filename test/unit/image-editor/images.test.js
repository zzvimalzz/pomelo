// SPDX-License-Identifier: AGPL-3.0-or-later
// The pictures the editor holds: opening one, the same file twice, ten tabs, the pieces the page reads and the copy that is freed once
// it has them.   node test/unit/image-editor/images.test.js
const fs = require('fs');
const path = require('path');
const { createImages } = require('../../../src/features/image-editor/images');
const { extOf } = require('../../../src/features/conversion/catalog/formats');
const { MAX_TABS, MAX_PIXELS, MAX_EDGE, PIECE } = require('../../../src/features/image-editor/limits');
const { expect } = require('../../support/expect');
const finish = require('../../support/finish');
const { dir } = require('../../support/tmp');

const root = dir('images');
const make = (name) => { const file = path.join(root, name); fs.writeFileSync(file, 'x'); return file; };
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const asked = [];
const readImage = async (file, limits) => {
  asked.push(limits);
  const width = 3, height = 2;
  return { data: Buffer.from(Array.from({ length: width * height * 4 }, (_, i) => i)), width, height, hasAlpha: path.extname(file) === '.png' };
};

(async () => {
  const images = createImages({ readImage, extOf });

  console.log('opening a picture');
  const jpg = make('Photo.JPG');
  const info = await images.open(jpg);
  expect('it is described by a random 64 character token, its name, format and size', /^[0-9a-f]{64}$/.test(info.token) && info.name === 'Photo.JPG' && info.ext === 'jpg' && info.width === 3 && info.height === 2, JSON.stringify(info));
  expect('its format has spellings like .jpeg folded in, and Save can write over a JPG but not a HEIC', info.writable === true && (await images.open(make('c.jpeg'))).ext === 'jpg' && (await images.open(make('d.heic'))).writable === false);
  expect('and by whether it can be transparent', info.alpha === false && (await images.open(make('b.png'))).alpha === true);
  expect('the decoder is told the limits', asked[0].maxPixels === MAX_PIXELS && asked[0].maxEdge === MAX_EDGE, JSON.stringify(asked[0]));
  expect('the page is told nothing of the path', !('file' in info) && !('file' in images.list()[0]));
  const decoded = asked.length;
  expect('a file that is not there is refused before it is decoded, with its error code', (await threw(() => images.open(path.join(root, 'gone.png'))))?.code === 'ENOENT' && asked.length === decoded);
  expect('and a folder is refused too', (await threw(() => images.open(root)))?.code === 'ENOTFILE');

  console.log('the same file twice, and many files');
  expect('another spelling of the same path finds the picture that is open', images.find(path.join(root, 'photo.jpg'))?.token === info.token);
  expect('a file that is not open is not found', images.find(path.join(root, 'other.jpg')) === null);
  for (let n = images.list().length; n < MAX_TABS; n++) await images.open(make(`many-${n}.jpg`));
  expect(`${MAX_TABS} pictures can be open at once, in the order they were opened`, images.list().length === MAX_TABS && images.list()[0].token === info.token);

  console.log('reading the pixels');
  const piece = images.pixels(info.token, 4, 12);
  expect('a piece holds the bytes asked for, copied into a buffer of its own size', piece.length === 8 && piece[0] === 4 && piece[7] === 11 && piece.buffer.byteLength === 8, `${piece.length} ${piece.buffer.byteLength}`);
  expect('the whole picture can be read at once', images.pixels(info.token, 0, 24).length === 24);
  const bad = [[-1, 4], [0, 0], [4, 2], [0, 25], [1.5, 4], ['0', 4], [0, PIECE + 1]];
  expect('a range outside the picture, or larger than a piece, is refused', bad.every(([b, e]) => { try { images.pixels(info.token, b, e); return false; } catch { return true; } }));
  expect('so is a token that is not one of the open pictures', ['f'.repeat(64), '', null, 5, {}].every((t) => { try { images.pixels(t, 0, 4); return false; } catch { return true; } }));
  images.pixelsDone(info.token);
  expect('once the page has the pixels the main process lets go of its copy', (() => { try { images.pixels(info.token, 0, 4); return false; } catch { return true; } })());
  expect('and the picture is still open', images.find(jpg)?.token === info.token && images.fileOf(info.token) === jpg);

  console.log('what Save needs');
  const entry = images.get(info.token);
  expect('the file and what it was when it was read are kept for the main process', entry.file === jpg && entry.identity.size === 1 && typeof entry.identity.ino === 'string');
  expect('no picture has changes until the page says so', !images.anyDirty());
  images.setDirty(info.token, true);
  expect('the page can say a picture has changes, and say it has none', images.anyDirty() && (images.setDirty(info.token, false), !images.anyDirty()));

  console.log('closing');
  images.close(info.token);
  expect('a closed picture is gone', images.find(jpg) === null && images.list().length === MAX_TABS - 1);
  expect('and can be opened again as a new tab', (await images.open(jpg)).token !== info.token);
  images.closeAll();
  expect('closing everything leaves nothing', images.list().length === 0);

  finish();
})().catch((e) => { console.error(e); finish(2); });

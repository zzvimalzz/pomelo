// SPDX-License-Identifier: AGPL-3.0-or-later
// The pictures the editor has open, one for each tab. A picture is decoded once, when it is opened; the page reads the pixels in pieces
// and then says it has them, which frees the main process's copy. The page never gets a path. No Electron in here.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { MAX_PIXELS, MAX_EDGE, PIECE } = require('./limits');

const keyOf = (file) => path.resolve(file).toLowerCase();
const info = ({ token, name, ext, width, height, alpha }) => ({ token, name, ext, width, height, alpha });

// readImage(file, { maxPixels, maxEdge }): decodes a picture to upright sRGB RGBA, resolving { data, width, height, hasAlpha } (the
// conversion feature's, handed in by the app).
function createImages({ readImage }) {
  const byToken = new Map();

  const get = (token) => {
    const image = typeof token === 'string' ? byToken.get(token) : null;
    if (!image) throw new Error('unknown image');
    return image;
  };

  // Windows paths are not case-sensitive, so two spellings of one file are one picture.
  const find = (file) => { const image = [...byToken.values()].find((i) => i.key === keyOf(file)); return image ? info(image) : null; };
  const list = () => [...byToken.values()].map(info);

  async function open(file) {
    if (!(await fs.promises.stat(file)).isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOTFILE' });
    const { data, width, height, hasAlpha } = await readImage(file, { maxPixels: MAX_PIXELS, maxEdge: MAX_EDGE });
    const image = {
      token: crypto.randomBytes(32).toString('hex'), file, key: keyOf(file), name: path.basename(file), ext: path.extname(file).slice(1).toLowerCase(),
      width, height, alpha: hasAlpha, data,
    };
    byToken.set(image.token, image);
    return info(image);
  }

  // A copy of the bytes from begin to end. A view of the big buffer would make Electron send the whole buffer with every piece.
  function pixels(token, begin, end) {
    const { data } = get(token);
    if (!data || !Number.isInteger(begin) || !Number.isInteger(end) || begin < 0 || end <= begin || end > data.length || end - begin > PIECE) throw new Error('bad range');
    const piece = new Uint8Array(end - begin);
    piece.set(data.subarray(begin, end));
    return piece;
  }

  const pixelsDone = (token) => { get(token).data = null; };
  const fileOf = (token) => get(token).file;
  const close = (token) => { byToken.delete(get(token).token); };

  return { find, list, open, pixels, pixelsDone, fileOf, close, closeAll: () => byToken.clear() };
}

module.exports = { createImages };

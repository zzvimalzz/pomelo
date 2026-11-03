// SPDX-License-Identifier: AGPL-3.0-or-later
// HEIC output through pillow-heif (Python, separate process). HEIC input is decoded in pure.js with heic-convert (WASM).
const fs = require('fs');
const path = require('path');
const { run, uniquePath, tempPath } = require('../convert/util');

const unpacked = (p) => p.replace('app.asar', 'app.asar.unpacked');
const SCRIPT = unpacked(path.join(__dirname, '..', '..', '..', 'scripts', 'heic_run.py'));
// Pillow reads these directly; anything else is turned into a PNG first.
const DIRECT = new Set(['png', 'jpg', 'webp', 'bmp', 'gif', 'tiff']);
const FROM = new Set([...DIRECT, 'avif', 'svg']);

module.exports = {
  name: 'heic',
  supports: (from, to, engines) => !!engines.heic && to === 'heic' && FROM.has(from),
  async run({ src, from, dir, base, engines }) {
    const out = uniquePath(dir, base, 'heic');
    let input = src;
    let temp = null;
    try {
      if (!DIRECT.has(from)) {
        temp = tempPath('png');
        await require('sharp')(src, { density: from === 'svg' ? 192 : undefined }).png().toFile(temp);
        input = temp;
      }
      await run(engines.heic, ['-W', 'ignore', SCRIPT, input, out], { timeout: 300000 });
    } finally { if (temp) fs.rmSync(temp, { force: true }); }
    if (!fs.existsSync(out)) throw new Error('HEIC encoder produced no output');
    return [out];
  },
};

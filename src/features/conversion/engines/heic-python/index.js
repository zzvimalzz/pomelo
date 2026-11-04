// SPDX-License-Identifier: AGPL-3.0-or-later
// HEIC output through pillow-heif (Python, separate process). HEIC input is decoded in pure.js with heic-convert (WASM).
const fs = require('fs');
const { run, uniquePath } = require('../convert/util');
const { withTempFile } = require('../../shared/node/fs');
const { extsInGroup } = require('../formats');
const { scriptPath } = require('../../shared/node/paths');

const SCRIPT = scriptPath('heic_run.py');
// Pillow reads these directly; anything else is turned into a PNG first.
const DIRECT = new Set(['png', 'jpg', 'webp', 'bmp', 'gif', 'tiff']);
const FROM = new Set(extsInGroup('image').filter((e) => e !== 'heic'));

module.exports = {
  name: 'heic',
  supports: (from, to, engines) => !!engines.heic && to === 'heic' && FROM.has(from),
  async run({ src, from, dir, base, engines }) {
    const out = uniquePath(dir, base, 'heic');
    const encode = (input) => run(engines.heic, ['-W', 'ignore', SCRIPT, input, out], { timeout: 300000 });
    if (DIRECT.has(from)) await encode(src);
    else await withTempFile('png', async (temp) => {
      await require('sharp')(src, { density: from === 'svg' ? 192 : undefined }).png().toFile(temp);
      await encode(temp);
    });
    if (!fs.existsSync(out)) throw new Error('HEIC encoder produced no output');
    return [out];
  },
};

// SPDX-License-Identifier: AGPL-3.0-or-later
// HEIC output through pillow-heif (Python, separate process). HEIC input is decoded by the built-in images engine with heic-convert (WASM).
const { uniquePath, assertProduced } = require('../../engine-kit/outputs');
const { findPython, runHelper } = require('../../engine-kit/python');
const { extsInGroup } = require('../../catalog/formats');
const { sharpFrom } = require('../../lib/image-input');
const { withTempFile } = require('../../../../shared/node/fs');

// Pillow reads these directly; anything else is turned into a PNG first.
const DIRECT = new Set(['png', 'jpg', 'webp', 'bmp', 'gif', 'tiff']);
const FROM = new Set(extsInGroup('image').filter((e) => e !== 'heic'));

module.exports = {
  name: 'heic',
  detect: () => ({ heic: findPython('pillow_heif, PIL') }),
  supports: (from, to, engines) => !!engines.heic && to === 'heic' && FROM.has(from),
  async run({ src, from, dir, base, engines }) {
    const out = uniquePath(dir, base, 'heic');
    const encode = (input) => runHelper(engines.heic, 'heic_run.py', [input, out], { timeout: 300000 });
    if (DIRECT.has(from)) await encode(src);
    else await withTempFile('png', async (temp) => {
      await sharpFrom(src, from).png().toFile(temp);
      await encode(temp);
    });
    assertProduced(out, 'HEIC encoder');
    return [out];
  },
};

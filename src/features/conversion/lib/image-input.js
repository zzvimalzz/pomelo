// SPDX-License-Identifier: AGPL-3.0-or-later
// Opening an image with sharp. A vector image is rasterised at 192 dpi (twice the screen's 96), so it is not blurry when printed.

function sharpFrom(src, from, options = {}) {
  const sharp = require('sharp');
  // libvips keeps the files it read open in its cache (a WebP stays open for good), and Windows will not delete or move an open file.
  sharp.cache(false);
  return sharp(src, { density: from === 'svg' ? 192 : undefined, ...options });
}

module.exports = { sharpFrom };

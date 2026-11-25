// SPDX-License-Identifier: AGPL-3.0-or-later
// The options the page sends with the pixels to save. The page is trusted no further than any other input: check returns a clean copy
// or throws. No Electron in here.
const { MAX_PIXELS, MAX_EDGE } = require('./limits');

const FORMATS = ['same', 'jpg', 'png', 'webp', 'avif', 'tiff'];
const MODES = ['replace', 'copy'];
const MIN_LONG_EDGE = 16;

const whole = (value, low, high) => Number.isInteger(value) && value >= low && value <= high;

function check(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('bad save options');
  const { mode, format, quality, longEdge, width, height } = raw;
  if (!MODES.includes(mode) || !FORMATS.includes(format)) throw new Error('bad save options');
  if (!whole(width, 1, MAX_EDGE) || !whole(height, 1, MAX_EDGE) || width * height > MAX_PIXELS) throw new Error('bad picture size');
  if (quality != null && !whole(quality, 1, 100)) throw new Error('bad quality');
  if (longEdge != null && !whole(longEdge, MIN_LONG_EDGE, Math.max(width, height))) throw new Error('bad long edge');
  return { mode, format, quality: quality ?? null, longEdge: longEdge ?? null, width, height };
}

module.exports = { check };

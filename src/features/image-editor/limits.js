// SPDX-License-Identifier: AGPL-3.0-or-later
// What the image editor will open: how many pictures at once, how large one may be, and which formats. No Electron in here.
const MAX_TABS = 10;
const MAX_PIXELS = 50_000_000;
const MAX_EDGE = 16384;
const PIECE = 16 * 1048576;
const EDITABLE = ['png', 'jpg', 'webp', 'avif', 'tiff', 'bmp', 'gif', 'heic', 'svg'];

const editable = (ext) => EDITABLE.includes(ext);

module.exports = { MAX_TABS, MAX_PIXELS, MAX_EDGE, PIECE, EDITABLE, editable };

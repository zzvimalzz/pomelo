// SPDX-License-Identifier: AGPL-3.0-or-later
// The options the page sends with the pixels to save: a clean copy, or an error.   node test/unit/image-editor/save-options.test.js
const { check } = require('../../../src/features/image-editor/save-options');
const { expect } = require('../../support/expect');
const finish = require('../../support/finish');

const good = { mode: 'copy', format: 'jpg', quality: 80, longEdge: 1000, width: 4000, height: 3000 };
const threw = (raw) => { try { check(raw); return false; } catch { return true; } };

expect('valid options come back as they are', JSON.stringify(check(good)) === JSON.stringify(good));
expect('a missing quality or long edge is null', (() => { const c = check({ mode: 'replace', format: 'same', width: 3, height: 2 }); return c.quality === null && c.longEdge === null; })());
expect('a field that is not asked for is dropped', !('path' in check({ ...good, path: 'C:\\x' })));
expect('every format the card offers is accepted', ['same', 'jpg', 'png', 'webp', 'avif', 'heic', 'tiff', 'bmp', 'gif', 'pdf'].every((format) => !threw({ ...good, format })));
expect('a format that does not exist is refused', ['svg', 'jxl', 'JPG', '', null, 5].every((format) => threw({ ...good, format })));
expect('so is a mode that does not exist', ['move', '', null].every((mode) => threw({ ...good, mode })));
expect('quality is a whole number from 1 to 100', [0, 101, 1.5, '80', NaN].every((quality) => threw({ ...good, quality })) && [1, 100].every((quality) => !threw({ ...good, quality })));
expect('the long edge is a whole number from 16 up to the picture\'s own long edge', [15, 4001, 1.5, '100'].every((longEdge) => threw({ ...good, longEdge })) && [16, 4000].every((longEdge) => !threw({ ...good, longEdge })));
expect('width and height are whole numbers up to 16384', [0, -1, 16385, 2.5, '3'].every((width) => threw({ ...good, width })) && !threw({ ...good, width: 16384, height: 3000 }));
expect('and the picture is at most 50 megapixels', threw({ ...good, width: 10000, height: 5001 }) && !threw({ ...good, width: 10000, height: 5000 }));
expect('anything that is not an object is refused', [null, undefined, 'x', 5].every(threw));
finish();

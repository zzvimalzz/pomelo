// SPDX-License-Identifier: AGPL-3.0-or-later
// What the editor opens: its limits, and that its list of formats is the pictures the converter knows.   node test/unit/image-editor/limits.test.js
const { MAX_TABS, MAX_PIXELS, MAX_EDGE, PIECE, EDITABLE, editable } = require('../../../src/features/image-editor/limits');
const { extsInGroup, extOf } = require('../../../src/features/conversion/catalog/formats');
const { expect } = require('../../support/expect');
const finish = require('../../support/finish');

expect('ten pictures, 50 megapixels, 16384 pixels on a side, pieces of 16 MiB', MAX_TABS === 10 && MAX_PIXELS === 50_000_000 && MAX_EDGE === 16384 && PIECE === 16 * 1048576);
expect('every format of the picture group can be edited but GIF, which is mostly animation', [...EDITABLE].sort().join() === extsInGroup('image').filter((ext) => ext !== 'gif').sort().join(), EDITABLE.join());
expect('a GIF is not offered the editor', !editable(extOf('a.GIF')));
expect('the converter folds spellings in before the editor asks', ['a.JPEG', 'a.tif', 'a.heif', 'a.PNG'].every((name) => editable(extOf(name))));
expect('documents, PDFs and folders are not pictures', ['a.docx', 'a.pdf', 'a.mp4', 'C:\\Photos'].every((name) => !editable(extOf(name))));
finish();

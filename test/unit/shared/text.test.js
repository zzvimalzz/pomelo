// SPDX-License-Identifier: AGPL-3.0-or-later
// shared/core/text.js: the name shortening the wheel and the toast rely on, capitalising and HTML escaping.
const { middleEllipsis, capitalize, escapeHtml } = require('../../../src/shared/core/text');
const { expect } = require('../../support/expect');
const finish = require('../../support/finish');

console.log('shortening a name in the middle');
expect('a name that fits is left alone', middleEllipsis('report.docx', 15) === 'report.docx');
expect('exactly as long as the limit is left alone', middleEllipsis('123456789012345', 15) === '123456789012345');
expect('a long name keeps its start and its end, and is exactly the limit long', middleEllipsis('Quarterly report final.docx', 15) === 'Quarterly….docx' && middleEllipsis('Quarterly report final.docx', 15).length === 15, middleEllipsis('Quarterly report final.docx', 15));
expect('the toast limit of 30 keeps the extension', middleEllipsis('a very long holiday video of the whole family 2026.mp4', 30).endsWith('2026.mp4') && middleEllipsis('a very long holiday video of the whole family 2026.mp4', 30).length === 30);

console.log('capitalising and escaping');
expect('capitalize makes the first letter a capital', capitalize('ctrl') === 'Ctrl' && capitalize('Shift') === 'Shift');
expect('escapeHtml escapes & < > and "', escapeHtml('<a href="x">Tom & Jerry</a>') === '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&lt;/a&gt;');
expect('and accepts what is not a string', escapeHtml(42) === '42');

finish();

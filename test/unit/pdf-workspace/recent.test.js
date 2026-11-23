// SPDX-License-Identifier: AGPL-3.0-or-later
// The list of PDFs opened lately: newest first, no repeats, at most ten, and only what a person could have opened.
//   node test/unit/pdf-workspace/recent.test.js
const fs = require('fs');
const path = require('path');
const { addRecent, startFolder } = require('../../../src/features/pdf-workspace/recent');
const { expect } = require('../../support/expect');
const finish = require('../../support/finish');
const { dir: tmpDir } = require('../../support/tmp');

const root = tmpDir('ws-recent');
const file = (name) => path.join(root, name);

console.log('adding');
expect('a file goes to the front', addRecent([file('a.pdf')], file('b.pdf')).join() === [file('b.pdf'), file('a.pdf')].join());
expect('a file that is there already moves to the front, whatever the case', addRecent([file('a.pdf'), file('b.pdf')], file('B.PDF')).join() === [file('B.PDF'), file('a.pdf')].join());
const many = Array.from({ length: 10 }, (_, i) => file(`${i}.pdf`));
expect('only the ten newest are kept', addRecent(many, file('new.pdf')).length === 10 && addRecent(many, file('new.pdf'))[9] === file('8.pdf'));
expect('a list that is not a list starts again', addRecent(undefined, file('a.pdf')).join() === file('a.pdf') && addRecent('x', file('a.pdf')).length === 1);
expect('entries that are not full paths are dropped', addRecent([1, null, 'relative.pdf', file('a.pdf')], file('b.pdf')).join() === [file('b.pdf'), file('a.pdf')].join());

console.log('where the dialog starts');
const folder = path.join(root, 'kept');
fs.mkdirSync(folder);
expect('in the folder of the newest file whose folder is still there', startFolder([path.join(root, 'gone', 'a.pdf'), path.join(folder, 'b.pdf')]) === folder);
expect('nowhere when there is nothing, or nothing is left', startFolder([]) === undefined && startFolder(undefined) === undefined && startFolder([path.join(root, 'gone', 'a.pdf')]) === undefined);
finish();

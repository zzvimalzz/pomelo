// SPDX-License-Identifier: AGPL-3.0-or-later
// The list of changes the page may ask for: what is allowed, what is refused, and that only the keys an operation takes get through.
//   node test/unit/pdf-workspace/ops.test.js
const { check, OPS } = require('../../../src/features/pdf-workspace/ops');
const { expect } = require('../../support/expect');
const finish = require('../../support/finish');

const refused = (list) => { try { check(list); return false; } catch { return true; } };

console.log('what is allowed');
expect('a rotation and a deletion are allowed, and come back as they were given', JSON.stringify(check([{ op: 'pages.rotate', pages: [3, 4], by: 90 }, { op: 'pages.delete', pages: [1] }])) === '[{"op":"pages.rotate","pages":[3,4],"by":90},{"op":"pages.delete","pages":[1]}]');
expect('a page turns by 90, 180 or 270', [90, 180, 270].every((by) => !refused([{ op: 'pages.rotate', pages: [1], by }])));
expect('a rotation edits in place and a deletion rewrites the file',OPS['pages.rotate'].kind === 'direct' && OPS['pages.delete'].kind === 'rewrite');
const info = { op: 'meta.set', title: 'Annual report', author: '', subject: 'Résumé 日本', keywords: 'a, b' };
expect('the document information is set as four texts, which may be empty, and edits in place', JSON.stringify(check([info])) === JSON.stringify([info]) && OPS['meta.set'].kind === 'direct');
expect('a text of 1000 characters is allowed', !refused([{ ...info, title: 'x'.repeat(1000) }]));

console.log('what is refused');
const bad = {
  'no list': undefined, 'a list that is not a list': { op: 'pages.delete', pages: [1] }, 'an empty list': [],
  'more than 1000 changes': Array.from({ length: 1001 }, () => ({ op: 'pages.delete', pages: [1] })),
  'something that is not a change': ['pages.delete'], 'a null change': [null], 'a change with no name': [{ pages: [1] }],
  'an unknown change': [{ op: 'pages.shred', pages: [1] }], 'a name that is on every object': [{ op: 'constructor', pages: [1] }],
  'a name from the prototype': [{ op: '__proto__' }], 'a name that is not text': [{ op: 5 }],
  'a key the change does not take': [{ op: 'pages.delete', pages: [1], password: 'x' }],
  'a password where the page may not put one': [{ op: 'pages.rotate', pages: [1], by: 90, password: 'x' }],
  'a missing key': [{ op: 'pages.rotate', pages: [1] }], 'no pages': [{ op: 'pages.delete' }],
  'an empty page list': [{ op: 'pages.delete', pages: [] }], 'pages that are not a list': [{ op: 'pages.delete', pages: 1 }],
  'page 0': [{ op: 'pages.delete', pages: [0] }], 'a negative page': [{ op: 'pages.delete', pages: [-1] }],
  'a fractional page': [{ op: 'pages.delete', pages: [1.5] }], 'a page that is text': [{ op: 'pages.delete', pages: ['1'] }],
  'a page over a million': [{ op: 'pages.delete', pages: [1000001] }], 'the same page twice': [{ op: 'pages.delete', pages: [2, 2] }],
  'a turn by 45': [{ op: 'pages.rotate', pages: [1], by: 45 }], 'a turn by text': [{ op: 'pages.rotate', pages: [1], by: '90' }],
  'a turn by 360': [{ op: 'pages.rotate', pages: [1], by: 360 }], 'a turn by -90': [{ op: 'pages.rotate', pages: [1], by: -90 }],
  'a title of 1001 characters': [{ ...info, title: 'x'.repeat(1001) }], 'a title that is not text': [{ ...info, title: 5 }], 'a title with a null character': [{ ...info, title: 'a\0b' }],
  'document information with a key missing': [{ op: 'meta.set', title: 'a', author: 'b', subject: 'c' }], 'document information with a key it does not take': [{ ...info, producer: 'x' }],
  'a good change followed by a bad one': [{ op: 'pages.delete', pages: [1] }, { op: 'pages.delete', pages: [0] }],
};
for (const [what, list] of Object.entries(bad)) expect(`${what} is refused`, refused(list));

console.log('what gets through');
const given = { op: 'pages.delete', pages: [2], extra: 1 };
expect('a list with a key it does not take never reaches the file', refused([given]));
const checked = check([{ op: 'pages.delete', pages: [2] }]);
expect('the checked list is a copy, not the object the page sent', checked[0] !== given && checked[0].pages !== given.pages);
finish();

// SPDX-License-Identifier: AGPL-3.0-or-later
// The list of changes the page may ask for: what is allowed, what is refused, and that only the keys an operation takes get through.
//   node test/unit/pdf-workspace/ops.test.js
const { check, arrange, pageRanges, splitParts, OPS, PICTURE_EXTENSIONS } = require('../../../src/features/pdf-workspace/ops');
const { expect } = require('../../support/expect');
const finish = require('../../support/finish');

const refused = (list) => { try { check(list); return false; } catch { return true; } };

console.log('what is allowed');
expect('a rotation and a deletion are allowed, and come back as they were given', JSON.stringify(check([{ op: 'pages.rotate', pages: [3, 4], by: 90 }, { op: 'pages.delete', pages: [1] }])) === '[{"op":"pages.rotate","pages":[3,4],"by":90},{"op":"pages.delete","pages":[1]}]');
expect('a page turns by 90, 180 or 270', [90, 180, 270].every((by) => !refused([{ op: 'pages.rotate', pages: [1], by }])));
expect('a rotation edits in place and a deletion rewrites the file',OPS['pages.rotate'].kind === 'direct' && OPS['pages.delete'].kind === 'rewrite');
expect('pages move before another page, or to the end, and edit in place', JSON.stringify(check([{ op: 'pages.move', pages: [5, 2], before: 1 }, { op: 'pages.move', pages: [1], before: 1000001 }])) === '[{"op":"pages.move","pages":[5,2],"before":1},{"op":"pages.move","pages":[1],"before":1000001}]' && OPS['pages.move'].kind === 'direct');
const ids = ['a'.repeat(32), 'b'.repeat(32)];
expect('files are inserted before a page by the ids they were given, and a blank page needs only its place', JSON.stringify(check([{ op: 'pages.insert', before: 3, sources: ids }, { op: 'pages.blank', before: 1 }])) === JSON.stringify([{ op: 'pages.insert', before: 3, sources: ids }, { op: 'pages.blank', before: 1 }]));
expect('inserting and a blank page add to the file, and extracting writes another one', OPS['pages.insert'].kind === 'new' && OPS['pages.blank'].kind === 'new' && OPS['pages.extract'].kind === 'output');
expect('pictures of the usual kinds can be inserted, and no program or archive', PICTURE_EXTENSIONS.includes('png') && PICTURE_EXTENSIONS.includes('jpg') && !PICTURE_EXTENSIONS.some((e) => ['exe', 'pdf', 'zip'].includes(e)));
const info = { op: 'meta.set', title: 'Annual report', author: '', subject: 'Résumé 日本', keywords: 'a, b' };
expect('the document information is set as four texts, which may be empty, and edits in place', JSON.stringify(check([info])) === JSON.stringify([info]) && OPS['meta.set'].kind === 'direct');
expect('a text of 1000 characters is allowed', !refused([{ ...info, title: 'x'.repeat(1000) }]));
const quad = [10, 10, 90, 10, 10, 30, 90, 30];
const highlight = { op: 'annot.add', type: 'highlight', page: 2, color: [255, 216, 77], quads: [quad] };
const ink = { op: 'annot.add', type: 'ink', page: 1, color: [0, 0, 0], opacity: 0.4, thickness: 6, paths: [[0, 0, 10, 10, 20, 5]] };
const note = { op: 'annot.add', type: 'freetext', page: 1, color: [0, 0, 255], rect: [10, 10, 200, 40], text: 'Café 日本', size: 12, font: 'Times' };
expect('a highlight, an ink stroke and a text box are allowed, come back as given, and are added in place', JSON.stringify(check([highlight, ink, note])) === JSON.stringify([highlight, ink, note]) && OPS['annot.add'].kind === 'annotate');
expect('a text box may carry a quarter turn', [0, 90, 180, 270].every((turn) => !refused([{ ...note, turn }])));
expect('a key a kind of markup may leave out is not carried as undefined', !('opacity' in check([highlight])[0]));

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
  'a move with no place': [{ op: 'pages.move', pages: [1] }], 'a move to place 0': [{ op: 'pages.move', pages: [1], before: 0 }], 'a move to a fractional place': [{ op: 'pages.move', pages: [1], before: 1.5 }],
  'a move to a place that is text': [{ op: 'pages.move', pages: [1], before: '2' }], 'a move past the last possible place': [{ op: 'pages.move', pages: [1], before: 1000002 }],
  'a move of no pages': [{ op: 'pages.move', pages: [], before: 1 }], 'a move that takes a rotation too': [{ op: 'pages.move', pages: [1], before: 2, by: 90 }],
  'inserting with no files': [{ op: 'pages.insert', before: 1, sources: [] }], 'inserting a path': [{ op: 'pages.insert', before: 1, sources: ['C:/Users/x/a.pdf'] }],
  'inserting an id that is not 32 hex digits': [{ op: 'pages.insert', before: 1, sources: ['abc'] }], 'inserting the same file twice': [{ op: 'pages.insert', before: 1, sources: [ids[0], ids[0]] }],
  'inserting more than 50 files': [{ op: 'pages.insert', before: 1, sources: Array.from({ length: 51 }, (_, i) => i.toString(16).padStart(32, '0')) }],
  'inserting with a password': [{ op: 'pages.insert', before: 1, sources: ids, password: 'x' }], 'inserting before page 0': [{ op: 'pages.insert', before: 0, sources: ids }],
  'inserting with a source that is not a list': [{ op: 'pages.insert', before: 1, sources: ids[0] }],
  'a blank page with no place': [{ op: 'pages.blank' }], 'a blank page before page 0': [{ op: 'pages.blank', before: 0 }], 'a blank page that takes a size': [{ op: 'pages.blank', before: 1, width: 100 }],
  'extracting no pages': [{ op: 'pages.extract', pages: [] }], 'extracting with a target path': [{ op: 'pages.extract', pages: [1], target: 'C:/x.pdf' }],
  'markup of an unknown kind': [{ ...highlight, type: 'stamp' }], 'a highlight with no quads': [{ ...highlight, quads: undefined }], 'a highlight with an empty list of quads': [{ ...highlight, quads: [] }],
  'a quad with seven numbers': [{ ...highlight, quads: [quad.slice(1)] }], 'a quad with a number that is text': [{ ...highlight, quads: [[...quad.slice(1), '1']] }], 'a quad that is not finite': [{ ...highlight, quads: [[...quad.slice(1), Infinity]] }],
  'a highlight that carries a stroke too': [{ ...highlight, paths: ink.paths }], 'a highlight with a thickness': [{ ...highlight, thickness: 2 }], 'ink with no thickness': [{ ...ink, thickness: undefined }],
  'ink with a stroke of one number': [{ ...ink, paths: [[1]] }], 'ink with a stroke of an odd number of numbers': [{ ...ink, paths: [[1, 2, 3]] }], 'ink with no strokes': [{ ...ink, paths: [] }], 'ink as a flat list': [{ ...ink, paths: [1, 2, 3, 4] }],
  'ink thicker than 100': [{ ...ink, thickness: 101 }], 'ink of no thickness': [{ ...ink, thickness: 0 }], 'ink with a quad': [{ ...ink, quads: [quad] }],
  'a text box with no text': [{ ...note, text: undefined }], 'a text box of blank text': [{ ...note, text: '   ' }], 'a text box with a null character': [{ ...note, text: 'a\0b' }], 'a text box of 5001 characters': [{ ...note, text: 'x'.repeat(5001) }],
  'a text box with a rectangle of three numbers': [{ ...note, rect: [1, 2, 3] }], 'a text box with a size under 4': [{ ...note, size: 3 }], 'a text box with a size over 200': [{ ...note, size: 201 }], 'a text box with no size': [{ ...note, size: undefined }], 'a text box with no font': [{ ...note, font: undefined }], 'a text box in a font that is not offered': [{ ...note, font: 'Comic Sans' }], 'a highlight with a font': [{ ...highlight, font: 'Times' }], 'a text box turned by 45': [{ ...note, turn: 45 }], 'a text box turned by 360': [{ ...note, turn: 360 }], 'an ink stroke with a turn': [{ ...ink, turn: 90 }],
  'a text box with a stroke': [{ ...note, paths: ink.paths }],
  'a colour with two numbers': [{ ...note, color: [0, 0] }], 'a colour with a number over 255': [{ ...note, color: [0, 0, 256] }], 'a colour with a fraction': [{ ...note, color: [0, 0.5, 1] }], 'a colour written as text': [{ ...note, color: '#000000' }],
  'an opacity over 1': [{ ...ink, opacity: 1.5 }], 'an opacity under 0': [{ ...ink, opacity: -0.1 }], 'markup on page 0': [{ ...note, page: 0 }], 'markup on a page that is text': [{ ...note, page: '1' }],
  'markup with a key it does not take': [{ ...note, author: 'x' }],
  'a good change followed by a bad one': [{ op: 'pages.delete', pages: [1] }, { op: 'pages.delete', pages: [0] }],
};
for (const [what, list] of Object.entries(bad)) expect(`${what} is refused`, refused(list));

console.log('where the pages are after the changes');
const shown = (from, count, list, added) => JSON.stringify(arrange(from, count, check(list), added)?.pages.map(([page, turned]) => (turned ? `${page}:${turned}` : String(page))));
expect('no changes leave the pages as they began', arrange(undefined, 3, []) === undefined);
expect('a turn is kept against its page', shown(undefined, 3, [{ op: 'pages.rotate', pages: [2], by: 90 }]) === '["1","2:90","3"]');
expect('turns add up and four make none', arrange(arrange(undefined, 3, check([{ op: 'pages.rotate', pages: [2], by: 270 }])), 3, check([{ op: 'pages.rotate', pages: [2], by: 90 }])) === undefined);
expect('a page that goes takes its place away', shown(undefined, 4, [{ op: 'pages.delete', pages: [2, 3] }]) === '["1","4"]');
expect('pages moved in front of a later page keep their order', shown(undefined, 5, [{ op: 'pages.move', pages: [3, 1], before: 5 }]) === '["2","4","1","3","5"]');
expect('pages moved to the end go last', shown(undefined, 4, [{ op: 'pages.move', pages: [1], before: 5 }]) === '["2","3","4","1"]');
expect('pages moved in front of an earlier page go before it', shown(undefined, 4, [{ op: 'pages.move', pages: [4], before: 2 }]) === '["1","4","2","3"]');
expect('a move to where the pages already are changes nothing', arrange(undefined, 4, check([{ op: 'pages.move', pages: [2, 3], before: 3 }])) === undefined);
expect('later changes count the pages as the earlier ones left them', shown(undefined, 4, [{ op: 'pages.delete', pages: [1] }, { op: 'pages.rotate', pages: [1], by: 90 }]) === '["2:90","3","4"]');

expect('pages added are new pages, in the place they were put', shown(undefined, 3, [{ op: 'pages.insert', before: 2, sources: ids }], [4]) === '["1","0","0","0","0","2","3"]');
expect('a blank page is one new page, and it can be turned like any other', shown(undefined, 2, [{ op: 'pages.blank', before: 3 }, { op: 'pages.rotate', pages: [3], by: 90 }], [1, 0]) === '["1","2","0:90"]');
expect('a page added and then deleted leaves the pages as they began', arrange(arrange(undefined, 3, check([{ op: 'pages.blank', before: 2 }]), [1]), 3, check([{ op: 'pages.delete', pages: [2] }])) === undefined);
expect('pages added to a document that lost a page are not the pages that were lost', arrange(undefined, 2, check([{ op: 'pages.delete', pages: [2] }, { op: 'pages.blank', before: 2 }]), [0, 1]) !== undefined);

console.log('pages written as a person writes them');
expect('a run is written with a dash, in order', pageRanges([3, 1, 2, 7]) === '1-3, 7');
expect('a single page, two pages in a row and a gap', pageRanges([5]) === '5' && pageRanges([4, 5]) === '4-5' && pageRanges([1, 3]) === '1, 3');

console.log('what gets through');
const given = { op: 'pages.delete', pages: [2], extra: 1 };
expect('a list with a key it does not take never reaches the file', refused([given]));
const checked = check([{ op: 'pages.delete', pages: [2] }]);
expect('the checked list is a copy, not the object the page sent', checked[0] !== given && checked[0].pages !== given.pages);
console.log('what a split makes');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
expect('ranges, single pages and an open end each make a file', same(splitParts({ mode: 'ranges', text: '1-3, 7, 10-' }, 12).parts, [[1, 2, 3], [7], [10, 11, 12]]));
expect('spaces round the numbers and the dash do not matter, and a range may repeat pages of another', same(splitParts({ mode: 'ranges', text: ' 1 - 2 ,2-3 ' }, 5).parts, [[1, 2], [2, 3]]));
for (const text of ['', ' ', '0', '3-1', '1,,2', '1,', ',1', 'a', '1-3-5', '-3', '1;2', '1 2', '1.5', '١', '0-13']) expect(`the ranges "${text}" are refused with the sentence for page numbers`, splitParts({ mode: 'ranges', text }, 12).error === 'Use page numbers such as 1-3, 7');
for (const text of ['1-13', '13', '10-13', '13-', '1-3, 9-20']) expect(`the ranges "${text}" in a document of 12 pages are refused with its page count`, splitParts({ mode: 'ranges', text }, 12).error === 'This document has 12 pages');
expect('a document of one page says page, not pages', splitParts({ mode: 'ranges', text: '2' }, 1).error === 'This document has 1 page');
expect('ranges that are not text, or too long, are refused', !!splitParts({ mode: 'ranges', text: 5 }, 12).error && !!splitParts({ mode: 'ranges', text: '1,'.repeat(600) }, 12).error);
expect('every n pages makes files of n pages and a shorter last one', same(splitParts({ mode: 'every', n: 5 }, 12).parts, [range(1, 5), range(6, 10), [11, 12]]) && same(splitParts({ mode: 'every', n: 1 }, 3).parts, [[1], [2], [3]]));
for (const n of [0, -1, 1.5, '5', null, 12, 13]) expect(`every ${JSON.stringify(n)} pages in a document of 12 is refused with the sentence for a number`, splitParts({ mode: 'every', n }, 12).error === 'Use a number of pages such as 5');
expect('a split into 100 files is allowed and into 101 is not', splitParts({ mode: 'every', n: 30 }, 3000).parts.length === 100 && splitParts({ mode: 'every', n: 29 }, 3000).error === 'That would make more than 100 files' && splitParts({ mode: 'ranges', text: Array(101).fill('1').join(',') }, 12).error === 'That would make more than 100 files');
expect('bookmarks begin a file at their page and the first file begins at page 1', same(splitParts({ mode: 'bookmarks', starts: [9, 5] }, 12).parts, [range(1, 4), range(5, 8), range(9, 12)]) && same(splitParts({ mode: 'bookmarks', starts: [1, 5, 5] }, 12).parts, [range(1, 4), range(5, 12)]));
for (const starts of [[13], [0], [1.5], ['5'], 'x', undefined, Array(101).fill(2)]) expect(`bookmarks at ${JSON.stringify(starts)?.slice(0, 20)} are refused`, !!splitParts({ mode: 'bookmarks', starts }, 12).error);
expect('a page count that is not a count, and ranges that add up to more pages than a document may have, are refused', [undefined, 0, -3, 1.5, '12', 1000001].every((total) => !!splitParts({ mode: 'ranges', text: '1' }, total).error) && splitParts({ mode: 'ranges', text: Array(100).fill('1-999999').join(',') }, 999999).error === 'That is too much to split at once');
expect('every page of a split is a page of the document, in order, once', splitParts({ mode: 'every', n: 7 }, 50).parts.flat().every((p, i) => p === i + 1));
expect('a request that is not a request, or a mode that is not known, is refused', !!splitParts(undefined, 12).error && !!splitParts({ mode: 'shred' }, 12).error && !!splitParts('1-3', 12).error);
finish();

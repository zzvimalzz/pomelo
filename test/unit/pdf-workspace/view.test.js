// SPDX-License-Identifier: AGPL-3.0-or-later
// Which view settings the PDF window keeps: only valid fields, and the colours as #rrggbb.
//   node test/unit/pdf-workspace/view.test.js
const { cleanView } = require('../../../src/features/pdf-workspace/view');
const { expect } = require('../../support/expect');
const finish = require('../../support/finish');

const clean = (raw) => JSON.stringify(cleanView(raw));
const sidebar = { open: true, tab: 'outline', width: 260 };

console.log('values that are kept');
expect('a full view is kept as it is', clean({ zoom: 1.25, layout: 'spread', sidebar, pageColours: 'sepia' }) === JSON.stringify({ zoom: 1.25, layout: 'spread', sidebar, pageColours: 'sepia' }));
expect('both fits and the limits of a zoom', ['page-fit', 'page-width', 0.1, 10].every((zoom) => cleanView({ zoom }).zoom === zoom));
expect('both layouts', ['continuous', 'spread'].every((layout) => cleanView({ layout }).layout === layout));
expect('all three page colours', ['original', 'sepia', 'dark'].every((pageColours) => cleanView({ pageColours }).pageColours === pageColours));
expect('a pair of colours is kept in lower case', clean({ pageColours: { page: '#FDF6E3', text: '#3B3B3B' } }) === '{"pageColours":{"page":"#fdf6e3","text":"#3b3b3b"}}');
expect('the panel at its narrowest, widest and shut', [214, 320].every((width) => cleanView({ sidebar: { ...sidebar, width } }).sidebar.width === width) && cleanView({ sidebar: { open: false, tab: 'pages', width: 214 } }).sidebar.open === false);

console.log('values that are dropped');
for (const zoom of [0, 0.09, 10.1, -1, NaN, Infinity, '1', '1.5', 'page-actual', 'auto', null, {}, []]) expect(`zoom ${JSON.stringify(zoom)} is dropped`, !('zoom' in cleanView({ zoom })), String(zoom));
for (const layout of ['two', 'Continuous', 1, null, {}]) expect(`layout ${JSON.stringify(layout)} is dropped`, !('layout' in cleanView({ layout })));
for (const pageColours of ['Sepia', 'custom', '#ffffff', '', 5, null, [], { page: '#ffffff' }, { text: '#000000' }, { page: 'red', text: '#000000' }, { page: '#fff', text: '#000000' }, { page: '#ffffff', text: '#00000' },
  { page: '#ffffff', text: '#0000000' }, { page: '#ffffff', text: 'url(x)' }, { page: '#ffffff', text: '#00000g' }, { page: '#ffffff', text: '#000000;color:red' }, { page: ['#ffffff'], text: '#000000' }]) {
  expect(`page colours ${JSON.stringify(pageColours)} are dropped`, !('pageColours' in cleanView({ pageColours })));
}
for (const bad of [{ open: 1, tab: 'pages', width: 260 }, { open: true, tab: 'results', width: 260 }, { open: true, tab: 'pages', width: 213 }, { open: true, tab: 'pages', width: 321 }, { open: true, tab: 'pages', width: 260.5 },
  { open: true, tab: 'pages', width: '260' }, { open: true, tab: 'pages' }, { tab: 'pages', width: 260 }, 'open', null, []]) expect(`sidebar ${JSON.stringify(bad)} is dropped`, !('sidebar' in cleanView({ sidebar: bad })));
expect('a field with a bad value does not take the good ones with it', clean({ zoom: 'huge', layout: 'spread', sidebar: 'x', pageColours: 'dark' }) === '{"layout":"spread","pageColours":"dark"}');

console.log('what is passed in');
expect('keys that are not view settings are dropped, window and dock among them', clean({ zoom: 1, window: { x: 1 }, dock: 'left', extra: true }) === '{"zoom":1}');
expect('anything that is not an object gives an empty view', [undefined, null, 5, 'zoom', true, [], [{ zoom: 1 }]].every((raw) => clean(raw) === '{}'));
expect('the input is not changed', (() => { const raw = { pageColours: { page: '#FFFFFF', text: '#000000' } }; cleanView(raw); return raw.pageColours.page === '#FFFFFF'; })());
expect('a polluted object adds no field', clean(JSON.parse('{"__proto__":{"zoom":2},"zoom":1}')) === '{"zoom":1}' && !('zoom' in {}));

finish();

// SPDX-License-Identifier: AGPL-3.0-or-later
// From the gesture to the wheels and the jobs, against fakes: which wheel a selection gets, what turning it does, and what a drop on
// the Open wheel or on a format does.   node test/unit/app/drop-flow.test.js
const { createDropFlow } = require('../../../src/app/drop-flow');
const { extOf, groupOf, labelOf } = require('../../../src/features/conversion/catalog/formats');
const { expect } = require('../../support/expect');
const finish = require('../../support/finish');

const calls = [];
const record = (name) => (...args) => calls.push([name, ...args]);
const take = () => calls.splice(0);
const json = (v) => JSON.stringify(v);

let formats = ['pdf', 'docx'];                                                   // what a file can become
const conversion = {
  extOf, groupOf, labelOf,
  targetsFor: (files) => (files.every((f) => extOf(f) === 'zzz') ? [] : formats.map((ext) => ({ id: ext, label: ext.toUpperCase() }))),
  explainNoTargets: (files) => ({ title: `nothing for ${files.length}` }),
};
let keys = true;
const flow = createDropFlow({
  conversion, log: () => {},
  getWheel: () => ({ openWheel: record('openWheel'), switchWheel: record('switchWheel') }),
  getJobs: () => ({ addInfo: record('addInfo'), addConversion: record('addConversion') }),
  openPdfs: record('openPdfs'),
  keysSupported: () => keys,
});
const OPEN = [{ id: 'open', label: 'Open', icon: 'book' }];
const targets = [{ id: 'pdf', label: 'PDF' }, { id: 'docx', label: 'DOCX' }];

console.log('the conversion wheel');
flow.onOpen(['C:\\a.docx']);
let [open] = take();
expect('a selection gets the formats, and the pill that names Shift', open[0] === 'openWheel' && open[1].ext === 'docx' && json(open[2]) === json(targets) && open[3] === null && json(open[4]) === json({ wheel: 'convert', switchable: true }), json(open));
keys = false;
flow.onOpen(['C:\\a.docx']);
[open] = take();
expect('with a helper that cannot report Shift there is no pill', json(open[4]) === json({ wheel: 'convert', switchable: false }), json(open[4]));
keys = true;
flow.onOpen(['C:\\a.docx'], true);
[open] = take();
expect('from the right-click menu the files are clicked, and there is no pill', json(open[3]) === json(['C:\\a.docx']) && open[4].switchable === false, json(open));
flow.onOpen(['C:\\a.zzz']);
expect('nothing to convert to: no wheel, and the reason is shown', json(take()) === json([['addInfo', { title: 'nothing for 1' }]]));

console.log('the Open wheel');
flow.onOpen(['C:\\a.pdf', 'C:\\b.PDF'], false, 'open');
[open] = take();
expect('Shift on PDFs shows the Open wheel, which takes them', open[0] === 'openWheel' && json(open[2]) === json(OPEN) && open[3] === null && json(open[4]) === json({ wheel: 'open', droppable: true, switchable: true }), json(open));
for (const [what, files] of [['a document', ['C:\\a.docx']], ['a mix', ['C:\\a.pdf', 'C:\\b.docx']], ['a file nothing converts', ['C:\\a.zzz']], ['a folder', ['C:\\Windows']]]) {
  flow.onOpen(files, false, 'open');
  [open] = take();
  expect(`${what}: the Open wheel shows and refuses the drop`, open[0] === 'openWheel' && open[4].droppable === false && open[4].wheel === 'open', json(open));
}

console.log('turning the wheel');
flow.onOpen(['C:\\a.pdf'], false, 'open'); take();
flow.onSwitch('convert');
let [turn] = take();
expect('Ctrl turns it into the conversion wheel for the same files', turn[0] === 'switchWheel' && json(turn[1]) === json(targets) && json(turn[2]) === json({ wheel: 'convert', switchable: true }), json(turn));
flow.onSwitch('open');
[turn] = take();
expect('and Shift back', turn[0] === 'switchWheel' && json(turn[1]) === json(OPEN) && turn[2].droppable === true && turn[2].wheel === 'open', json(turn));
flow.onOpen(['C:\\a.zzz'], false, 'open'); take();
flow.onSwitch('convert');
expect('with nothing to convert to the wheel stays and the reason is shown', json(take()) === json([['addInfo', { title: 'nothing for 1' }]]));
flow.onOpen(['C:\\a.docx']); take();
flow.onSwitch('open');
[turn] = take();
expect('turning to Open on a document shows a ring that refuses it', turn[2].droppable === false, json(turn));

console.log('dropping');
flow.onDrop(['C:\\a.pdf', 'C:\\b.PDF'], 'open');
expect('PDFs dropped on Open are opened, and are not converted', json(take()) === json([['openPdfs', ['C:\\a.pdf', 'C:\\b.PDF']]]));
flow.onDrop(['C:\\a.pdf', 'C:\\b.docx', 'C:\\Windows'], 'open');
expect('of a mix only the PDFs are opened', json(take()) === json([['openPdfs', ['C:\\a.pdf']]]));
flow.onDrop(['C:\\b.docx'], 'open');
expect('files that are not PDFs open nothing', json(take()) === '[]');
flow.onDrop(['C:\\a.docx', 'C:\\b.docx'], 'pdf');
expect('a drop on a format still makes one job for each file', json(take()) === json([['addConversion', 'C:\\a.docx', 'pdf', 'PDF'], ['addConversion', 'C:\\b.docx', 'pdf', 'PDF']]));
flow.onDrop(['C:\\a.docx'], 'epub');
expect('and a format that is not offered is still refused', take().length === 1 && calls.length === 0);

finish();

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
const locks = {};                                                                // file -> the kind of lock it has
const passwords = {};                                                            // file -> the password that opens it, or an error to throw
const conversion = {
  extOf, groupOf, labelOf,
  probeLocked: async (file) => locks[file] || null,
  checkPassword: async (file, password) => { const want = passwords[file]; if (want instanceof Error) throw want; return password.toString() === want; },
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

(async () => {
console.log('the conversion wheel');
flow.onOpen(['C:\\a.pdf']);
let [open] = take();
expect('PDFs get the formats, and the pill that names Shift', open[0] === 'openWheel' && open[1].ext === 'pdf' && json(open[2]) === json(targets) && open[3] === null && json(open[4]) === json({ wheel: 'convert', switchable: true }), json(open));
flow.onOpen(['C:\\a.docx']);
[open] = take();
expect('a document gets the formats and no pill, because Shift is of no use to it', open[1].ext === 'docx' && json(open[2]) === json(targets) && json(open[4]) === json({ wheel: 'convert', switchable: false }), json(open));
flow.onOpen(['C:\\a.pdf', 'C:\\b.docx']);
[open] = take();
expect('a mix of a PDF and a document gets no pill either', json(open[4]) === json({ wheel: 'convert', switchable: false }), json(open[4]));
keys = false;
flow.onOpen(['C:\\a.pdf']);
[open] = take();
expect('with a helper that cannot report Shift there is no pill', json(open[4]) === json({ wheel: 'convert', switchable: false }), json(open[4]));
keys = true;
flow.onOpen(['C:\\a.pdf'], true);
[open] = take();
expect('from the right-click menu the files are clicked, and there is no pill', json(open[3]) === json(['C:\\a.pdf']) && open[4].switchable === false, json(open));
flow.onOpen(['C:\\a.zzz']);
expect('nothing to convert to: no wheel, and the reason is shown', json(take()) === json([['addInfo', { title: 'nothing for 1' }]]));

console.log('the Open wheel');
flow.onOpen(['C:\\a.pdf', 'C:\\b.PDF'], false, 'open');
[open] = take();
expect('Shift on PDFs shows the Open wheel, which takes them', open[0] === 'openWheel' && json(open[2]) === json(OPEN) && open[3] === null && json(open[4]) === json({ wheel: 'open', switchable: true }), json(open));
for (const [what, files] of [['a document', ['C:\\a.docx']], ['a mix', ['C:\\a.pdf', 'C:\\b.docx']]]) {
  flow.onOpen(files, false, 'open');
  [open] = take();
  expect(`Shift on ${what} shows the conversion wheel, with no pill`, open[0] === 'openWheel' && json(open[2]) === json(targets) && json(open[4]) === json({ wheel: 'convert', switchable: false }), json(open));
}
flow.onOpen(['C:\\a.zzz'], false, 'open');
expect('Shift on a file nothing converts says why there is nothing to offer', json(take()) === json([['addInfo', { title: 'nothing for 1' }]]));

console.log('turning the wheel');
flow.onOpen(['C:\\a.pdf'], false, 'open'); take();
flow.onSwitch('convert');
let [turn] = take();
expect('Ctrl turns it into the conversion wheel for the same files', turn[0] === 'switchWheel' && json(turn[1]) === json(targets) && json(turn[2]) === json({ wheel: 'convert', switchable: true }), json(turn));
flow.onSwitch('open');
[turn] = take();
expect('and Shift back', turn[0] === 'switchWheel' && json(turn[1]) === json(OPEN) && json(turn[2]) === json({ wheel: 'open', switchable: true }), json(turn));
flow.onOpen(['C:\\a.zzz'], false, 'open'); take();
flow.onSwitch('convert');
expect('with nothing to convert to the wheel stays and the reason is shown', json(take()) === json([['addInfo', { title: 'nothing for 1' }]]));
flow.onOpen(['C:\\a.docx']); take();
flow.onSwitch('open');
expect('Shift on a document that is showing its wheel turns nothing', take().length === 0);
flow.onOpen(['C:\\a.pdf', 'C:\\b.docx']); take();
flow.onSwitch('open');
expect('and neither on a mix', take().length === 0);

console.log('dropping');
await flow.onDrop(['C:\\a.pdf', 'C:\\b.PDF'], 'open');
expect('PDFs dropped on Open are opened, and are not converted', json(take()) === json([['openPdfs', ['C:\\a.pdf', 'C:\\b.PDF']]]));
await flow.onDrop(['C:\\a.pdf', 'C:\\b.docx', 'C:\\Windows'], 'open');
expect('of a mix only the PDFs are opened', json(take()) === json([['openPdfs', ['C:\\a.pdf']]]));
await flow.onDrop(['C:\\b.docx'], 'open');
expect('files that are not PDFs open nothing', json(take()) === '[]');
await flow.onDrop(['C:\\a.docx', 'C:\\b.docx'], 'pdf');
expect('a drop on a format still makes one job for each file', json(take()) === json([['addConversion', 'C:\\a.docx', 'pdf', 'PDF'], ['addConversion', 'C:\\b.docx', 'pdf', 'PDF']]));
await flow.onDrop(['C:\\a.docx'], 'epub');
expect('and a format that is not offered is still refused', take().length === 1 && calls.length === 0);

console.log('protected files');
const sent = [];
const jobs = { addInfo: record('addInfo'), addConversion: (file, to, label, password) => { sent.push([file, to, label, password?.toString()]); } };
const wheelState = { asking: false, openWheel: (...args) => calls.push(['openWheel', args[0].name]) };
const lockFlow = createDropFlow({ conversion, log: () => {}, getWheel: () => wheelState, getJobs: () => jobs, openPdfs: () => {}, keysSupported: () => true });
const A = 'C:\\locked-a.docx', B = 'C:\\locked-b.docx', C = 'C:\\locked-c.docx', PLAIN = 'C:\\plain.docx', ODF = 'C:\\locked.odt';
Object.assign(locks, { [A]: 'needed', [B]: 'needed', [C]: 'needed', [ODF]: 'unsupported' });
Object.assign(passwords, { [A]: 'one', [B]: 'one', [C]: 'other' });

let asked = await lockFlow.onDrop([PLAIN, A, B], 'pdf');
expect('the file that is not protected converts at once, the protected ones are handed to the wheel', json(sent) === json([[PLAIN, 'pdf', 'PDF', undefined]]) && asked.length === 2, json(sent));
expect('each is described by a token, its kind, a short name and its format', asked.every((a) => /^[0-9a-f]{32}$/.test(a.token) && a.kind === 'needed' && a.ext === 'docx' && a.group === 'doc') && asked[0].token !== asked[1].token && asked[0].name === 'locked-a.docx', json(asked));
sent.length = 0;

let result = await lockFlow.onUnlock({ token: asked[0].token, password: 'nope', all: false });
expect('a wrong password starts nothing and says so', result.state === 'wrong' && sent.length === 0, json(result));
result = await lockFlow.onUnlock({ token: asked[0].token, password: '', all: false });
expect('an empty password is simply wrong', result.state === 'wrong' && sent.length === 0, json(result));
result = await lockFlow.onUnlock({ token: asked[0].token, password: 'one', all: false });
expect('the right one starts the job with that password', result.state === 'ok' && json(result.done) === json([asked[0].token]) && !result.mismatch && json(sent) === json([[A, 'pdf', 'PDF', 'one']]), json([result, sent]));
result = await lockFlow.onUnlock({ token: asked[0].token, password: 'one', all: false });
expect('a file that has opened is not asked about again', result.state === 'closed' && sent.length === 1, json(result));
sent.length = 0;

asked = await lockFlow.onDrop([A, B, C], 'pdf');
result = await lockFlow.onUnlock({ token: asked[0].token, password: 'one', all: true });
expect('with "same for all" the password is tried on the rest and opens those it fits', result.state === 'ok' && json(result.done) === json([asked[0].token, asked[1].token]) && result.mismatch === true && json(sent.map((s) => s[0])) === json([A, B]) && sent.every((s) => s[3] === 'one'), json([result, sent]));
sent.length = 0;
result = await lockFlow.onUnlock({ token: asked[2].token, password: 'other', all: true });
expect('the one it did not fit takes its own, and then nothing is left', result.state === 'ok' && result.mismatch === false && json(sent) === json([[C, 'pdf', 'PDF', 'other']]), json([result, sent]));
sent.length = 0;

asked = await lockFlow.onDrop([ODF, A], 'pdf');
result = await lockFlow.onUnlock({ token: asked[0].token, password: 'anything', all: false });
expect('a protection that is not supported is not given passwords', asked[0].kind === 'unsupported' && result.state === 'closed' && sent.length === 0, json([asked, result]));

passwords[A] = Object.assign(new Error("Archive passwords can't have accented or non-Latin characters"), { kind: 'ascii' });
asked = await lockFlow.onDrop([A], 'pdf');
result = await lockFlow.onUnlock({ token: asked[0].token, password: 'p\u00e4ssw\u00f6rd', all: false });
expect('a password the engine cannot take is wrong, with the reason', result.state === 'wrong' && /accented/.test(result.message), json(result));
passwords[A] = new Error('This file is damaged');
result = await lockFlow.onUnlock({ token: asked[0].token, password: 'x', all: false });
expect('a file that cannot be opened at all is reported, and dropped from the list', result.state === 'cannot' && result.token === asked[0].token && result.message === 'This file is damaged', json(result));
result = await lockFlow.onUnlock({ token: asked[0].token, password: 'x', all: false });
expect('and not asked about again', result.state === 'closed', json(result));
passwords[A] = 'one';

asked = await lockFlow.onDrop([A], 'pdf');
lockFlow.onUnlockEnd();
result = await lockFlow.onUnlock({ token: asked[0].token, password: 'one', all: false });
expect('a card that was closed gets nothing started', result.state === 'closed' && sent.length === 0, json(result));
asked = await lockFlow.onDrop([A], 'pdf');
const pending = lockFlow.onUnlock({ token: asked[0].token, password: 'one', all: false });
lockFlow.onUnlockEnd();
result = await pending;
expect('and neither does one closed while the password was being checked', result.state === 'closed' && sent.length === 0, json(result));
asked = await lockFlow.onDrop([A], 'pdf');
await lockFlow.onDrop([PLAIN], 'pdf');
result = await lockFlow.onUnlock({ token: asked[0].token, password: 'one', all: false });
expect('a new drop replaces the files that were waiting', result.state === 'closed', json(result));

console.log('a new wheel while the card is open');
take();
await lockFlow.onDrop([A], 'pdf');
wheelState.asking = true;
await lockFlow.onOpen([B], false, 'convert');
expect('Ctrl on a file that needs a password opens the wheel too, which takes the card away', take()[0][0] === 'openWheel');
await lockFlow.onOpen([PLAIN], false, 'convert');
expect('and on one that does not', take()[0][0] === 'openWheel');
await lockFlow.onOpen([B], false, 'open');
expect('Shift on a file that needs a password shows the conversion wheel, which takes the card away', take()[0][0] === 'openWheel');
await lockFlow.onOpen([B], true, 'convert');
expect('and so does a pick from the right-click menu', take()[0][0] === 'openWheel');
wheelState.asking = false;
lockFlow.onUnlockEnd();

console.log('a card nobody used');
{
  const infos = [];
  const quiet = createDropFlow({ conversion, log: () => {}, getWheel: () => wheelState, getJobs: () => ({ addInfo: (m) => infos.push(m), addConversion: () => {} }), openPdfs: () => {}, keysSupported: () => true });
  quiet.onExpire();
  expect('with nothing waiting there is nothing to say', infos.length === 0);
  await quiet.onDrop([A], 'pdf');
  quiet.onExpire();
  expect('a card with one file closing on its own says which file was left alone', json(infos) === json([{ title: 'Password prompt closed', detail: 'locked-a.docx was left alone.' }]), json(infos));
  infos.length = 0;
  await quiet.onDrop([A, B, C], 'pdf');
  quiet.onExpire();
  expect('and with several, how many', infos[0]?.detail === '3 files was left alone.', json(infos));
}

finish();
})();

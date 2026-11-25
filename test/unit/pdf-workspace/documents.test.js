// SPDX-License-Identifier: AGPL-3.0-or-later
// The workspace's open documents: tokens, the bounds of a read, the held handle, and the count of bytes served.
//   node test/unit/pdf-workspace/documents.test.js
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createDocuments, MAX_SPAN } = require('../../../src/features/pdf-workspace/documents');
const { expect } = require('../../support/expect');
const finish = require('../../support/finish');
const { dir: tmpDir } = require('../../support/tmp');

const fails = async (promise) => { try { await promise; return false; } catch { return true; } };

(async () => {
  const root = tmpDir('ws-docs');
  const file = path.join(root, 'Report.pdf');
  const content = crypto.randomBytes(MAX_SPAN + 1000);
  fs.writeFileSync(file, content);
  const docs = createDocuments();

  console.log('opening');
  const doc = await docs.open(file);
  const second = await docs.open(file);
  expect('a document has a name and a size, and its token is 32 random bytes in hex', doc.name === 'Report.pdf' && doc.size === content.length && /^[0-9a-f]{64}$/.test(doc.token) && Object.keys(doc).sort().join() === 'added,canRedo,canUndo,dirty,name,size,token', JSON.stringify(Object.keys(doc)));
  expect('every open gets its own token', doc.token !== second.token);
  expect('a file that is not there is refused with its reason', await docs.open(path.join(root, 'nope.pdf')).then(() => '', (e) => e.code) === 'ENOENT');
  expect('a folder is refused', await fails(docs.open(root)));

  console.log('reading a range');
  const head = await docs.read(doc.token, 0, 16);
  const middle = await docs.read(doc.token, 1000, 1500);
  expect('a range is exactly those bytes of the file', head.equals(content.subarray(0, 16)) && middle.equals(content.subarray(1000, 1500)));
  expect('the last byte can be read', (await docs.read(doc.token, content.length - 1, content.length)).equals(content.subarray(content.length - 1)));
  expect('a span of exactly 4 MiB is served', (await docs.read(doc.token, 0, MAX_SPAN)).length === MAX_SPAN);
  expect('the bytes served are counted', docs.served() === 16 + 500 + 1 + MAX_SPAN, String(docs.served()));

  console.log('refusals');
  const before = docs.served();
  const bad = {
    'a wrong token': [crypto.randomBytes(32).toString('hex'), 0, 10], 'no token': [undefined, 0, 10], 'a token that is not text': [1, 0, 10],
    'a negative start': [doc.token, -1, 10], 'a fractional start': [doc.token, 0.5, 10], 'a fractional end': [doc.token, 0, 10.5],
    'a start that is not a number': [doc.token, '0', 10], 'a start that is NaN': [doc.token, NaN, 10], 'an end that is Infinity': [doc.token, 0, Infinity],
    'an empty range': [doc.token, 10, 10], 'an end before the start': [doc.token, 10, 5], 'an end beyond the file': [doc.token, 0, content.length + 1],
    'a start at the end of the file': [doc.token, content.length, content.length + 1], 'a span over 4 MiB': [doc.token, 0, MAX_SPAN + 1],
  };
  for (const [what, args] of Object.entries(bad)) expect(`${what} is refused`, await fails(docs.read(...args)));
  expect('a refused read serves nothing', docs.served() === before);

  console.log('the held handle');
  const original = Buffer.from('the first version of the file');
  const removed = path.join(root, 'Removed.pdf');
  fs.writeFileSync(removed, original);
  const held = await docs.open(removed);
  fs.rmSync(removed);
  expect('a file deleted from disk while it is open still reads as it was', (await docs.read(held.token, 0, original.length)).equals(original));
  const shrinking = path.join(root, 'Shrinking.pdf');
  fs.writeFileSync(shrinking, Buffer.alloc(100, 1));
  const grown = await docs.open(shrinking);
  fs.truncateSync(shrinking, 10);
  expect('a file cut short while open is reported, never padded', await fails(docs.read(grown.token, 0, 100)));

  console.log('a password');
  expect('a document has no password until one is given', docs.password(doc.token) === undefined);
  docs.unlock(doc.token, 'Pw-é1');
  const stored = docs.password(doc.token);
  expect('the password is kept in memory as UTF-8, under the document\'s token only', stored.toString('utf8') === 'Pw-é1' && docs.password(second.token) === undefined);
  expect('the document record carries no password', !JSON.stringify(doc).includes('Pw-') && Object.keys(doc).sort().join() === 'added,canRedo,canUndo,dirty,name,size,token');
  docs.unlock(doc.token, 'another');
  expect('a new password replaces the old one, which is overwritten with zeros', docs.password(doc.token).toString() === 'another' && stored.every((b) => b === 0));
  const refusedPasswords = { 'an unknown token': ['0'.repeat(64), 'x'], 'no password': [doc.token, undefined], 'an empty password': [doc.token, ''], 'a password that is not text': [doc.token, 12], 'a password of 4097 characters': [doc.token, 'x'.repeat(4097)] };
  for (const [what, args] of Object.entries(refusedPasswords)) expect(`${what} is refused`, (() => { try { docs.unlock(...args); return false; } catch { return true; } })());
  expect('a refused password changes nothing', docs.password(doc.token).toString() === 'another');
  const last = docs.password(doc.token);

  console.log('changes made by the PDF engine');
  const pdf = path.join(root, 'Edited.pdf');
  fs.writeFileSync(pdf, '%PDF-1.7 the original');
  const runs = [];
  let mode = 'copy';
  let said = '';
  const runPdfTool = async (script, args, options) => {
    const [source, target, listFile] = args;
    runs.push({ script, source, target, list: fs.readFileSync(listFile, 'utf8'), secrets: options.secrets, signal: options.signal });
    if (mode === 'fail') { fs.writeFileSync(target, 'half'); throw new Error('This file is damaged or is not a PDF'); }
    if (mode === 'wait') await new Promise((resolve) => options.signal.addEventListener('abort', resolve));
    if (options.signal.aborted) { fs.writeFileSync(target, 'half'); throw Object.assign(new Error('Cancelled'), { name: 'CancelledError' }); }
    fs.writeFileSync(target, `${fs.readFileSync(source, 'utf8')} +1`);
    return said;
  };
  const edits = createDocuments({ runPdfTool });
  const edited = await edits.open(pdf);
  const rotate = [{ op: 'pages.rotate', pages: [2], by: 90 }];
  const result = await edits.apply(edited.token, rotate);
  const session = path.dirname(runs[0].source);
  expect('the first change copies the file into a session folder, and the helper never sees the user\'s file', result.info.dirty && runs[0].script === 'pdf_edit.py' && runs[0].source !== pdf && runs[0].target.startsWith(session) && fs.readFileSync(pdf, 'utf8') === '%PDF-1.7 the original');
  expect('the helper gets the list as the schema keeps it, and the new revision is what it wrote', runs[0].list === '{"version":1,"ops":[{"op":"pages.rotate","pages":[2],"by":90}]}' && result.info.size === '%PDF-1.7 the original +1'.length && (await edits.read(edited.token, 0, 8)).toString() === '%PDF-1.7');
  expect('no list file is left in the session folder', fs.readdirSync(session).every((name) => !name.startsWith('ops-')), fs.readdirSync(session).join());
  await edits.apply(edited.token, rotate);
  expect('the next change starts from the revision on show', runs[1].source === runs[0].target);
  expect('the document says whether undo and redo have a step to take', result.info.canUndo === true && result.info.canRedo === false && edited.canUndo === false && (await edits.undo(edited.token)).info.canRedo === true);
  await edits.redo(edited.token);
  expect('undo steps back one change at a time',(await edits.undo(edited.token)).info.size === result.info.size && (await edits.undo(edited.token)).info.size === '%PDF-1.7 the original'.length && !(await edits.undo(edited.token)));
  expect('a document with no password gives the helper no secret', runs[0].secrets === undefined);
  edits.unlock(edited.token, 'Pw-é1');
  await edits.apply(edited.token, rotate);
  expect('the password goes to the helper as a secret, and is in neither the list nor the arguments', JSON.stringify(runs[2].secrets) === '{"password":"Pw-é1"}' && !runs[2].list.includes('Pw-') && runs.every((run) => !run.source.includes('Pw-')));
  const text = [{ op: 'meta.set', title: 'T', author: '', subject: '', keywords: '' }];
  const appended = '{"saved": "incremental"}';
  said = appended;
  const kept = (await edits.apply(edited.token, text)).reload;
  said = '{"saved": "full"}';
  const rewrittenText = (await edits.apply(edited.token, text)).reload;
  said = appended;
  const mixed = (await edits.apply(edited.token, [...text, ...rotate])).reload;
  const turned = (await edits.apply(edited.token, rotate)).reload;
  said = '';
  expect('a change to the information alone, appended to the file, keeps the pages as they are', kept === false);
  expect('a full save of it, a change to pages and a mix of both all ask for the pages to be read again', rewrittenText === true && mixed === true && turned === true, JSON.stringify([rewrittenText, mixed, turned]));
  const runsBefore = runs.length;
  const refusedLists = { 'an unknown change': [{ op: 'pages.shred', pages: [1] }], 'a key it does not take': [{ op: 'pages.delete', pages: [1], password: 'x' }], 'no list': undefined };
  for (const [what, list] of Object.entries(refusedLists)) expect(`${what} is refused before the helper starts`, (() => { try { edits.apply(edited.token, list); return false; } catch { return true; } })());
  expect('and so is an unknown document', (() => { try { edits.apply('0'.repeat(64), rotate); return false; } catch { return true; } })() && runs.length === runsBefore);
  const sizeBefore = edits.list()[0].size;
  mode = 'fail';
  const revisionsBefore = fs.readdirSync(session).sort().join();
  expect('a helper that fails rejects with its reason, and leaves no half-written revision', await edits.apply(edited.token, rotate).then(() => '', (e) => e.message) === 'This file is damaged or is not a PDF' && fs.readdirSync(session).sort().join() === revisionsBefore, fs.readdirSync(session).join());
  expect('the document is as it was after a failure', edits.list()[0].size === sizeBefore);
  mode = 'wait';
  const pending = edits.apply(edited.token, rotate).then(() => 'done', (e) => e.name);
  while (runs.length < runsBefore + 2) await new Promise((resolve) => setTimeout(resolve, 10));
  const running = runs.at(-1);
  await edits.close(edited.token);
  expect('closing a document stops the helper that is changing it, and removes its folder', await pending === 'CancelledError' && running.signal.aborted && !fs.existsSync(session));
  expect('and its password is gone', edits.password(edited.token) === undefined);
  const late = await edits.open(pdf);
  const waiting = edits.apply(late.token, rotate).then(() => 'done', (e) => e.name);
  while (runs.length < runsBefore + 3) await new Promise((resolve) => setTimeout(resolve, 10));
  await edits.closeAll();
  expect('quitting stops a helper that is still changing a document', await waiting === 'CancelledError' && runs.at(-1).signal.aborted);

  console.log('renaming');
  const named = tmpDir('ws-rename');
  const sub = path.join(named, 'Reports', '2026');
  fs.mkdirSync(sub, { recursive: true });
  const make = (name, text) => { const p = path.join(sub, name); fs.writeFileSync(p, `${text} %%EOF`); return p; };
  const alphaFile = make('Alpha.pdf', '%PDF-1.7 alpha');
  make('Beta.pdf', '%PDF-1.7 beta');
  make('Delta.pdf', '%PDF-1.7 delta');
  const gamma = createDocuments({ runPdfTool });
  const alpha = await gamma.open(alphaFile);
  await gamma.open(path.join(sub, 'Beta.pdf'));
  const renamed = await gamma.rename(alpha.token, 'Gamma');
  expect('a file is renamed on disk, keeps its extension and its content, and the document follows it', renamed.info.name === 'Gamma.pdf' && !fs.existsSync(alphaFile) && fs.readFileSync(path.join(sub, 'Gamma.pdf'), 'utf8') === '%PDF-1.7 alpha %%EOF' && gamma.find(path.join(sub, 'Gamma.pdf'))?.token === alpha.token && gamma.find(alphaFile) === null);
  expect('the renamed document still reads, and keeps its token', (await gamma.read(alpha.token, 0, 8)).toString() === '%PDF-1.7' && renamed.info.token === alpha.token);
  expect('the folder and the time of the last change are given, never the path', JSON.stringify(Object.keys(await gamma.details(alpha.token))) === '["folders","modified"]' && (await gamma.details(alpha.token)).folders.join('|') === 'Reports|2026' && typeof (await gamma.details(alpha.token)).modified === 'number');
  const untouched = () => ['Beta.pdf', 'Delta.pdf', 'Gamma.pdf'].map((n) => fs.readFileSync(path.join(sub, n), 'utf8')).join();
  const others = untouched();
  expect('a name another open tab has is refused', (await gamma.rename(alpha.token, 'beta')).stop === 'open');
  expect('a name a file has on disk is refused, and that file is not replaced', (await gamma.rename(alpha.token, 'Delta')).stop === 'exists' && untouched() === others);
  const invalid = ['', '   ', 'a/b', 'a\\b', 'C:x', 'a*b', 'a?b', 'a"b', 'a<b', 'a|b', 'a\u0007b', 'con', 'NUL.txt', 'com1', 'name.', 'x'.repeat(201), '..', undefined, 5, { toString: () => 'x' }];
  const results = [];
  for (const name of invalid) results.push((await gamma.rename(alpha.token, name)).stop);
  expect('a name that Windows cannot have is refused, whatever it is', results.every((r) => r === 'invalid') && gamma.list()[0].name === 'Gamma.pdf', JSON.stringify(results));
  expect('the name it already has changes nothing', (await gamma.rename(alpha.token, 'Gamma')).info.name === 'Gamma.pdf' && (await gamma.rename(alpha.token, ' Gamma ')).info.name === 'Gamma.pdf');
  expect('a change of case only is allowed', (await gamma.rename(alpha.token, 'GAMMA')).info.name === 'GAMMA.pdf' && fs.readdirSync(sub).includes('GAMMA.pdf'));
  expect('a name may have spaces, dots and letters from any script', (await gamma.rename(alpha.token, 'Annual report v1.2 日本')).info.name === 'Annual report v1.2 日本.pdf');
  expect('a document that was deleted is reported, not renamed', await (async () => { fs.rmSync(path.join(sub, 'Annual report v1.2 日本.pdf')); const r = await gamma.rename(alpha.token, 'Back'); return r.stop === 'changed'; })());
  const upper = await gamma.open(make('Upper.PDF', '%PDF-1.7 upper'));
  expect('the extension keeps the case it had', (await gamma.rename(upper.token, 'Lower')).info.name === 'Lower.PDF');
  const copy = await gamma.open(make('Copy.pdf', '%PDF-1.7 copy'));
  await gamma.saveCopy(copy.token, path.join(sub, 'Copied.pdf'));
  await gamma.rename(copy.token, 'Moved');
  await gamma.saveCopy(copy.token, path.join(sub, 'Copied again.pdf'));
  expect('a document that has not been changed is saved as a copy from where it is now', fs.readFileSync(path.join(sub, 'Copied again.pdf'), 'utf8') === '%PDF-1.7 copy %%EOF');
  mode = 'copy';
  const edit = await gamma.open(make('Edit.pdf', '%PDF-1.7 edit'));
  await gamma.apply(edit.token, [{ op: 'pages.rotate', pages: [1], by: 90 }]);
  await gamma.rename(edit.token, 'Edited');
  await gamma.save(edit.token);
  expect('a document with unsaved changes is saved over the file under its new name', fs.readFileSync(path.join(sub, 'Edited.pdf'), 'utf8') === '%PDF-1.7 edit %%EOF +1' && !fs.existsSync(path.join(sub, 'Edit.pdf')));
  expect('another page cannot rename a document it has no token for', (() => { try { gamma.rename('0'.repeat(64), 'x'); return false; } catch { return true; } })());
  await gamma.closeAll();

  console.log('what the PDF engine says about a document');
  const asked = [];
  const informed = createDocuments({
    runPdfTool: async (script, args, options) => {
      if (script === 'pdf_info.py') { asked.push({ args, secrets: options.secrets, signal: options.signal }); fs.writeFileSync(args[1], JSON.stringify({ pageCount: asked.length })); return; }
      fs.writeFileSync(args[1], `${fs.readFileSync(args[0], 'utf8')} +1`);
    },
  });
  const subject = await informed.open(make('Facts.pdf', '%PDF-1.7 facts'));
  const factsOne = await informed.facts(subject.token);
  expect('the helper is asked for the properties of the file, and its answer is parsed', factsOne.pageCount === 1 && asked[0].args[0] === path.join(sub, 'Facts.pdf') && asked[0].args[2] === 'properties' && asked[0].secrets === undefined && path.basename(asked[0].args[1]).endsWith('.json'));
  expect('its output file is gone afterwards', !fs.existsSync(asked[0].args[1]));
  await informed.facts(subject.token);
  expect('the answer is kept for as long as the revision is the same', asked.length === 1);
  await informed.apply(subject.token, [{ op: 'pages.rotate', pages: [1], by: 90 }]);
  const factsTwo = await informed.facts(subject.token);
  expect('a new revision is asked about again, from the copy in the session folder', factsTwo.pageCount === 2 && asked[1].args[0] !== path.join(sub, 'Facts.pdf') && fs.existsSync(path.dirname(asked[1].args[0])));
  await informed.undo(subject.token);
  expect('and going back asks once more', (await informed.facts(subject.token)).pageCount === 3);
  informed.unlock(subject.token, 'Pw-é1');
  await informed.undo(subject.token).catch(() => {});
  await informed.apply(subject.token, [{ op: 'pages.rotate', pages: [1], by: 90 }]);
  await informed.facts(subject.token);
  expect('a password goes to the helper as a secret and is in no argument', JSON.stringify(asked.at(-1).secrets) === '{"password":"Pw-é1"}' && !JSON.stringify(asked.at(-1).args).includes('Pw-'));
  const described = createDocuments({
    runPdfTool: async (script, args) => {
      if (script === 'pdf_info.py') { fs.writeFileSync(args[1], JSON.stringify({ information: { title: 'Old', author: 'A', subject: '', keywords: '', created: null } })); return ''; }
      fs.writeFileSync(args[1], `${fs.readFileSync(args[0], 'utf8')} +1`);
      return '{"saved": "incremental"}';
    },
  });
  const book = await described.open(make('Book.pdf', '%PDF-1.7 book'));
  const titled = (title) => described.apply(book.token, [{ op: 'meta.set', title, author: 'A', subject: '', keywords: '' }]).then((r) => r.info.dirty);
  const unread = [await titled('New'), await titled('Old')].join();
  await described.facts(book.token);
  await described.undo(book.token);
  await described.undo(book.token);
  await described.facts(book.token);
  const changed = await titled('New');
  const back = await titled('Old');
  expect('a Title changed and then typed back as it was leaves nothing to save', changed === true && back === false, JSON.stringify([changed, back]));
  expect('until the engine has read the information of the file, a change typed back still counts as a change', unread === 'true,true', unread);
  expect('going back to the changed Title has something to save again, and forward has not', (await described.undo(book.token)).info.dirty === true && (await described.redo(book.token)).info.dirty === false);
  await titled('Saved');
  await described.save(book.token);
  const afterSave = [await titled('Old'), await titled('Saved')];
  expect('after a save, the text that was saved is the one that leaves nothing to save', afterSave.join() === 'true,false', afterSave.join());
  await described.apply(book.token, [{ op: 'pages.rotate', pages: [1], by: 90 }]);
  expect('a change to the pages is never taken for the saved file, whatever the information says', (await titled('Saved')) === true);
  await described.closeAll();
  const noEngine = createDocuments({ runPdfTool: () => Promise.reject(Object.assign(new Error('The PDF engine is not installed'), { code: 'NO_ENGINE' })) });
  const without = await noEngine.open(make('None.pdf', '%PDF-1.7 none'));
  expect('without the engine the question is rejected with its code', await noEngine.facts(without.token).then(() => '', (e) => e.code) === 'NO_ENGINE');
  const stuck = createDocuments({ runPdfTool: (script, args, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('Cancelled'), { name: 'CancelledError' })))) });
  const slow = await stuck.open(make('Slow.pdf', '%PDF-1.7 slow'));
  const pendingFacts = stuck.facts(slow.token).then(() => 'done', (e) => e.name);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await stuck.close(slow.token);
  expect('closing a document stops the helper that is reading it', await pendingFacts === 'CancelledError');
  await Promise.all([informed.closeAll(), noEngine.closeAll(), stuck.closeAll()]);

  console.log('pages put back as they were');
  let length = 4;
  const arranging = createDocuments({
    runPdfTool: async (script, args) => {
      if (script === 'pdf_info.py') { fs.writeFileSync(args[1], JSON.stringify({ information: { title: 'T', author: '', subject: '', keywords: '', created: null } })); return ''; }
      fs.writeFileSync(args[1], `${fs.readFileSync(args[0], 'utf8')} +1`);
      const began = length;
      for (const op of JSON.parse(fs.readFileSync(args[2], 'utf8')).ops) if (op.op === 'pages.delete') length -= op.pages.length;
      return `{"saved": "full"}
{"pages": ${began}}
OK`;
    },
  });
  const sheet = await arranging.open(make('Sheet.pdf', '%PDF-1.7 sheet'));
  const change = (...ops) => arranging.apply(sheet.token, ops).then((r) => r.info.dirty);
  const turn = (pages, by) => ({ op: 'pages.rotate', pages, by });
  const shift = (pages, before) => ({ op: 'pages.move', pages, before });
  const outcome = [await change(turn([2], 90)), await change(turn([2], 270))];
  expect('a page turned and then turned back leaves nothing to save', outcome.join() === 'true,false', outcome.join());
  const halves = [await change(turn([1, 2], 180)), await change(turn([1], 180)), await change(turn([2], 180))];
  expect('two half turns of every page are the pages as they were', halves.join() === 'true,true,false', halves.join());
  const moved = [await change(shift([1], 3)), await change(shift([2], 1))];
  expect('a page moved and then moved back leaves nothing to save', moved.join() === 'true,false', moved.join());
  const blocks = [await change(shift([1, 2], 4)), await change(shift([2, 3], 1))];
  expect('two pages moved to the end and then moved back leave nothing to save', blocks.join() === 'true,false', blocks.join());
  expect('a move that puts the pages somewhere else is a change', (await change(shift([1], 4))) === true && (await change(shift([3], 1))) === false);
  expect('a page that is gone is a change however the others are put', (await change({ op: 'pages.delete', pages: [4] })) === true && (await change(turn([1], 90))) === true && (await change(turn([1], 270))) === true);
  expect('undo through changes that are not yet the file as it was still has something to save', (await arranging.undo(sheet.token)).info.dirty === true && (await arranging.undo(sheet.token)).info.dirty === true);
  while ((await arranging.undo(sheet.token)) && arranging.list()[0].canUndo);
  expect('every undo back to the start leaves nothing to save', arranging.list()[0].dirty === false);
  length = 4;
  const read = [await change(turn([3], 90))];
  await arranging.facts(sheet.token);
  read.push(await change(turn([3], 270)));
  expect('a page turned and turned back counts as the pages as they were once the information of the file is read, too', read.join() === 'true,false', read.join());
  await change(turn([3], 90));
  await arranging.save(sheet.token);
  const afterwards = [await change(turn([3], 90)), await change(turn([3], 270)), await change(turn([3], 270))];
  expect('after a save the pages as they were saved are the ones that leave nothing to save', afterwards.join() === 'true,false,true', afterwards.join());
  await arranging.closeAll();

  console.log('pages put in and written out');
  const runsOf = [];
  let added = '[2]';
  const inserting = createDocuments({
    checkPassword: async (file, password) => password.toString() === 'right',
    runPdfTool: async (script, args, options) => {
      runsOf.push({ args, list: JSON.parse(fs.readFileSync(args[2], 'utf8')), secrets: options.secrets });
      fs.writeFileSync(args[1], `${fs.readFileSync(args[0], 'utf8')} +1`);
      return `{"saved": "incremental"}
{"pages": 4}
{"added": ${added}}
OK`;
    },
  });
  const chapter = await inserting.open(make('Book.pdf', '%PDF-1.7 chapter'));
  const piece = make('Part.pdf', '%PDF-1.7 piece');
  const picked = inserting.addSource(piece, 'pdf');
  const insertAt = (before, ...sources) => ({ op: 'pages.insert', before, sources });
  expect('a file to insert gets an id of 32 hex digits, and the id is not the path', /^[0-9a-f]{32}$/.test(picked) && !piece.toLowerCase().includes(picked));
  const inserted = await inserting.apply(chapter.token, [insertAt(2, picked)]);
  expect('the helper is given the file by path and kind under the id, and the page never sees the path', JSON.stringify(runsOf[0].list.ops[0].sources) === JSON.stringify([{ id: picked, file: piece, kind: 'pdf' }]) && !JSON.stringify(inserted).includes('Part.pdf') && inserted.reload === true);
  expect('with no password given the helper is sent none', runsOf[0].secrets === undefined);
  expect('a file is forgotten once the change that used it is made', await inserting.apply(chapter.token, [insertAt(2, picked)]).then(() => '', (e) => e.message) === 'A file to insert is no longer available.');
  expect('an id that was never given is refused the same way', await inserting.apply(chapter.token, [insertAt(2, 'f'.repeat(32))]).then(() => '', (e) => e.message) === 'A file to insert is no longer available.');
  const wrongOne = inserting.addSource(piece, 'pdf');
  expect('a wrong password is turned down and kept nowhere', (await inserting.unlockSource(wrongOne, 'wrong')) === false);
  await inserting.apply(chapter.token, [insertAt(1, wrongOne)]).catch(() => {});
  expect('so the change that follows is sent no password', runsOf.at(-1).secrets === undefined);
  const again = inserting.addSource(piece, 'pdf');
  expect('the right password is accepted', (await inserting.unlockSource(again, 'right')) === true);
  await inserting.apply(chapter.token, [insertAt(1, again)]);
  expect('and it reaches the helper under the id of its file, beside the password of the document itself', JSON.stringify(runsOf.at(-1).secrets) === JSON.stringify({ sources: { [again]: 'right' } }));
  inserting.unlock(chapter.token, 'own-password');
  const both = inserting.addSource(piece, 'pdf');
  await inserting.unlockSource(both, 'right');
  await inserting.apply(chapter.token, [insertAt(1, both)]);
  expect('both are sent together, and the list file holds neither', JSON.stringify(runsOf.at(-1).secrets) === JSON.stringify({ password: 'own-password', sources: { [both]: 'right' } }) && !JSON.stringify(runsOf.at(-1).list).includes('right'));
  expect('a password for a file that is not known is refused', await inserting.unlockSource('e'.repeat(32), 'right').then(() => '', (e) => e.message) === 'unknown file');
  expect('and one that is not text', await inserting.unlockSource(inserting.addSource(piece, 'pdf'), 5).then(() => 'written', () => 'refused') === 'refused');
  expect('a list may not name a path in place of an id', (() => { try { inserting.apply(chapter.token, [insertAt(1, piece)]); return false; } catch { return true; } })());
  expect('a change that makes a new file is not made on the document', (() => { try { inserting.apply(chapter.token, [{ op: 'pages.extract', pages: [1] }]); return false; } catch { return true; } })());

  const added4 = [];
  const grid = createDocuments({ runPdfTool: async (script, args) => { fs.writeFileSync(args[1], `${fs.readFileSync(args[0], 'utf8')} +1`); return `{"saved": "incremental"}
{"pages": 3}
{"added": ${added4.shift() ?? '[0]'}}
OK`; } });
  const shelf = await grid.open(make('Shelf.pdf', '%PDF-1.7 shelf'));
  const from = grid.addSource(piece, 'pdf');
  added4.push('[2]');
  const put = (await grid.apply(shelf.token, [insertAt(2, from)])).info;
  expect('pages put in are a change to save, and the state names them as added', put.dirty === true && JSON.stringify(put.added) === '[2,3]', JSON.stringify(put));
  expect('a file as it was opened has no added pages', JSON.stringify((await grid.open(make('Plain shelf.pdf', '%PDF-1.7 plain shelf'))).added) === '[]');
  expect('taking those pages out again leaves the file as it was, with none added', (await grid.apply(shelf.token, [{ op: 'pages.delete', pages: [2, 3] }])).info.added.length === 0 && !grid.list().find((d) => d.token === shelf.token).dirty);
  added4.push('[1]');
  const blanked = (await grid.apply(shelf.token, [{ op: 'pages.blank', before: 4 }])).info;
  expect('a blank page is a change to save too, and is added', blanked.dirty === true && JSON.stringify(blanked.added) === '[4]', JSON.stringify(blanked));
  const shelfSaved = (await grid.save(shelf.token)).info;
  expect('saving makes the pages put in part of the file, so none is added any more', shelfSaved.dirty === false && shelfSaved.added.length === 0, JSON.stringify(shelfSaved));
  added4.push('[1]');
  const after = (await grid.apply(shelf.token, [{ op: 'pages.blank', before: 1 }])).info;
  expect('a page put in after a save is the only one added', after.dirty === true && JSON.stringify(after.added) === '[1]', JSON.stringify(after));
  const atSave = (await grid.undo(shelf.token)).info;
  expect('undoing to the file as saved has nothing to save and nothing added', atSave.dirty === false && atSave.added.length === 0, JSON.stringify(atSave));
  expect('undoing past the save leaves something to save', (await grid.undo(shelf.token)).info.dirty === true);
  await grid.closeAll();

  const outputs = path.join(root, 'Taken.pdf');
  const ran = runsOf.length;
  const unchanged = inserting.list()[0];
  const written = await inserting.extract(chapter.token, [3, 1], outputs);
  expect('extracting writes the pages to the target and leaves the document and its revisions as they were', written.done === true && fs.existsSync(outputs) && JSON.stringify(inserting.list()[0]) === JSON.stringify(unchanged));
  expect('the helper is asked for the pages in a list of one change, on the revision on show', runsOf.length === ran + 1 && JSON.stringify(runsOf.at(-1).list.ops) === '[{"op":"pages.extract","pages":[3,1]}]' && /revision-\d+\.pdf$/.test(runsOf.at(-1).args[0]));
  expect('what the helper wrote is not left in the temp folder', !fs.existsSync(runsOf.at(-1).args[1]));
  expect('pages that are not a list of pages are refused before the helper starts', (() => { try { inserting.extract(chapter.token, [], outputs); return false; } catch { return true; } })() && runsOf.length === ran + 1);
  const joined = inserting.addSource(piece, 'pdf');
  const combinedTo = path.join(root, 'Combined.pdf');
  const asBefore = JSON.stringify(inserting.list()[0]);
  const combined = await inserting.merge(chapter.token, [joined], 1, combinedTo);
  expect('combining writes the document and the files to the target and leaves the document and its revisions as they were', combined.done === true && fs.existsSync(combinedTo) && JSON.stringify(inserting.list()[0]) === asBefore);
  expect('the helper is given the files by path and kind under their ids, and the place of the document', JSON.stringify(runsOf.at(-1).list.ops) === JSON.stringify([{ op: 'pages.merge', sources: [{ id: joined, file: piece, kind: 'pdf' }], at: 1 }]));
  expect('a file is forgotten once it was combined', await inserting.merge(chapter.token, [joined], 1, combinedTo).then(() => '', (e) => e.message) === 'A file to insert is no longer available.');
  expect('files that are not ids are refused before the helper starts', (() => { try { inserting.merge(chapter.token, [piece], 0, combinedTo); return false; } catch { return true; } })());
  const parted = [];
  const ranBefore = runsOf.length;
  const made = await inserting.split(chapter.token, [[1, 2], [3]], (pages) => { parted.push(pages); return path.join(root, `Taken ${pages.join('-')}.pdf`); });
  expect('a split writes each list of pages to the path it is given, and leaves the document as it was', made.done === true && JSON.stringify(made.files.map((f) => path.basename(f))) === '["Taken 1-2.pdf","Taken 3.pdf"]' && made.files.every((f) => fs.existsSync(f)) && JSON.stringify(inserting.list()[0]) === asBefore);
  expect('the helper is run once for each file, on the same revision', runsOf.length === ranBefore + 2 && JSON.stringify(runsOf.slice(-2).map((r) => r.list.ops)) === '[[{"op":"pages.extract","pages":[1,2]}],[{"op":"pages.extract","pages":[3]}]]' && runsOf.at(-1).args[0] === runsOf.at(-2).args[0]);
  expect('each name is asked for once, as that file is about to be written', JSON.stringify(parted) === '[[1,2],[3]]');
  expect('a split with a list that is not pages is refused before any file is written', (() => { try { inserting.split(chapter.token, [[1], []], () => combinedTo); return false; } catch { return true; } })() && runsOf.length === ranBefore + 2);
  const clean = await createDocuments({ runPdfTool: async (script, args) => { fs.writeFileSync(args[1], '%PDF-1.7 out %%EOF'); runsOf.push({ source: args[0] }); return ''; } });
  const plain = await clean.open(make('Plain.pdf', '%PDF-1.7 plain'));
  await clean.extract(plain.token, [1], path.join(root, 'Plain out.pdf'));
  expect('a document with no change yet is read by the helper from the file itself, with no copy made', runsOf.at(-1).source === make('Plain.pdf', '%PDF-1.7 plain') && !clean.list()[0].dirty);
  await Promise.all([clean.closeAll(), inserting.closeAll()]);

  console.log('several documents');
  const tabs = createDocuments();
  const one = await tabs.open(file);
  const two = await tabs.open(shrinking);
  expect('the documents are listed in the order they were opened', JSON.stringify(tabs.list().map((d) => d.name)) === '["Report.pdf","Shrinking.pdf"]');
  expect('a document is found by its path, whatever the case or the spelling of it', tabs.find(file)?.token === one.token && tabs.find(file.toUpperCase())?.token === one.token && tabs.find(path.join(root, '.', 'Report.pdf'))?.token === one.token && tabs.find(path.join(root, 'Other.pdf')) === null);
  tabs.unlock(one.token, 'secret');
  const secret = tabs.password(one.token);
  tabs.close(one.token);
  expect('closing one document closes only that one, and forgets and overwrites its password', tabs.list().length === 1 && tabs.find(file) === null && secret.every((b) => b === 0) && tabs.password(one.token) === undefined && await fails(tabs.read(one.token, 0, 10)) && (await tabs.read(two.token, 0, 10)).length === 10);
  tabs.close(one.token);
  tabs.close('not a token');
  expect('closing a document twice, or one that was never open, does nothing', tabs.list().length === 1);
  tabs.closeAll();

  console.log('closing');
  docs.closeAll();
  expect('closing forgets every password and overwrites it with zeros', docs.password(doc.token) === undefined && last.every((b) => b === 0));
  expect('after closing, no token reads', await fails(docs.read(doc.token, 0, 10)) && docs.served() === 0);
  await new Promise((resolve) => setTimeout(resolve, 100));
  fs.rmSync(shrinking);
  expect('and Windows no longer holds the files', !fs.existsSync(shrinking));
  finish();
})().catch((e) => { console.error(e); finish(2); });

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
  expect('a document has a name and a size, and its token is 32 random bytes in hex', doc.name === 'Report.pdf' && doc.size === content.length && /^[0-9a-f]{64}$/.test(doc.token) && Object.keys(doc).sort().join() === 'dirty,name,size,token', JSON.stringify(Object.keys(doc)));
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
  expect('the document record carries no password', !JSON.stringify(doc).includes('Pw-') && Object.keys(doc).sort().join() === 'dirty,name,size,token');
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
  const runPdfTool = async (script, args, options) => {
    const [source, target, listFile] = args;
    runs.push({ script, source, target, list: fs.readFileSync(listFile, 'utf8'), secrets: options.secrets, signal: options.signal });
    if (mode === 'fail') { fs.writeFileSync(target, 'half'); throw new Error('This file is damaged or is not a PDF'); }
    if (mode === 'wait') await new Promise((resolve) => options.signal.addEventListener('abort', resolve));
    if (options.signal.aborted) { fs.writeFileSync(target, 'half'); throw Object.assign(new Error('Cancelled'), { name: 'CancelledError' }); }
    fs.writeFileSync(target, `${fs.readFileSync(source, 'utf8')} +1`);
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
  expect('undo steps back one change at a time', (await edits.undo(edited.token)).info.size === result.info.size && (await edits.undo(edited.token)).info.size === '%PDF-1.7 the original'.length && !(await edits.undo(edited.token)));
  expect('a document with no password gives the helper no secret', runs[0].secrets === undefined);
  edits.unlock(edited.token, 'Pw-é1');
  await edits.apply(edited.token, rotate);
  expect('the password goes to the helper as a secret, and is in neither the list nor the arguments', JSON.stringify(runs[2].secrets) === '{"password":"Pw-é1"}' && !runs[2].list.includes('Pw-') && runs.every((run) => !run.source.includes('Pw-')));
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
  expect('the folder and the time of the last change are given, never the path', JSON.stringify(Object.keys(await gamma.details(alpha.token))) === '["folder","modified"]' && (await gamma.details(alpha.token)).folder === 'Reports › 2026' && typeof (await gamma.details(alpha.token)).modified === 'number');
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

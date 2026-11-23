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
  expect('a document has a name and a size, and its token is 32 random bytes in hex', doc.name === 'Report.pdf' && doc.size === content.length && /^[0-9a-f]{64}$/.test(doc.token) && Object.keys(doc).sort().join() === 'name,size,token', JSON.stringify(Object.keys(doc)));
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
  expect('the document record carries no password', !JSON.stringify(doc).includes('Pw-') && Object.keys(doc).sort().join() === 'name,size,token');
  docs.unlock(doc.token, 'another');
  expect('a new password replaces the old one, which is overwritten with zeros', docs.password(doc.token).toString() === 'another' && stored.every((b) => b === 0));
  const refusedPasswords = { 'an unknown token': ['0'.repeat(64), 'x'], 'no password': [doc.token, undefined], 'an empty password': [doc.token, ''], 'a password that is not text': [doc.token, 12], 'a password of 4097 characters': [doc.token, 'x'.repeat(4097)] };
  for (const [what, args] of Object.entries(refusedPasswords)) expect(`${what} is refused`, (() => { try { docs.unlock(...args); return false; } catch { return true; } })());
  expect('a refused password changes nothing', docs.password(doc.token).toString() === 'another');
  const last = docs.password(doc.token);

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

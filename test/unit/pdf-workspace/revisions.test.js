// SPDX-License-Identifier: AGPL-3.0-or-later
// The versions of a document: the chain with its limits, and a document that is changed, stepped back and forward, saved, saved as a
// copy, reloaded and closed.
//   node test/unit/pdf-workspace/revisions.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRevisions, MAX_REVISIONS } = require('../../../src/features/pdf-workspace/revisions');
const { createDocuments, NO_ENGINE_SAVE_LIMIT } = require('../../../src/features/pdf-workspace/documents');
const { expect } = require('../../support/expect');
const finish = require('../../support/finish');
const { dir: tmpDir } = require('../../support/tmp');

const pdf = (text) => Buffer.from(`%PDF-1.4\n${text}\n%%EOF\n`);
const sessions = () => fs.readdirSync(os.tmpdir()).filter((n) => n.endsWith('.pdfws.d'));
const refuses = async (fn) => { try { await fn(); return false; } catch { return true; } };
const readAll = async (docs, info) => docs.read(info.token, 0, info.size);

(async () => {
  const root = tmpDir('ws-rev');
  const make = async (name, text, owned = true) => {
    const file = path.join(root, name);
    fs.writeFileSync(file, pdf(text));
    return { file, handle: await fs.promises.open(file, 'r'), size: pdf(text).length, owned, refs: 0 };
  };

  console.log('the chain');
  {
    const first = await make('first.pdf', 'first', false);
    const chain = createRevisions(first);
    expect('a new chain shows its first revision, unchanged', chain.current() === first && !chain.dirty() && chain.undo() === null && chain.redo() === null);
    const a = await make('a.pdf', 'a');
    const b = await make('b.pdf', 'b');
    await chain.push(a, 1e9);
    await chain.push(b, 1e9);
    expect('a pushed revision is the one on show and the chain has changes', chain.current() === b && chain.dirty());
    expect('undo and redo step one revision, and stop at the ends', chain.undo() === a && chain.undo() === first && chain.undo() === null && chain.redo() === a && chain.redo() === b && chain.redo() === null);
    expect('undo and redo say whether there is a step to take', chain.canUndo() && !chain.canRedo() && chain.undo() === a && chain.canUndo() && chain.canRedo() && chain.undo() === first && !chain.canUndo() && chain.canRedo() && chain.redo() === a && chain.redo() === b);
    chain.undo();
    chain.markSaved();
    expect('what is saved is not a change', !chain.dirty() && chain.undo() === first && chain.dirty() && chain.redo() === a && !chain.dirty());
    const c = await make('c.pdf', 'c');
    await chain.push(c, 1e9);
    expect('a push after an undo drops what could have been redone, and deletes its file', chain.redo() === null && !fs.existsSync(b.file) && fs.existsSync(a.file) && chain.dirty());
    expect('the file the user owns is never deleted', fs.existsSync(first.file));

    const reading = await make('reading.pdf', 'reading');
    const busy = createRevisions(await make('base.pdf', 'base', false));
    await busy.push(reading, 1e9);
    busy.acquire(reading);
    busy.undo();
    await busy.push(await make('again.pdf', 'again'), 1e9);
    expect('a revision that is being read stays until the read ends', fs.existsSync(reading.file));
    busy.release(reading);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect('and goes when it ends', !fs.existsSync(reading.file));
    await busy.dispose();
  }

  console.log('the limits');
  {
    const chain = createRevisions(await make('l0.pdf', 'l0', false));
    for (let n = 1; n <= MAX_REVISIONS + 5; n++) await chain.push(await make(`l${n}.pdf`, `l${n}`), 1e9);
    let steps = 0;
    while (chain.undo()) steps++;
    expect(`at most ${MAX_REVISIONS} revisions are kept, the first and the newest among them`, steps === MAX_REVISIONS - 1 && chain.current().file.endsWith('l0.pdf') && fs.existsSync(chain.current().file));
    while (chain.redo());
    expect('the newest is on show', chain.current().file.endsWith(`l${MAX_REVISIONS + 5}.pdf`));
    expect('the oldest after the first were deleted', !fs.existsSync(path.join(root, 'l1.pdf')) && !fs.existsSync(path.join(root, 'l6.pdf')) && fs.existsSync(path.join(root, 'l7.pdf')));

    const small = createRevisions(await make('s0.pdf', 's0', false));
    const one = await make('s1.pdf', 's1');
    const two = await make('s2.pdf', 's2');
    const three = await make('s3.pdf', 's3');
    const budget = one.size + two.size + 1;
    for (const rev of [one, two, three]) await small.push(rev, budget);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect('revisions are dropped, oldest first, when they pass the disk budget', !fs.existsSync(one.file) && fs.existsSync(two.file) && fs.existsSync(three.file) && small.undo() === two && small.undo().file.endsWith('s0.pdf'));
    const alone = createRevisions(await make('t0.pdf', 't0', false));
    const huge = await make('t1.pdf', 't1');
    await alone.push(huge, 1);
    expect('the revision on show is never dropped, whatever the budget', alone.current() === huge && fs.existsSync(huge.file));
  }

  console.log('a document with changes');
  {
    const file = path.join(root, 'Report.pdf');
    fs.writeFileSync(file, pdf('original'));
    const docs = createDocuments();
    const doc = await docs.open(file);
    const before = sessions().length;
    expect('a document starts without changes and with no session folder', doc.dirty === false && sessions().length === before);

    expect('bytes that are not a PDF are refused', (await Promise.all([Buffer.from('hello'), Buffer.alloc(0), 'text'].map((bytes) => refuses(() => docs.putRevision(doc.token, bytes))))).every(Boolean));
    const put = await docs.putRevision(doc.token, pdf('edited, and a little longer'));
    expect('a revision from the page is the document now: it has changes, a new size, and is what is read', put.info.dirty && put.info.size === pdf('edited, and a little longer').length && (await readAll(docs, put.info)).equals(pdf('edited, and a little longer')));
    expect('the first change made one session folder, and the file on disk is untouched', sessions().length === before + 1 && fs.readFileSync(file).equals(pdf('original')));
    const undone = await docs.undo(doc.token);
    expect('undo gives back the version that was opened, with nothing to save', !undone.info.dirty && (await readAll(docs, undone.info)).equals(pdf('original')) && await docs.undo(doc.token) === null);
    const redone = await docs.redo(doc.token);
    expect('redo gives the change back', redone.info.dirty && (await readAll(docs, redone.info)).equals(pdf('edited, and a little longer')) && await docs.redo(doc.token) === null);

    const saved = await docs.save(doc.token);
    expect('save puts the revision in place of the file and clears the changes', !saved.info.dirty && fs.readFileSync(file).equals(pdf('edited, and a little longer')) && fs.readdirSync(root).filter((n) => /\.tmp$/.test(n)).length === 0);
    expect('saving again with nothing to save changes nothing', (await docs.save(doc.token)).info.dirty === false);
    const back = await docs.undo(doc.token);
    expect('after a save, undo is a change again, and saving it writes the older version', back.info.dirty && (await docs.save(doc.token)).info && fs.readFileSync(file).equals(pdf('original')));

    await docs.putRevision(doc.token, pdf('one'));
    await Promise.all([docs.putRevision(doc.token, pdf('two')), docs.putRevision(doc.token, pdf('three'))]);
    expect('changes made together are applied one after the other', (await readAll(docs, docs.list()[0])).equals(pdf('three')));

    const copy = path.join(root, 'Copy.pdf');
    const copied = await docs.saveCopy(doc.token, copy);
    expect('a copy is written and the document keeps its changes and its file', copied.info.dirty && fs.readFileSync(copy).equals(pdf('three')) && fs.readFileSync(file).equals(pdf('original')));
    fs.writeFileSync(copy, pdf('somebody else'));
    expect('a copy over a file that is there replaces it', !(await docs.saveCopy(doc.token, copy)).stop && fs.readFileSync(copy).equals(pdf('three')));

    const reloaded = await docs.reload(doc.token);
    expect('reload forgets the changes and reads the file again', !reloaded.info.dirty && (await readAll(docs, reloaded.info)).equals(pdf('original')) && sessions().length === before);

    await docs.putRevision(doc.token, pdf('edited again'));
    fs.writeFileSync(file, pdf('changed by another program, longer'));
    const stopped = await docs.save(doc.token);
    expect('a file changed by another program is not saved over, and the reason is given with its name', stopped.stop === 'changed' && stopped.name === 'Report.pdf' && fs.readFileSync(file).equals(pdf('changed by another program, longer')));

    await docs.close(doc.token);
    expect('closing removes the session folder, and the file is free', sessions().length === before && (fs.rmSync(file), !fs.existsSync(file)));
    expect('a closed document is gone', await refuses(() => docs.putRevision(doc.token, pdf('late'))));
  }

  console.log('a file changed before the first change');
  {
    const file = path.join(root, 'Moved.pdf');
    fs.writeFileSync(file, pdf('one'));
    const docs = createDocuments();
    const doc = await docs.open(file);
    const before = sessions().length;
    fs.writeFileSync(file, pdf('another program wrote this'));
    const stopped = await docs.putRevision(doc.token, pdf('mine'));
    expect('the change is refused before anything is copied, and no session folder is left', stopped.stop === 'changed' && stopped.name === 'Moved.pdf' && sessions().length === before && !(await docs.list())[0].dirty);
    fs.rmSync(file);
    expect('a file that was deleted is the same', (await docs.putRevision(doc.token, pdf('mine'))).stop === 'changed' && sessions().length === before);
    await docs.closeAll();
  }

  console.log('limits on a change');
  {
    const file = path.join(root, 'Limits.pdf');
    fs.writeFileSync(file, pdf('x'));
    const docs = createDocuments();
    const doc = await docs.open(file);
    const none = sessions().length;
    const sized = (n) => { const b = Buffer.alloc(n, 0x20); b.write('%PDF-1.4\n'); return b; };
    const over = await docs.putRevision(doc.token, sized(NO_ENGINE_SAVE_LIMIT + 1));
    expect('a revision one byte over the limit is refused and nothing is written', over.stop === 'too-large' && sessions().length === none && !(await docs.list())[0].dirty);
    const at = await docs.putRevision(doc.token, sized(NO_ENGINE_SAVE_LIMIT));
    expect('one at the limit is taken', at.info.size === NO_ENGINE_SAVE_LIMIT && at.info.dirty);
    await docs.close(doc.token);

    const second = await docs.open(file);
    const real = fs.promises.statfs;
    fs.promises.statfs = async () => ({ bavail: 100, bsize: 4096 });
    const full = await docs.putRevision(second.token, pdf('y'));
    fs.promises.statfs = real;
    expect('a full temp drive refuses the change and names the drive', full.stop === 'no-space' && /^[A-Za-z]:$/.test(full.drive) && !(await docs.list())[0].dirty && sessions().length === none, JSON.stringify(full));
    await docs.closeAll();
  }

  finish();
})().catch((e) => { console.error(e); finish(2); });

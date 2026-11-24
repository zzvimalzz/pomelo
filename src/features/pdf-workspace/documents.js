// SPDX-License-Identifier: AGPL-3.0-or-later
// The PDFs the workspace has open. Each is read through one handle held from the moment it was opened, so the page gets bytes by
// range and never a path, and a file replaced on disk by another program cannot mix two versions into one view. A change from the
// page becomes a revision in a session folder, which Save puts in place of the file. No Electron in here.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileIdentity, sameFile, replaceFile, makeTempDir, sweepTempDirs, removeDirReliably } = require('#shared/node/fs');
const { passwordBuffer } = require('#shared/node/secrets');
const { check } = require('./ops');
const { createRevisions } = require('./revisions');

const MAX_SPAN = 4 * 1048576;
const NO_ENGINE_SAVE_LIMIT = 100 * 1048576;
const SESSION_TAG = 'pdfws';
const FREE_MARGIN = 64 * 1048576;
const MIN_BUDGET = 2 * 1024 ** 3;
const CHANGED = { stop: 'changed' };

const info = (doc) => ({ token: doc.token, name: doc.name, size: doc.revisions.current().size, dirty: doc.revisions.dirty() });
const keyOf = (file) => path.resolve(file).toLowerCase();
const driveOf = (where) => path.parse(path.resolve(where)).root.replace(/\\$/, '');
const freeBytes = async (dir) => { const f = await fs.promises.statfs(dir); return f.bavail * f.bsize; };

// runPdfTool(script, args, { src, signal, secrets }): runs a PDF editing helper (the app hands in the conversion feature's).
function createDocuments({ runPdfTool } = {}) {
  const byToken = new Map();
  const passwords = new Map();

  const get = (token) => {
    const doc = typeof token === 'string' ? byToken.get(token) : null;
    if (!doc) throw new Error('unknown document');
    return doc;
  };
  const stopped = (doc, stop, where) => ({ stop, name: doc.name, drive: driveOf(where) });
  const serial = (doc, fn) => {
    const turn = doc.turn.then(fn);
    doc.turn = turn.catch(() => {});
    return turn;
  };

  // Windows paths are not case-sensitive, so two spellings of one file are one document.
  const find = (file) => { const doc = [...byToken.values()].find((d) => d.key === keyOf(file)); return doc ? info(doc) : null; };
  const list = () => [...byToken.values()].map(info);

  async function load(doc) {
    const handle = await fs.promises.open(doc.file, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOTFILE' });
      doc.identity = await fileIdentity(doc.file);
      doc.originalSize = stat.size;
      doc.revisions = createRevisions({ file: doc.file, handle, size: stat.size, owned: false, refs: 0 });
      doc.session = null;
      doc.count = 0;
    } catch (e) {
      await handle.close();
      throw e;
    }
  }

  async function open(file) {
    const doc = { token: crypto.randomBytes(32).toString('hex'), name: path.basename(file), file, served: 0, key: keyOf(file), turn: Promise.resolve(), stop: new AbortController() };
    await load(doc);
    byToken.set(doc.token, doc);
    return info(doc);
  }

  async function read(token, begin, end) {
    const doc = get(token);
    const rev = doc.revisions.current();
    if (!Number.isInteger(begin) || !Number.isInteger(end) || begin < 0 || end <= begin || end > rev.size || end - begin > MAX_SPAN) throw new Error('bad range');
    doc.revisions.acquire(rev);
    try {
      const buffer = Buffer.allocUnsafe(end - begin);
      const { bytesRead } = await rev.handle.read(buffer, 0, buffer.length, begin);
      if (bytesRead !== buffer.length) throw new Error('the file changed while it was open');
      doc.served += bytesRead;
      return buffer;
    } finally {
      doc.revisions.release(rev);
    }
  }

  // The first change copies the file into the session folder and lets go of it, so Undo always has the version that was opened and
  // Save is the only thing that touches the user's file again. Another program having changed the file stops it.
  async function snapshot(doc) {
    const dir = makeTempDir(SESSION_TAG);
    const file = path.join(dir, 'revision-0.pdf');
    try {
      if (!sameFile(await fileIdentity(doc.file), doc.identity)) throw CHANGED;
      await fs.promises.copyFile(doc.file, file, fs.constants.COPYFILE_EXCL);
      if (!sameFile(await fileIdentity(doc.file), doc.identity)) throw CHANGED;
      const handle = await fs.promises.open(file, 'r');
      await doc.revisions.replaceFirst({ file, handle, size: doc.originalSize, owned: true, refs: 0 });
      doc.session = dir;
      return null;
    } catch (e) {
      await removeDirReliably(dir);
      if (e === CHANGED || e.code === 'ENOENT') return CHANGED;
      throw e;
    }
  }

  // Makes room for the next revision: checks the free space and, for the first change, takes the snapshot. Resolves { free, where } or
  // { stop } with 'no-space' or 'changed'.
  async function prepare(doc, need) {
    const first = !doc.session;
    const where = first ? os.tmpdir() : doc.session;
    const free = await freeBytes(where);
    if (free < need + (first ? doc.originalSize : 0)) return stopped(doc, 'no-space', where);
    if (first && (await snapshot(doc))) return stopped(doc, 'changed', doc.file);
    return { free, where };
  }

  async function adopt(doc, file, size, free) {
    const handle = await fs.promises.open(file, 'r');
    await doc.revisions.push({ file, handle, size, owned: true, refs: 0 }, Math.min(Math.max(MIN_BUDGET, 4 * doc.originalSize), free / 2));
    return { info: info(doc) };
  }

  // The whole file as pdf.js saved it, which becomes the next revision. Resolves the document's new state, or { stop } with
  // 'too-large', 'changed' or 'no-space', with the file's name and the drive that is full.
  function putRevision(token, bytes) {
    const doc = get(token);
    const data = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
    if (!(data instanceof Uint8Array) || !data.length || !Buffer.from(data.buffer, data.byteOffset, Math.min(data.length, 1024)).includes('%PDF-')) throw new Error('not a PDF');
    if (data.length > NO_ENGINE_SAVE_LIMIT) return Promise.resolve(stopped(doc, 'too-large', doc.file));
    return serial(doc, async () => {
      const room = await prepare(doc, data.length + FREE_MARGIN);
      if (room.stop) return room;
      const file = path.join(doc.session, `revision-${++doc.count}.pdf`);
      try {
        await fs.promises.writeFile(file, data, { flag: 'wx' });
      } catch (e) {
        await fs.promises.rm(file, { force: true });
        if (e.code === 'ENOSPC') return stopped(doc, 'no-space', room.where);
        throw e;
      }
      return adopt(doc, file, data.length, room.free);
    });
  }

  // A checked list of changes that the PDF engine makes to the revision on show; the result is the next revision. The helper reads and
  // writes only files in the session folder, and the password reaches it on its standard input. Closing the document stops it. Throws
  // for a list that is not allowed; otherwise resolves like putRevision, and rejects with the helper's reason when it fails.
  function apply(token, ops) {
    const doc = get(token);
    const list = check(ops);
    return serial(doc, async () => {
      const room = await prepare(doc, 2 * doc.revisions.current().size + FREE_MARGIN);
      if (room.stop) return room;
      const source = doc.revisions.current().file;
      const out = path.join(doc.session, `revision-${++doc.count}.pdf`);
      const listFile = path.join(doc.session, `ops-${doc.count}.json`);
      const secret = passwords.get(token);
      try {
        await fs.promises.writeFile(listFile, JSON.stringify({ version: 1, ops: list }));
        await runPdfTool('pdf_edit.py', [source, out, listFile], { src: source, signal: doc.stop.signal, secrets: secret && { password: secret.toString('utf8') } });
        return await adopt(doc, out, (await fs.promises.stat(out)).size, room.free);
      } catch (e) {
        await fs.promises.rm(out, { force: true });
        throw e;
      } finally {
        await fs.promises.rm(listFile, { force: true });
      }
    });
  }

  const step = (token, way) => { const doc = get(token); return serial(doc, async () => (doc.revisions[way]() ? { info: info(doc) } : null)); };
  const undo = (token) => step(token, 'undo');
  const redo = (token) => step(token, 'redo');

  function save(token) {
    const doc = get(token);
    return serial(doc, async () => {
      if (!doc.revisions.dirty()) return { info: info(doc) };
      const result = await replaceFile(doc.revisions.current().file, doc.file, doc.identity);
      if (result.stop) return stopped(doc, result.stop, doc.file);
      doc.identity = result.identity;
      doc.revisions.markSaved();
      return { info: info(doc) };
    });
  }

  function saveCopy(token, target) {
    const doc = get(token);
    return serial(doc, async () => {
      const there = await fileIdentity(target).catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
      const result = await replaceFile(doc.revisions.current().file, target, there);
      return result.stop ? stopped(doc, result.stop, target) : { info: info(doc) };
    });
  }

  function reload(token) {
    const doc = get(token);
    return serial(doc, async () => {
      await end(doc);
      await load(doc);
      return { info: info(doc) };
    });
  }

  // A password lives only here, in memory, and only once pdf.js has accepted it. It is not a field of the document, so no log or
  // state message can carry it.
  function unlock(token, password) {
    if (!byToken.has(token)) throw new Error('unknown document');
    const secret = passwordBuffer(password);
    passwords.get(token)?.fill(0);
    passwords.set(token, secret);
  }

  const password = (token) => passwords.get(token);
  const fileOf = (token) => get(token).file;

  async function end(doc) {
    await doc.revisions.dispose();
    if (doc.session) await removeDirReliably(doc.session);
    doc.session = null;
  }

  function close(token) {
    const doc = byToken.get(token);
    if (!doc) return Promise.resolve();
    byToken.delete(token);
    doc.stop.abort();
    passwords.get(token)?.fill(0);
    passwords.delete(token);
    return doc.turn.then(() => end(doc));
  }

  function closeAll() {
    const ending = [...byToken.values()].map((doc) => { doc.stop.abort(); return doc.turn.then(() => end(doc)); });
    byToken.clear();
    for (const secret of passwords.values()) secret.fill(0);
    passwords.clear();
    return Promise.all(ending);
  }

  const served = () => [...byToken.values()].reduce((sum, doc) => sum + doc.served, 0);

  return { open, find, list, read, unlock, password, fileOf, putRevision, apply, undo, redo, save, saveCopy, reload, close, closeAll, served };
}

const sweepSessions = () => sweepTempDirs(SESSION_TAG, 24 * 3600 * 1000);

module.exports = { createDocuments, sweepSessions, MAX_SPAN, NO_ENGINE_SAVE_LIMIT };

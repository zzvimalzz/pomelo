// SPDX-License-Identifier: AGPL-3.0-or-later
// The PDFs the workspace has open. Each is read through one handle held from the moment it was opened, so the page gets bytes by
// range and never a path, and a file replaced on disk by another program cannot mix two versions into one view. A change from the
// page becomes a revision in a session folder, which Save puts in place of the file. No Electron in here.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileIdentity, sameFile, replaceFile, makeTempDir, sweepTempDirs, removeDirReliably, withTempFile } = require('#shared/node/fs');
const { passwordBuffer } = require('#shared/node/secrets');
const { check, arrange, OPS } = require('./ops');
const { createRevisions } = require('./revisions');

const MAX_SPAN = 4 * 1048576;
const NO_ENGINE_SAVE_LIMIT = 100 * 1048576;
const SESSION_TAG = 'pdfws';
const FREE_MARGIN = 64 * 1048576;
const MIN_BUDGET = 2 * 1024 ** 3;
const MAX_TRACKED_PAGES = 50000;
const MAX_SOURCES = 100;
const CHANGED = { stop: 'changed' };
const DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const IN_USE = new Set(['EBUSY', 'EPERM', 'EACCES']);

const badName = (name) => !name || name.length > 200 || /[\\/:*?"<>|]/.test(name) || [...name].some((c) => c < ' ') || /[. ]$/.test(name) || DEVICE_NAME.test(name);
// The numbers of the pages that were not in the file when it was opened.
const addedPages = (rev) => (rev.layout?.pages ?? []).flatMap(([from], i) => (from ? [] : [i + 1]));
const info = (doc) => ({ token: doc.token, name: doc.name, size: doc.revisions.current().size, dirty: doc.revisions.dirty(), canUndo: doc.revisions.canUndo(), canRedo: doc.revisions.canRedo(), added: addedPages(doc.revisions.current()) });
const keyOf = (file) => path.resolve(file).toLowerCase();
const metaOf = (values) => JSON.stringify(['title', 'author', 'subject', 'keywords'].map((key) => values[key] ?? ''));
const driveOf = (where) => path.parse(path.resolve(where)).root.replace(/\\$/, '');
const freeBytes = async (dir) => { const f = await fs.promises.statfs(dir); return f.bavail * f.bsize; };

// runPdfTool(script, args, { src, signal, secrets }): runs a PDF editing helper (the app hands in the conversion feature's).
// checkPassword(file, password): resolves whether a Buffer opens a PDF.
function createDocuments({ runPdfTool, checkPassword } = {}) {
  const byToken = new Map();
  const passwords = new Map();
  const sources = new Map();

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

  async function adopt(doc, file, size, free, same = {}) {
    const handle = await fs.promises.open(file, 'r');
    await doc.revisions.push({ file, handle, size, owned: true, refs: 0, ...same },Math.min(Math.max(MIN_BUDGET, 4 * doc.originalSize), free / 2));
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

  // A file picked or dropped to be inserted into a document. The page gets an id for it and never the path; a list of changes names the
  // file by that id. Only the newest ones are kept.
  function addSource(file, kind) {
    const id = crypto.randomBytes(16).toString('hex');
    sources.set(id, { file, kind, password: null });
    if (sources.size > MAX_SOURCES) forgetSources([sources.keys().next().value]);
    return id;
  }

  function forgetSources(ids) {
    for (const id of ids) {
      sources.get(id)?.password?.fill(0);
      sources.delete(id);
    }
  }

  // Resolves whether the password opens the PDF behind the id, and keeps it in memory for the next list of changes that names it.
  async function unlockSource(id, password) {
    const source = typeof id === 'string' ? sources.get(id) : null;
    if (!source) throw new Error('unknown file');
    const secret = passwordBuffer(password);
    const right = await checkPassword(source.file, secret).catch(() => false);
    if (!right) { secret.fill(0); return false; }
    source.password?.fill(0);
    source.password = secret;
    return true;
  }

  // The total size of the files named by these ids, which must all still be there.
  async function sourceBytes(ids) {
    const files = ids.map((id) => sources.get(id)?.file);
    if (files.includes(undefined)) throw new Error('A file to insert is no longer available.');
    return (await Promise.all(files.map((file) => fs.promises.stat(file).then((stat) => stat.size)))).reduce((sum, size) => sum + size, 0);
  }

  const withFiles = (op) => (op.sources ? { ...op, sources: op.sources.map((id) => ({ id, file: sources.get(id).file, kind: sources.get(id).kind })) } : op);

  const sourceSecrets = (token, ids) => {
    const locked = Object.fromEntries(ids.filter((id) => sources.get(id)?.password).map((id) => [id, sources.get(id).password.toString('utf8')]));
    return Object.keys(locked).length ? { ...secretsOf(token), sources: locked } : secretsOf(token);
  };

  // A checked list of changes that the PDF engine makes to the revision on show; the result is the next revision. The helper reads and
  // writes only files in the session folder, and the password reaches it on its standard input. Closing the document stops it. Throws
  // for a list that is not allowed; otherwise resolves like putRevision, and rejects with the helper's reason when it fails.
  function apply(token, ops) {
    const doc = get(token);
    const list = check(ops);
    if (list.some((op) => OPS[op.op].kind === 'output')) throw new Error('that change makes a new file');
    const taken = list.flatMap((op) => op.sources ?? []);
    return serial(doc, async () => {
      const room = await prepare(doc, 2 * doc.revisions.current().size + (await sourceBytes(taken)) + FREE_MARGIN);
      if (room.stop) return room;
      const from = doc.revisions.current();
      const source = from.file;
      const metaOnly = list.every((op) => op.op === 'meta.set');
      const pagesOnly = list.every((op) => op.op.startsWith('pages.'));
      const out = path.join(doc.session, `revision-${++doc.count}.pdf`);
      const listFile = path.join(doc.session, `ops-${doc.count}.json`);
      try {
        await fs.promises.writeFile(listFile, JSON.stringify({ version: 1, ops: list.map(withFiles) }));
        const said = await runPdfTool('pdf_edit.py', [source, out, listFile], { src: source, signal: doc.stop.signal, secrets: sourceSecrets(token, taken) });
        const count = Number(/"pages": (\d+)/.exec(said)?.[1]);
        const added = JSON.parse(/"added": (\[[\d, ]*\])/.exec(said)?.[1] ?? '[]');
        const lineage = { base: from.base ?? from, layout: from.layout };
        let kin = {};
        if (metaOnly) kin = { ...lineage, meta: metaOf(list.at(-1)) };
        else if (pagesOnly && count > 0 && count <= MAX_TRACKED_PAGES) kin = { ...lineage, metaFrom: from, layout: arrange(from.layout, count, list, added) };
        const made = await adopt(doc, out, (await fs.promises.stat(out)).size, room.free, kin);
        return { ...made, reload: !(metaOnly && /"saved": "incremental"/.test(said)) };
      } catch (e) {
        await fs.promises.rm(out, { force: true });
        throw e;
      } finally {
        forgetSources(taken);
        await fs.promises.rm(listFile, { force: true });
      }
    });
  }

  // Writes what a change of kind `output` makes from the revision on show as a new PDF at `target`, leaving the document and its revisions
  // as they are. Resolves { done } or { stop } like saveCopy, and rejects with the helper's reason when it fails. Runs inside the document's turn.
  async function writeOutput(doc, token, change, target) {
    const taken = change.sources ?? [];
    const source = doc.revisions.current();
    const free = await freeBytes(os.tmpdir());
    if (free < source.size + (await sourceBytes(taken)) + FREE_MARGIN) return stopped(doc, 'no-space', os.tmpdir());
    const there = await fileIdentity(target).catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
    return withTempFile('pdf', (out) => withTempFile('json', async (listFile) => {
      await fs.promises.writeFile(listFile, JSON.stringify({ version: 1, ops: [withFiles(change)] }));
      await runPdfTool('pdf_edit.py', [source.file, out, listFile], { src: source.file, signal: doc.stop.signal, secrets: sourceSecrets(token, taken) });
      const result = await replaceFile(out, target, there);
      return result.stop ? stopped(doc, result.stop, target) : { done: true };
    }));
  }

  const extract = (token, pages, target) => {
    const [change] = check([{ op: 'pages.extract', pages }]);
    const doc = get(token);
    return serial(doc, () => writeOutput(doc, token, change, target));
  };

  // The document and the files named by id (in the order given, the document after the first `at` of them) as one new PDF at `target`.
  function merge(token, ids, at, target) {
    const [change] = check([{ op: 'pages.merge', sources: ids, at }]);
    const doc = get(token);
    return serial(doc, async () => {
      try {
        return await writeOutput(doc, token, change, target);
      } finally {
        forgetSources(ids);
      }
    });
  }

  // Each list of pages as a new PDF, in one turn so they all come from the same revision. `nameFor(pages)` gives the path of the next
  // one. Resolves { done, files } or the { stop } that ended it; the files made before it stay.
  function split(token, parts, nameFor) {
    const changes = parts.map((pages) => check([{ op: 'pages.extract', pages }])[0]);
    const doc = get(token);
    return serial(doc, async () => {
      const files = [];
      for (const change of changes) {
        const target = nameFor(change.pages);
        const result = await writeOutput(doc, token, change, target);
        if (!result.done) return result;
        files.push(target);
      }
      return { done: true, files };
    });
  }

  // What the PDF engine reports about the revision on show: a helper run on that file, kept until the revision changes. An unchanged
  // document has no copy yet, so the helper reads the file itself, which keeps Pomelo's own rename and save waiting its turn.
  function facts(token) {
    const doc = get(token);
    return serial(doc, async () => {
      const rev = doc.revisions.current();
      if (doc.facts?.rev !== rev) {
        const data = await withTempFile('json', async (out) => {
          await runPdfTool('pdf_info.py', [rev.file, out, 'properties'], { src: rev.file, signal: doc.stop.signal, secrets: secretsOf(token) });
          return JSON.parse(await fs.promises.readFile(out, 'utf8'));
        });
        if (data.information) for (let r = rev; r; r = r.metaFrom) r.meta ??= metaOf(data.information);
        doc.facts = { rev, data };
      }
      return doc.facts.data;
    });
  }

  // Where the file is, as the last two folders, and when it was last changed on disk. The page never gets a path.
  async function details(token) {
    const doc = get(token);
    const folders = path.dirname(doc.file).split(path.sep).filter(Boolean);
    const stat = await fs.promises.stat(doc.file).catch(() => null);
    return { folders: folders.slice(-2), modified: stat ? stat.mtimeMs : null };
  }

  // Renames the file on disk, keeping its extension. `name` is the new name without it. Resolves { info } or { stop }: 'invalid',
  // 'open' (another tab has that file), 'exists' (a file is there already), 'in-use' (Windows would not) or 'changed'. A file is never replaced.
  function rename(token, name) {
    const doc = get(token);
    const base = typeof name === 'string' ? name.trim() : '';
    if (badName(base)) return Promise.resolve({ stop: 'invalid' });
    const target = path.join(path.dirname(doc.file), base + path.extname(doc.file));
    const key = keyOf(target);
    if (target === doc.file) return Promise.resolve({ info: info(doc) });
    if ([...byToken.values()].some((other) => other !== doc && other.key === key)) return Promise.resolve({ stop: 'open' });
    return serial(doc, async () => {
      if (key !== doc.key && (await fs.promises.lstat(target).then(() => true, () => false))) return { stop: 'exists' };
      try {
        await fs.promises.rename(doc.file, target);
      } catch (e) {
        if (e.code === 'ENOENT') return CHANGED;
        if (IN_USE.has(e.code)) return { stop: 'in-use' };
        throw e;
      }
      if (!doc.session) doc.revisions.current().file = target;
      doc.file = target;
      doc.name = path.basename(target);
      doc.key = key;
      return { info: info(doc) };
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
  const secretsOf = (token) => { const secret = passwords.get(token); return secret && { password: secret.toString('utf8') }; };
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
    forgetSources([...sources.keys()]);
    return Promise.all(ending);
  }

  const served = () => [...byToken.values()].reduce((sum, doc) => sum + doc.served, 0);

  return { open, find, list, read, unlock, password, fileOf, putRevision, apply, addSource, unlockSource, extract, merge, split, facts, details, rename, undo, redo, save, saveCopy, reload, close, closeAll, served };
}

const sweepSessions = () => sweepTempDirs(SESSION_TAG, 24 * 3600 * 1000);

module.exports = { createDocuments, sweepSessions, MAX_SPAN, NO_ENGINE_SAVE_LIMIT };

// SPDX-License-Identifier: AGPL-3.0-or-later
// The PDFs the workspace has open. Each is read through one handle held from the moment it was opened, so the page gets bytes by
// range and never a path, and a file replaced on disk by another program cannot mix two versions into one view. No Electron in here.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { passwordBuffer } = require('#shared/node/secrets');

const MAX_SPAN = 4 * 1048576;

const info = ({ token, name, size }) => ({ token, name, size });
const keyOf = (file) => path.resolve(file).toLowerCase();

function createDocuments() {
  const byToken = new Map();
  const passwords = new Map();

  // Windows paths are not case-sensitive, so two spellings of one file are one document.
  const find = (file) => { const doc = [...byToken.values()].find((d) => d.key === keyOf(file)); return doc ? info(doc) : null; };
  const list = () => [...byToken.values()].map(info);

  async function open(file) {
    const handle = await fs.promises.open(file, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOTFILE' });
      const doc = { token: crypto.randomBytes(32).toString('hex'), name: path.basename(file), size: stat.size, handle, served: 0, key: keyOf(file) };
      byToken.set(doc.token, doc);
      return info(doc);
    } catch (e) {
      await handle.close();
      throw e;
    }
  }

  async function read(token, begin, end) {
    const doc = typeof token === 'string' ? byToken.get(token) : null;
    if (!doc) throw new Error('unknown document');
    if (!Number.isInteger(begin) || !Number.isInteger(end) || begin < 0 || end <= begin || end > doc.size || end - begin > MAX_SPAN) throw new Error('bad range');
    const buffer = Buffer.allocUnsafe(end - begin);
    const { bytesRead } = await doc.handle.read(buffer, 0, buffer.length, begin);
    if (bytesRead !== buffer.length) throw new Error('the file changed while it was open');
    doc.served += bytesRead;
    return buffer;
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

  function close(token) {
    const doc = byToken.get(token);
    if (!doc) return;
    doc.handle.close().catch(() => {});
    byToken.delete(token);
    passwords.get(token)?.fill(0);
    passwords.delete(token);
  }

  function closeAll() {
    for (const doc of byToken.values()) doc.handle.close().catch(() => {});
    byToken.clear();
    for (const secret of passwords.values()) secret.fill(0);
    passwords.clear();
  }

  const served = () => [...byToken.values()].reduce((sum, doc) => sum + doc.served, 0);

  return { open, find, list, read, unlock, password, close, closeAll, served };
}

module.exports = { createDocuments, MAX_SPAN };

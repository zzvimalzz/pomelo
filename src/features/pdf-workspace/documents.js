// SPDX-License-Identifier: AGPL-3.0-or-later
// The PDFs the workspace has open. Each is read through one handle held from the moment it was opened, so the page gets bytes by
// range and never a path, and a file replaced on disk by another program cannot mix two versions into one view. No Electron in here.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { passwordBuffer } = require('#shared/node/secrets');

const MAX_SPAN = 4 * 1048576;

function createDocuments() {
  const byToken = new Map();
  const passwords = new Map();

  async function open(file) {
    const handle = await fs.promises.open(file, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOTFILE' });
      const doc = { token: crypto.randomBytes(32).toString('hex'), name: path.basename(file), size: stat.size, handle, served: 0 };
      byToken.set(doc.token, doc);
      return { token: doc.token, name: doc.name, size: doc.size };
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

  function closeAll() {
    for (const doc of byToken.values()) doc.handle.close().catch(() => {});
    byToken.clear();
    for (const secret of passwords.values()) secret.fill(0);
    passwords.clear();
  }

  const served = () => [...byToken.values()].reduce((sum, doc) => sum + doc.served, 0);

  return { open, read, unlock, password, closeAll, served };
}

module.exports = { createDocuments, MAX_SPAN };

// SPDX-License-Identifier: AGPL-3.0-or-later
// A one-page PDF with a black box on it, encrypted with the standard security handler (40-bit RC4) under a user password, for the
// tests that open protected files. pdf-lib cannot write encryption, so the file is assembled by hand.
const crypto = require('crypto');

const PAD = Buffer.from('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A', 'hex');
const md5 = (...parts) => crypto.createHash('md5').update(Buffer.concat(parts)).digest();
const padded = (text) => Buffer.concat([Buffer.from(text, 'latin1'), PAD]).subarray(0, 32);

function rc4(key, data) {
  const s = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; [s[i], s[j]] = [s[j], s[i]]; }
  const out = Buffer.alloc(data.length);
  for (let n = 0, a = 0, b = 0; n < data.length; n++) { a = (a + 1) & 255; b = (b + s[a]) & 255; [s[a], s[b]] = [s[b], s[a]]; out[n] = data[n] ^ s[(s[a] + s[b]) & 255]; }
  return out;
}

function encryptedPdf(password) {
  const id = crypto.randomBytes(16);
  const owner = rc4(md5(padded(crypto.randomBytes(8).toString('hex'))).subarray(0, 5), padded(password));
  const permissions = Buffer.alloc(4);
  permissions.writeInt32LE(-4);
  const key = md5(padded(password), owner, permissions, id).subarray(0, 5);
  const user = rc4(key, PAD);
  const content = rc4(md5(key, Buffer.from([5, 0, 0, 0, 0])).subarray(0, 10), Buffer.from('0 g 40 40 220 120 re f'));

  const parts = [];
  const offsets = [];
  let size = 0;
  const add = (...bufs) => { for (const b of bufs) { const buf = Buffer.from(b); parts.push(buf); size += buf.length; } };
  const object = (n, ...body) => { offsets[n] = size; add(`${n} 0 obj\n`, ...body, '\nendobj\n'); };
  add('%PDF-1.4\n');
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  object(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 5 0 R >>');
  object(4, `<< /Filter /Standard /V 1 /R 2 /P -4 /O <${owner.toString('hex')}> /U <${user.toString('hex')}> >>`);
  object(5, `<< /Length ${content.length} >>\nstream\n`, content, '\nendstream');
  const xref = size;
  add('xref\n0 6\n0000000000 65535 f \n', ...offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`));
  add(`trailer\n<< /Size 6 /Root 1 0 R /Encrypt 4 0 R /ID [<${id.toString('hex')}><${id.toString('hex')}>] >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

module.exports = { encryptedPdf };

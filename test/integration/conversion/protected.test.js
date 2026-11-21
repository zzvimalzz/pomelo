// SPDX-License-Identifier: AGPL-3.0-or-later
// Files that need a password, with the real programs: how they are recognised, which passwords open them, and that a conversion with
// the password makes the same file as one without. The protected files are made here with 7-Zip, msoffcrypto-tool and a hand-built PDF.
// Needs the PDF engine for PDF and Office files (skipped without it).   node test/integration/conversion/protected.test.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const conversion = require('../../../src/features/conversion');
const { encryptedPdf } = require('../../support/encrypted-pdf');
const { expect } = require('../../support/expect');
const finish = require('../../support/finish');
const tmp = require('../../support/tmp');

const PASSWORD = 'Sw0rdfish';
const secret = (text = PASSWORD) => Buffer.from(text);

(async () => {
  const engines = conversion.detectEngines();
  const dir = tmp.dir('protected');
  const f = (n) => path.join(dir, n);
  const { Document, Packer, Paragraph } = require('docx');
  fs.writeFileSync(f('plain.docx'), await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('Protected text')] }] })));
  fs.writeFileSync(f('note.txt'), 'Protected text');

  const sevenZip = (type, name) => execFileSync(engines.sevenZip, ['a', `-t${type}`, '-p', f(name), f('note.txt')], { input: `${PASSWORD}\n`, stdio: ['pipe', 'ignore', 'ignore'] });
  if (engines.sevenZip) {
    console.log('zip and 7z');
    sevenZip('zip', 'locked.zip');
    sevenZip('7z', 'locked.7z');
    execFileSync(engines.sevenZip, ['a', '-tzip', f('open.zip'), f('note.txt')], { stdio: 'ignore' });
    expect('a protected zip and 7z are recognised, an ordinary zip is not', (await conversion.probeLocked(f('locked.zip'))) === 'needed' && (await conversion.probeLocked(f('locked.7z'))) === 'needed' && (await conversion.probeLocked(f('open.zip'))) === null);
    for (const name of ['locked.zip', 'locked.7z']) {
      expect(`${name}: the right password opens it, a wrong one does not`, (await conversion.checkPassword(f(name), secret())) === true && (await conversion.checkPassword(f(name), secret('wrong'))) === false);
    }
    const accented = await conversion.checkPassword(f('locked.zip'), secret('pässwörd')).catch((e) => e);
    expect('a password with accents is refused with the reason, not tried', accented.kind === 'ascii' && /accented/.test(accented.message), accented.message);
    const outDir = path.join(dir, 'out');
    fs.mkdirSync(outDir);
    const [folder] = await conversion.convertFile(f('locked.zip'), 'folder', { outDir, password: secret() });
    expect('a protected zip extracts with its password', fs.readFileSync(path.join(folder, 'note.txt'), 'utf8') === 'Protected text');
    const [packed] = await conversion.convertFile(f('locked.7z'), 'zip', { outDir, password: secret() });
    expect('and converts to another archive', fs.existsSync(packed));
    const started = Date.now();
    const noPassword = await conversion.convertFile(f('locked.zip'), 'folder', { outDir }).catch((e) => e);
    expect('without a password it fails at once with a plain message, and does not wait at 7-Zip\'s prompt', noPassword.name === 'PasswordError' && noPassword.kind === 'needed' && Date.now() - started < 10000, `${noPassword.message} after ${Date.now() - started} ms`);
    const wrong = await conversion.convertFile(f('locked.7z'), 'folder', { outDir, password: secret('Zq9-needle') }).catch((e) => e);
    expect('with a wrong password it says so, and the password is not in the message', wrong.kind === 'wrong' && !wrong.message.includes('Zq9-needle'), wrong.message);
  } else console.log('  7-Zip not found: archives skipped');

  if (!engines.unlock) { console.log('PDF engine (with msoffcrypto-tool) not installed: PDF and Office files skipped'); finish(); return; }

  console.log('Office files');
  execFileSync(engines.unlock, ['-c', 'import sys, msoffcrypto\nwith open(sys.argv[1], "rb") as src, open(sys.argv[2], "wb") as dst:\n    msoffcrypto.OfficeFile(src).encrypt(sys.argv[3], dst)', f('plain.docx'), f('locked.docx'), PASSWORD]);
  expect('an encrypted docx is recognised, an ordinary one is not', (await conversion.probeLocked(f('locked.docx'))) === 'needed' && (await conversion.probeLocked(f('plain.docx'))) === null);
  expect('the right password opens it and a wrong one does not', (await conversion.checkPassword(f('locked.docx'), secret())) === true && (await conversion.checkPassword(f('locked.docx'), secret('wrong'))) === false);
  const before = fs.readdirSync(require('os').tmpdir()).filter((n) => n.startsWith('pomelo-')).length;
  const [text] = await conversion.convertFile(f('locked.docx'), 'txt', { outDir: dir, password: secret() });
  expect('it converts with the password, to the same text as the file without one', fs.readFileSync(text, 'utf8').includes('Protected text'));
  expect('the decrypted copy is gone afterwards', fs.readdirSync(require('os').tmpdir()).filter((n) => n.startsWith('pomelo-')).length <= before);

  console.log('PDF files');
  fs.writeFileSync(f('locked.pdf'), encryptedPdf(PASSWORD));
  expect('a PDF with a user password is recognised', (await conversion.probeLocked(f('locked.pdf'))) === 'needed');
  expect('the right password opens it and a wrong one does not', (await conversion.checkPassword(f('locked.pdf'), secret())) === true && (await conversion.checkPassword(f('locked.pdf'), secret('wrong'))) === false);
  const [png] = await conversion.convertFile(f('locked.pdf'), 'png', { outDir: dir, password: secret() });
  expect('it converts with the password', fs.statSync(png).size > 0);
  const refused = await conversion.convertFile(f('locked.pdf'), 'png', { outDir: dir }).catch((e) => e);
  expect('without one the reader says the file is protected', refused.name === 'PasswordError', refused.message);

  finish();
})();

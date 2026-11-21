// SPDX-License-Identifier: AGPL-3.0-or-later
// Files that need a password: telling that one does (probe), checking a password (verify), and writing a copy that has none (unlock).
// PDF and Office files are opened by python/unlock.py, zip and 7z by 7-Zip. The password reaches the program on its standard input.
const fs = require('fs');
const { PasswordError } = require('./context');
const { runHelper } = require('./python');
const { sevenZip } = require('./seven-zip');

const OOXML = new Set(['docx', 'xlsx', 'pptx']);
const OLE = new Set(['doc', 'xls', 'ppt']);
const OLE_MAGIC = Buffer.from('D0CF11E0', 'hex');
const PROBE_LIMIT_MS = 4000;

// Formats that are opened from a decrypted copy (an archive takes its password directly).
const unlocksToCopy = (from) => from === 'pdf' || OOXML.has(from) || OLE.has(from);

const readAt = (fd, size, pos, len) => {
  const buf = Buffer.alloc(Math.min(len, size - pos));
  fs.readSync(fd, buf, 0, buf.length, pos);
  return buf;
};

// An encrypted PDF names /Encrypt in its trailer, which sits at the end (or, in a linearized file, at the start).
function mentionsEncrypt(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    return readAt(fd, size, 0, 1024).includes('/Encrypt') || readAt(fd, size, Math.max(0, size - 65536), 65536).includes('/Encrypt');
  } finally { fs.closeSync(fd); }
}

// An owner-only password lets everyone read the file, so only pdf.js asking for a password counts.
async function pdfNeedsPassword(file) {
  if (!mentionsEncrypt(file)) return false;
  try { (await require('../lib/pdfjs').openPdf(file)).release(); return false; } catch (e) { if (e instanceof PasswordError) return true; throw e; }
}

function startsWith(file, magic) {
  const fd = fs.openSync(file, 'r');
  try { return readAt(fd, magic.length, 0, magic.length).equals(magic); } finally { fs.closeSync(fd); }
}

async function oleNeedsPassword(file, engines) {
  return /LOCKED/.test(await runHelper(engines.unlock, 'unlock.py', ['probe', file], { timeout: 30000 }));
}

async function odfNeedsPassword(file) {
  const zip = await require('jszip').loadAsync(fs.readFileSync(file));
  return /encryption-data/.test(await zip.file('META-INF/manifest.xml')?.async('string') || '');
}

async function archiveNeedsPassword(file, engines) {
  if (!engines.sevenZip) return false;
  try { return /^Encrypted = \+/m.test(await sevenZip(engines.sevenZip, ['l', '-slt', '-spd', file], { timeout: 30000 })); } catch (e) { return e instanceof PasswordError; }
}

async function kindOf(file, from, engines) {
  const opens = (needed) => (needed ? (engines.unlock ? 'needed' : 'engine') : null);
  if (from === 'pdf') return opens(await pdfNeedsPassword(file));
  if (OOXML.has(from)) return startsWith(file, OLE_MAGIC) ? (engines.unlock ? opens(await oleNeedsPassword(file, engines)) : 'engine') : null;
  if (OLE.has(from)) return engines.unlock && await oleNeedsPassword(file, engines) ? 'needed' : null;
  if (from === 'odt' || from === 'ods') return await odfNeedsPassword(file) ? 'unsupported' : null;
  if (from === 'zip' || from === '7z') return await archiveNeedsPassword(file, engines) ? 'needed' : null;
  return null;
}

// Resolves 'needed' | 'unsupported' | 'engine' for a file that cannot be opened as it is, or null. Never rejects: a file this cannot
// read is left for the conversion, which says what is wrong with it.
async function probe(file, from, engines) {
  let timer;
  const limit = new Promise((resolve) => { timer = setTimeout(resolve, PROBE_LIMIT_MS, null); timer.unref?.(); });
  try { return await Promise.race([kindOf(file, from, engines), limit]); } catch { return null; } finally { clearTimeout(timer); }
}

// The helper's own words for "wrong" and "not installed" become the typed error; anything else is the file's problem.
function asPasswordError(e) {
  if (/POMELO_LOCK wrong/.test(e.message)) return new PasswordError('wrong');
  if (/is not available/.test(e.message)) return new PasswordError('engine');
  return e;
}

const helperLock = (engines, file, password, extra = []) => runHelper(engines.unlock, 'unlock.py', ['open', file, ...extra], { input: Buffer.concat([password, Buffer.from('\n')]), timeout: 120000 }).catch((e) => { throw asPasswordError(e); });

// The smallest encrypted file inside the listing `7za l -slt` printed, so one short read tells whether the password fits.
function smallestEncrypted(listing) {
  const entries = listing.split(/\r?\n\r?\n/).filter((b) => /^Encrypted = \+/m.test(b) && !/^Folder = \+/m.test(b)).map((b) => ({ name: /^Path = (.*)$/m.exec(b)?.[1], size: +(/^Size = (\d+)/m.exec(b)?.[1] || 0) }));
  return entries.filter((e) => e.name).sort((a, b) => a.size - b.size)[0]?.name;
}

// Resolves whether `password` opens the file. Rejects for anything that is not a plain right or wrong: a missing engine, a protection
// that cannot be opened, a damaged file.
async function verify(file, from, password, engines) {
  try {
    if (unlocksToCopy(from)) await helperLock(engines, file, password);
    else {
      const exe = engines.sevenZip;
      const name = smallestEncrypted(await sevenZip(exe, ['l', '-slt', '-spd', file], { password, timeout: 60000 }));
      if (name) await sevenZip(exe, ['t', '-spd', '--', file, name], { password, timeout: 600000 });
    }
    return true;
  } catch (e) {
    if (e instanceof PasswordError && e.kind === 'wrong') return false;
    throw e;
  }
}

const unlock = (file, password, copy, engines) => helperLock(engines, file, password, [copy]);

module.exports = { probe, verify, unlock, unlocksToCopy };

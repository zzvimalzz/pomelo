// SPDX-License-Identifier: AGPL-3.0-or-later
// File helpers shared by every part of the app: temp paths that clean up after themselves, text decoding, folder sizes and removal,
// and replacing a file the way Windows allows.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runStatus } = require('./process');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const RUN_ID = 'a0404922af06c3bcb51ce919768e87f2eb352326a6aec8a0193d696c10ca2c02';

function tempPath(ext) {
  return path.join(os.tmpdir(), `pomelo-${RUN_ID.slice(0, 8)}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
}

// Runs fn(file) with a fresh temp file path and deletes the file afterwards, whether or not fn created it or threw.
async function withTempFile(ext, fn) {
  const file = tempPath(ext);
  try { return await fn(file); } finally { fs.rmSync(file, { force: true }); }
}

// Runs fn(dir) with a fresh empty temp folder and deletes it afterwards.
async function withTempDir(fn) {
  const dir = tempPath('d');
  fs.mkdirSync(dir);
  try { return await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// A folder that stays until the caller removes it, for work that outlives one function call. The tag ends the name so
// sweepTempDirs can find the folders of one kind that an earlier run left behind.
function makeTempDir(tag) {
  const dir = tempPath(`${tag}.d`);
  fs.mkdirSync(dir);
  return dir;
}

// Removes the folders makeTempDir(tag) made that were last changed more than maxAgeMs ago. A folder that is still in use
// by another running copy is young, or is skipped when Windows will not let go of it.
function sweepTempDirs(tag, maxAgeMs) {
  const prefix = `pomelo-${RUN_ID.slice(0, 8)}-`;
  const suffix = `.${tag}.d`;
  const root = os.tmpdir();
  let names;
  try { names = fs.readdirSync(root); } catch { return; }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
    const dir = path.join(root, name);
    try {
      if (Date.now() - fs.statSync(dir).mtimeMs > maxAgeMs) fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* in use, or gone already */ }
  }
}

// Text file -> string: handles UTF-8/UTF-16 BOMs, and falls back to Windows-1252 for legacy files.
function readText(file) {
  const b = fs.readFileSync(file);
  if (b[0] === 0xff && b[1] === 0xfe) return b.slice(2).toString('utf16le');
  if (b[0] === 0xfe && b[1] === 0xff) return Buffer.from(b.slice(2)).swap16().toString('utf16le');
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.slice(3).toString('utf8');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { return new TextDecoder('windows-1252').decode(b); }
}

function dirBytes(dir) {
  let total = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      total += e.isDirectory() ? dirBytes(p) : fs.statSync(p).size;
    }
  } catch { /* still being written */ }
  return total;
}

// Windows can hold a folder for a moment after it is emptied (the virus scanner, the search indexer), so remove it, check
// that it is really gone, and try again for a few seconds if not. Resolves whether it is gone.
async function removeDirReliably(dir) {
  for (let attempt = 0; attempt < 14; attempt++) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* try again below */ }
    if (!fs.existsSync(dir)) return true;
    await sleep(500);
  }
  return false;
}

// Which file a path is now, as far as Windows can say: the NTFS file index, the size and the time of the last change.
async function fileIdentity(file) {
  const st = await fs.promises.stat(file, { bigint: true });
  return { ino: String(st.ino), size: Number(st.size), mtimeMs: Number(st.mtimeMs) };
}

const sameFile = (a, b) => a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
// The paths travel in the environment, never in the command text. Exit 3 is a sharing violation, which is worth another try.
const REPLACE = "try { [IO.File]::Replace($env:POMELO_FROM, $env:POMELO_TO, [NullString]::Value) } catch [IO.IOException] { exit 3 } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }";
const RETRY_MS = [50, 100, 200];
const FREE_MARGIN = 64 * 1048576;

// Puts the bytes of src where target is. `expected` is the identity target had when the caller last looked, or null when nothing
// may be there yet. Resolves { identity } of the new file, or { stop } with why nothing was changed: 'changed' (another program
// replaced target, or made it), 'read-only', 'no-space' or 'locked' (another program holds target open without letting go of it).
// A rename over the target fails with EPERM while any handle on it is open, Pomelo's own included, so an existing target goes
// through ReplaceFileW, which also keeps its permissions, creation time and Zone.Identifier stream.
async function replaceFile(src, target, expected) {
  let now = null;
  try { now = await fileIdentity(target); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (expected ? !now || !sameFile(now, expected) : now) return { stop: 'changed' };
  if (now) { try { await fs.promises.access(target, fs.constants.W_OK); } catch { return { stop: 'read-only' }; } }
  const size = (await fs.promises.stat(src)).size;
  const free = await fs.promises.statfs(path.dirname(target));
  if (free.bavail * free.bsize < size + FREE_MARGIN) return { stop: 'no-space' };

  const temp = path.join(path.dirname(target), `.${path.basename(target)}.pomelo-${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    await fs.promises.copyFile(src, temp, fs.constants.COPYFILE_EXCL);
    const handle = await fs.promises.open(temp, 'r+');
    try {
      await handle.sync();
      const tail = Buffer.alloc(Math.min(size, 1024));
      await handle.read(tail, 0, tail.length, size - tail.length);
      if ((await handle.stat()).size !== size || !tail.includes('%%EOF')) throw new Error('The copy to save is incomplete');
    } finally { await handle.close(); }
    if (!now) await fs.promises.rename(temp, target);
    else {
      for (let attempt = 0; ; attempt++) {
        const { code, out } = await runStatus(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', REPLACE], { env: { POMELO_FROM: temp, POMELO_TO: target } });
        if (code === 0) break;
        if (code !== 3) throw new Error(out.trim() || 'Windows would not replace the file');
        if (attempt === RETRY_MS.length) return { stop: 'locked' };
        await sleep(RETRY_MS[attempt]);
      }
    }
    return { identity: await fileIdentity(target) };
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

module.exports = { sleep, withTempFile, withTempDir, makeTempDir, sweepTempDirs, readText, dirBytes, removeDirReliably, fileIdentity, sameFile, replaceFile };

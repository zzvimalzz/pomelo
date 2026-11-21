// SPDX-License-Identifier: AGPL-3.0-or-later
// File helpers shared by every part of the app: temp paths that clean up after themselves, text decoding, folder sizes and removal.
const fs = require('fs');
const os = require('os');
const path = require('path');

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

module.exports = { sleep, withTempFile, withTempDir, makeTempDir, sweepTempDirs, readText, dirBytes, removeDirReliably };

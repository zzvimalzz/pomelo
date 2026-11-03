// SPDX-License-Identifier: AGPL-3.0-or-later
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { execFile, execFileSync } = require('child_process');

// Each conversion runs inside a context { signal, outputs }: a cancel signal that every helper process started
// during it listens to, and the list of output paths it has chosen so far (so a cancelled or failed attempt can
// delete what it left behind). It travels through async calls on its own, so engines need no extra parameters.
const context = new AsyncLocalStorage();
const withContext = (ctx, fn) => context.run(ctx, fn);
const currentContext = () => context.getStore();

class CancelledError extends Error {
  constructor() { super('Cancelled'); this.name = 'CancelledError'; }
}

// dir/base.ext, or dir/base (1).ext if that exists. Never overwrites.
function uniquePath(dir, base, ext) {
  const dot = ext ? '.' + ext : '';
  let candidate = path.join(dir, base + dot);
  for (let n = 1; fs.existsSync(candidate); n++) candidate = path.join(dir, `${base} (${n})${dot}`);
  context.getStore()?.outputs.push(candidate);
  return candidate;
}

function tempPath(ext) {
  return path.join(os.tmpdir(), `pomelo-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
}

// Text file -> string: handles UTF-8/UTF-16 BOMs, and falls back to Windows-1252 for legacy files.
function readText(file) {
  const b = fs.readFileSync(file);
  if (b[0] === 0xff && b[1] === 0xfe) return b.slice(2).toString('utf16le');
  if (b[0] === 0xfe && b[1] === 0xff) return Buffer.from(b.slice(2)).swap16().toString('utf16le');
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.slice(3).toString('utf8');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { return new TextDecoder('windows-1252').decode(b); }
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Every helper process we start, so quitting Pomelo mid-conversion does not leave LibreOffice, FFmpeg
// or Python running in the background.
const children = new Set();
function track(child) {
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

// Kill a helper and everything it started (soffice.exe starts soffice.bin).
const killTree = (child) => execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});

function killAll() {
  for (const child of children) {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* already gone */ }
  }
  children.clear();
}

// Kill `child` if the current conversion is cancelled. Returns a function that stops listening.
function killOnCancel(child) {
  const signal = context.getStore()?.signal;
  if (!signal) return () => {};
  if (signal.aborted) { killTree(child); return () => {}; }
  const onAbort = () => killTree(child);
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

// Delete paths a conversion chose but did not finish (files or folders).
function removeOutputs(paths) {
  for (const p of paths) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ } }
}

// Run a program, resolve with its stdout. env: extra environment variables for the child.
function run(cmd, args, { timeout = 180000, cwd, env } = {}) {
  if (context.getStore()?.signal?.aborted) return Promise.reject(new CancelledError());
  return new Promise((resolve, reject) => {
    let stop = () => {};
    const child = execFile(cmd, args, { windowsHide: true, timeout, cwd, env: env && { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      stop();
      if (err) {
        if (context.getStore()?.signal?.aborted) return reject(new CancelledError());
        // pdf2docx and friends log progress to stderr; report the last real line instead of the first chatter
        const lines = (stderr || stdout || err.message || '').toString().split('\n').map((l) => l.trim())
          .filter((l) => l && !/^\[(INFO|WARNING)\]/.test(l));
        const msg = lines[lines.length - 1] || err.message;
        return reject(new Error(msg));
      }
      resolve(stdout.toString());
    });
    track(child);
    stop = killOnCancel(child);
    child.on('error', reject);
  });
}

module.exports = { uniquePath, tempPath, esc, run, readText, track, killAll, withContext, currentContext, killOnCancel, removeOutputs, CancelledError };

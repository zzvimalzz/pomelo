// SPDX-License-Identifier: AGPL-3.0-or-later
// Running helper programs. Two runners, because their results mean different things:
//   runCapture  resolves with stdout and rejects with the program's last meaningful line when it fails
//   runStatus   never throws; resolves { code, out } so the caller decides what a failure means
// Every child is tracked, so quitting Pomelo in the middle of a job does not leave LibreOffice, FFmpeg or Python running.
const { execFile, execFileSync, spawn } = require('child_process');

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

// Kill `child` when `signal` aborts (at once if it already has). Returns a function that stops listening.
function killOnAbort(child, signal) {
  if (!signal) return () => {};
  if (signal.aborted) { killTree(child); return () => {}; }
  const onAbort = () => killTree(child);
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

// Calls onLine(line) for every line a stream produces as it arrives (a carriage return ends a line too, which is how
// console progress bars redraw themselves).
function watchLines(stream, onLine) {
  let rest = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    const parts = (rest + chunk).split(/\r\n|\r|\n/);
    rest = parts.pop();
    for (const line of parts) if (line) { try { onLine(line); } catch { /* a bad progress parser must never fail a conversion */ } }
  });
}

// The last line of a program's output that says something: words, not a progress bar, and not a logger's [INFO] chatter.
const lastMeaningfulLine = (text, fallback = 'unknown error') => String(text).split(/\r?\n/).map((l) => l.trim()).filter((l) => /[A-Za-z]{3}/.test(l) && !/^\[(INFO|WARNING)\]/.test(l)).pop() || fallback;

// How far a job is, from "45%" or "123 MB / 359 MB" (0..1), or undefined when the line says nothing about it.
function parsePercent(line) {
  const mb = /([\d.]+)\s*MB\s*\/\s*([\d.]+)\s*MB/i.exec(line);
  if (mb && +mb[2] > 0) return Math.min(1, +mb[1] / +mb[2]);
  const m = /(\d{1,3})\s*%/.exec(line);
  return m ? Math.min(100, +m[1]) / 100 : undefined;
}

// env: extra environment variables for the child. onLine: each output line while the program runs (progress).
// signal: an AbortSignal; aborting it kills the program and rejects (with the program's message, or at once if already aborted).
function runCapture(cmd, args, { timeout = 180000, cwd, env, onLine, signal } = {}) {
  if (signal?.aborted) return Promise.reject(new Error('Cancelled'));
  return new Promise((resolve, reject) => {
    let stop = () => {};
    const child = execFile(cmd, args, { windowsHide: true, timeout, cwd, env: env && { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      stop();
      if (err) return reject(new Error(lastMeaningfulLine(stderr || stdout || err.message, err.message)));   // pdf2docx and friends log progress to stderr
      resolve(stdout.toString());
    });
    track(child);
    stop = killOnAbort(child, signal);
    if (onLine) { watchLines(child.stdout, onLine); watchLines(child.stderr, onLine); }
    child.on('error', reject);
  });
}

// verbatim: the arguments are passed exactly as written (msiexec wants TARGETDIR="C:\a path" with its own quotes).
// onLine gets each line of output that has text or a progress bar's numbers.
function runStatus(cmd, args, { onLine, timeout = 45 * 60 * 1000, verbatim = false } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try { child = track(spawn(cmd, args, { windowsHide: true, windowsVerbatimArguments: verbatim })); } catch (e) { return resolve({ code: -1, out: e.message }); }
    const timer = setTimeout(() => child.kill(), timeout);
    const feed = (d) => {
      const text = d.toString();
      out = (out + text).slice(-8000);
      if (onLine) for (const line of text.split(/\r?\n|\r/)) if (/[A-Za-z]{3}/.test(line) || /\d\s*(%|[KMG]B)/.test(line)) onLine(line.trim());
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, out }); });
  });
}

module.exports = { track, killAll, killOnAbort, lastMeaningfulLine, parsePercent, runCapture, runStatus };

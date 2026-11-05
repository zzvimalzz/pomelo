// SPDX-License-Identifier: AGPL-3.0-or-later
// Updating from inside Pomelo: download the new installer, check it is the file the release says it is, run it quietly over
// the installed copy and start Pomelo again. Only ever reached when the user presses "Download update". No Electron in
// here, so it can be tested on its own.
//
// Safety: https only, only from GitHub (or the configured feed's own host), and the file is thrown away unless its SHA-256
// (published with the release) and its size match. A release without a published checksum is not installed from here: the
// browser download is offered instead.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { allowedUrl } = require('./url-policy');

const DIR = () => path.join(os.tmpdir(), 'pomelo-update');

// Resolves with the path of the verified installer. onProgress({ received, total, fraction }).
async function download({ url, sha256, size = 0, dir = DIR(), name = 'Pomelo-Setup-x64.exe', onProgress, signal, fetchImpl = fetch, rules }) {
  if (!allowedUrl(url, rules)) throw new Error('Refusing to download from an unexpected address');
  if (!/^[0-9a-f]{64}$/i.test(sha256 || '')) throw new Error('This release has no checksum to verify the download against');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const part = path.join(dir, `${name}.part`);
  const final = path.join(dir, name);
  const hash = crypto.createHash('sha256');
  let received = 0;
  const out = fs.createWriteStream(part);
  try {
    // GitHub sends release downloads on to its storage host: follow redirects by hand so every hop is checked before it is requested
    let res, at = url;
    for (let hops = 0; ; hops++) {
      res = await fetchImpl(at, { signal, redirect: 'manual', headers: { 'User-Agent': 'Pomelo-updater' } });
      if (res.status < 300 || res.status >= 400) break;
      const next = res.headers.get('location') && new URL(res.headers.get('location'), at).href;
      if (!next || !allowedUrl(next, rules)) throw new Error('The download was redirected to an unexpected address');
      if (hops >= 5) throw new Error('The download was redirected too many times');
      at = next;
    }
    if (!res.ok || !res.body) throw new Error(`The download server answered ${res.status}`);
    const total = Number(res.headers.get('content-length')) || size || 0;
    for await (const chunk of res.body) {
      hash.update(chunk);
      received += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      onProgress?.({ received, total, fraction: total ? Math.min(1, received / total) : 0 });
    }
    await new Promise((resolve, reject) => { out.end((e) => (e ? reject(e) : resolve())); });
    if (size && received !== size) throw new Error('The download is incomplete. Check your internet connection and try again');
    if (hash.digest('hex').toLowerCase() !== sha256.toLowerCase()) throw new Error('The download does not match its checksum, so it was not installed');
    fs.renameSync(part, final);
    return final;
  } catch (e) {
    out.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
    if (e.name === 'AbortError' || signal?.aborted) { const c = new Error('Cancelled'); c.name = 'AbortError'; throw c; }
    throw e;
  }
}

// The command line that runs the installer to completion and then starts Pomelo again:
//   start /wait "" "setup.exe" /SILENT ...   then   start "" "Pomelo.exe" --hidden --updated=<version>
// /TASKS= selects none of the optional tasks, so an update never re-creates a desktop shortcut the user removed; the
// engines page is skipped in silent mode, so engines are left as they are. The installer stops the running Pomelo itself.
// Pomelo is started again even if the installer failed, so the user is never left without it; --updated=<version> lets the
// new process tell "now on <version>" from "still on the old one".
function installCommand(installer, pomeloExe, logFile, version = '') {
  const q = (p) => `"${p}"`;
  const v = /^[\w.-]{1,32}$/.test(version) ? version : '';
  // the short ping is a pause: Pomelo has to be gone before the installer looks for it (its "stop Pomelo" step ends the
  // whole process tree of any running Pomelo.exe, and the installer must not be part of one)
  return `ping -n 3 127.0.0.1 >nul & start "" /wait ${q(installer)} /SILENT /SUPPRESSMSGBOXES /NORESTART /TASKS= ${logFile ? `/LOG=${q(logFile)}` : ''} & start "" ${q(pomeloExe)} --hidden ${v ? `--updated=${v}` : '--updated'}`;
}

// Starts it detached from this process (Pomelo exits right after, and the installer must outlive it). Returns the command.
function launch(installer, pomeloExe, { version = '', spawn = require('child_process').spawn, logFile = path.join(os.tmpdir(), 'pomelo-update.log') } = {}) {
  const cmd = installCommand(installer, pomeloExe, logFile, version);
  const child = spawn('cmd.exe', ['/d', '/s', '/c', `"${cmd}"`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
  child.unref();
  return cmd;
}

const cleanup = (dir = DIR()) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* still in use: next time */ } };

module.exports = { download, installCommand, launch, cleanup };

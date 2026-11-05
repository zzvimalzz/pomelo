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
//   start /wait "" "setup.exe" /VERYSILENT ...   then   start "" "Pomelo.exe" --hidden --updated=<version>
// /VERYSILENT keeps the installer's own window away: Pomelo's downloader has already said what is happening. /TASKS= selects
// none of the optional tasks, so an update never re-creates a desktop shortcut the user removed; the engines page is skipped
// in silent mode, so the installer leaves engines alone (Pomelo adds what the new version needs when it starts again).
// /WAITPID makes the installer wait until this Pomelo has exited before it looks for a running copy to stop: the installer
// must not still be a child of the process it stops. Nothing here may be a console program: cmd runs without a console
// (it has to outlive Pomelo), and Windows opens a visible one for any console program it starts, which is what a `ping` used as
// the pause did. Pomelo is started again even if the installer failed, so the user is never left without it; --updated=<version>
// lets the new process tell "now on <version>" from "still on the old one". `reopen` leaves out --hidden, so Settings opens
// again for someone who had it open.
function installCommand(installer, pomeloExe, logFile, version = '', { waitPid = 0, reopen = false } = {}) {
  const q = (p) => `"${p}"`;
  const v = /^[\w.-]{1,32}$/.test(version) ? version : '';
  const wait = Number.isInteger(waitPid) && waitPid > 0 ? `/WAITPID=${waitPid} ` : '';
  return `start "" /wait ${q(installer)} /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /TASKS= ${wait}${logFile ? `/LOG=${q(logFile)}` : ''} & start "" ${q(pomeloExe)} ${reopen ? '' : '--hidden '}${v ? `--updated=${v}` : '--updated'}`;
}

// Starts it detached from this process (Pomelo exits right after, and the installer must outlive it). Returns the command.
function launch(installer, pomeloExe, { version = '', reopen = false, pid = process.pid, spawn = require('child_process').spawn, logFile = path.join(os.tmpdir(), 'pomelo-update.log') } = {}) {
  const cmd = installCommand(installer, pomeloExe, logFile, version, { waitPid: pid, reopen });
  const child = spawn('cmd.exe', ['/d', '/s', '/c', `"${cmd}"`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
  child.unref();
  return cmd;
}

const cleanup = (dir = DIR()) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* still in use: next time */ } };

module.exports = { download, installCommand, launch, cleanup };

// SPDX-License-Identifier: AGPL-3.0-or-later
// Headless switches for the Windows installer and uninstaller. Pomelo.exe runs them itself, so the installer reuses the
// code behind the Settings Install buttons instead of having a second implementation. No window is shown.
//
//   Pomelo.exe --install-engines=pdf,soffice,pandoc        installs the named engines one after another
//   Pomelo.exe --uninstall-engines                         removes what Pomelo installed and switches off "Start with Windows"
//   --progress-file=<path>                                 optional: where to keep progress for the wizard (see fileProgress)
//
// Engine names are the keys in packs.js (pdf, ocr and heic come from the same install).
// Exit code 0: everything worked. 1: something failed (the message is printed and logged).
const fs = require('fs');
const { PACKS, PACK } = require('./packs');

const ascii = (s) => String(s).replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim().slice(0, 70);

// -> { action: 'install', keys, progressFile } | { action: 'uninstall', progressFile } | null when Pomelo was started normally.
function parse(argv) {
  const progressFile = (argv.find((a) => a.startsWith('--progress-file=')) || '').slice('--progress-file='.length) || null;
  for (const arg of argv) {
    if (arg === '--uninstall-engines') return { action: 'uninstall', progressFile };
    const m = /^--install-engines=(.*)$/.exec(arg);
    if (m) return { action: 'install', keys: m[1].split(',').map((k) => k.trim()).filter(Boolean), progressFile };
  }
  return null;
}

// Progress for the installer's wizard: a small key=value text file it polls. Replaced in one step on every update so it
// is never read half-written. fraction is 0..1; done=1 means the work is over and `failed` lists what did not work.
function fileProgress(file) {
  if (!file) return () => {};
  return ({ fraction, text, detail = '', done = false, failed = [] }) => {
    const lines = [`permille=${Math.round(fraction * 1000)}`, `text=${text}`, `detail=${detail}`, `done=${done ? 1 : 0}`, `failed=${failed.join(', ')}`];
    try { fs.writeFileSync(`${file}.tmp`, lines.join('\n')); fs.renameSync(`${file}.tmp`, file); } catch { /* the wizard just shows less */ }
  };
}

async function run(cmd, { installer, setLoginItem, say = console.log, progress = () => {} }) {
  if (cmd.action === 'uninstall') {
    setLoginItem(false);
    let last = 0;
    progress({ fraction: 0, text: 'Removing conversion engines' });
    const { failed } = await installer.uninstall((text, fraction) => {
      if (fraction !== undefined) last = fraction;
      say(text);
      progress({ fraction: last, text: 'Removing conversion engines', detail: ascii(text) });
    });
    failed.forEach((name) => say(`Could not remove ${name}`));
    progress({ fraction: 1, text: 'Done', done: true, failed });
    return failed.length ? 1 : 0;
  }

  const queue = [];                                    // adding PDF also adds HEIC, so a second one from the same install is skipped
  for (const key of cmd.keys) if (!PACK[key] || !queue.some((k) => PACK[k] === PACK[key])) queue.push(key);
  const weight = (key) => PACKS[PACK[key]]?.weight || 100;     // roughly how long each takes, so the bar moves evenly
  const total = queue.reduce((sum, key) => sum + weight(key), 0);

  const failed = [];
  let before = 0;
  for (const [i, key] of queue.entries()) {
    const label = PACKS[PACK[key]]?.label || key;
    let within = 0;
    const title = `Installing ${label} (${i + 1} of ${queue.length})`;
    const report = (detail) => progress({ fraction: (before + weight(key) * Math.min(within, 0.99)) / total, text: title, detail });
    report('');
    const r = await installer.install(key, (text, fraction) => {
      if (fraction !== undefined) within = fraction;
      say(text);
      report(ascii(text));
    });
    if (!r.ok) { failed.push(label); say(`${key}: ${r.message}`); }
    before += weight(key);
  }
  progress({ fraction: 1, text: 'Done', done: true, failed });
  return failed.length ? 1 : 0;
}

module.exports = { parse, run, fileProgress };

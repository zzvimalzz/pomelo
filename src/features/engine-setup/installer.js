// SPDX-License-Identifier: AGPL-3.0-or-later
// One-click install of the optional engines, and removal of exactly what Pomelo installed.
//
//   PDF engine + OCR + HEIC     a private Python environment (python-env.js). Python itself is added with winget only if the
//                               PC has none. The OCR models are fetched while it is built.
//   LibreOffice                 its official MSI, fetched with winget and unpacked into Pomelo's own folder (libreoffice.js)
//   Pandoc                      installed with winget
//
// Everything Pomelo adds is written to manifest.json, so uninstalling never touches software the user installed themselves.
// Progress is reported as note(text, fraction): fraction (0..1, optional) is how far along this engine is.
const fs = require('fs');
const path = require('path');
const { PACKS, PACK } = require('./packs');
const { createManifest } = require('./manifest');
const { installPython } = require('./python-env');
const { installLibreOffice } = require('./libreoffice');
const { wingetInstall } = require('./winget');
const { removeDirReliably, sleep } = require('#shared/node/fs');
const { runStatus } = require('#shared/node/process');
const { enginesRoot } = require('#shared/node/paths');

// %LOCALAPPDATA%\Pomelo is Pomelo's own folder: once the engines are gone it should not be left behind empty.
// A folder with anything else in it stays.
async function removeEmptyPomeloDir(dir) {
  if (!/^pomelo$/i.test(path.basename(dir))) return;
  for (let attempt = 0; attempt < 8; attempt++) {
    try { fs.rmdirSync(dir); return; } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTEMPTY') return; }
    await sleep(500);
  }
}

// deps are replaceable so the logic can be tested without installing anything.
function createInstaller({ root = enginesRoot(), run = runStatus, redetect = () => ({}) } = {}) {
  const manifest = createManifest(root);
  let busy = null;

  // Install what `key` (pdf | ocr | heic | soffice | pandoc) needs. Resolves { ok, message, engines }.
  async function install(key, note = () => {}) {
    const packId = PACK[key];
    if (!packId) return { ok: false, message: 'Unknown engine' };
    if (busy) return { ok: false, message: `Still installing ${busy}. Wait for it to finish` };
    busy = PACKS[packId].busy;
    try {
      const deps = { run, root, note, manifest };
      if (packId === 'python') await installPython(deps);
      else if (packId === 'soffice') await installLibreOffice(deps);
      else { await wingetInstall(run, PACKS[packId].winget, note); manifest.record({ winget: PACKS[packId].winget }); }
      const engines = redetect();
      const found = { pdf: engines.pdf, pdf2docx: engines.pdf, ocr: engines.ocr, heic: engines.heic, soffice: engines.soffice, pandoc: engines.pandoc }[key];
      if (!found) throw new Error('The install finished but Pomelo still cannot find it. Restart Pomelo and check again');
      return { ok: true, engines };
    } catch (e) {
      return { ok: false, message: e.message };
    } finally { busy = null; }
  }

  // Remove everything Pomelo installed (and only that). Resolves { removed: [names], failed: [names] }.
  // note(text, fraction): fraction is how much of the whole removal is done.
  async function uninstall(note = () => {}) {
    const m = manifest.read();
    const removed = [];
    const failed = [];
    const stuck = new Set();                                                           // ids of what could not be removed, for the manifest
    const folders = [];                                                                // [pack id, folder]
    if (m.pyenv || fs.existsSync(path.join(root, 'pyenv'))) folders.push(['python', 'pyenv']);
    if (m.soffice || fs.existsSync(path.join(root, 'libreoffice'))) folders.push(['soffice', 'libreoffice']);
    const steps = folders.length + m.winget.length;
    let done = 0;
    for (const [id, dir] of folders) {
      const { label } = PACKS[id];
      note(`Removing ${label}…`, done / steps);
      if (await removeDirReliably(path.join(root, dir))) removed.push(label); else { failed.push(label); stuck.add(id); }
      done++;
    }
    for (const w of [...m.winget].reverse()) {                                        // Python last: the environment above depends on it
      note(`Removing ${w.name}…`, done / steps);
      const r = await run('winget', ['uninstall', '--id', w.id, '--exact', '--silent', '--disable-interactivity']);
      if (r.code === 0) removed.push(w.name); else { failed.push(w.name); stuck.add(w.id); }
      done++;
    }
    if (!failed.length) { await removeDirReliably(root); await removeEmptyPomeloDir(path.dirname(root)); }
    else manifest.write({ pyenv: m.pyenv && stuck.has('python'), soffice: m.soffice && stuck.has('soffice'), winget: m.winget.filter((w) => stuck.has(w.id)) });   // keep what is still installed on the list
    return { removed, failed };
  }

  // After an update added an engine to the PDF pack (PDF found, OCR not) the environment Pomelo built is only partly useful:
  // [{ key, label }] naming one missing engine, and installing it rebuilds the whole pack. Empty when the environment is not
  // Pomelo's own, or is not there at all (a pack the user never installed stays that way).
  function pending(engines) {
    if (!manifest.read().pyenv) return [];
    const keys = PACKS.python.keys.filter((k) => k in engines);           // pdf2docx is only another name for pdf
    const missing = keys.find((k) => !engines[k]);
    return missing && keys.some((k) => engines[k]) ? [{ key: missing, label: PACKS.python.label }] : [];
  }

  // The names of what Pomelo installed, for the uninstall confirmation.
  function installed() {
    const m = manifest.read();
    return [...(m.pyenv ? [PACKS.python.label] : []), ...(m.soffice ? [PACKS.soffice.label] : []), ...m.winget.map((w) => w.name)];
  }

  return { install, uninstall, installed, pending, readManifest: manifest.read };
}

module.exports = { createInstaller };

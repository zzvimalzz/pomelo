// SPDX-License-Identifier: AGPL-3.0-or-later
// One-click install of the optional engines, and removal of exactly what Pomelo installed.
//
//   PDF engine + OCR + HEIC     a private Python environment (PyMuPDF, python-docx, RapidOCR, pillow-heif). Python itself is
//                               added with winget only if the PC has none. The OCR models are fetched while it is built.
//   LibreOffice                 its official MSI is fetched with `winget download` (hash-checked) and unpacked into Pomelo's
//                               own folder. Nothing is installed, so no administrator permission, no shortcuts, no registry
//                               entries, and removing it is deleting the folder.
//   Pandoc                      installed with winget.
//
// Everything Pomelo adds is written to manifest.json, so uninstalling never touches software the user installed themselves.
// Progress is reported as note(text, fraction): fraction (0..1, optional) is how far along this engine is.
const fs = require('fs');
const path = require('path');
const { removeDirReliably, dirBytes, sleep } = require('../shared/node/fs');
const { runStatus, lastMeaningfulLine, parsePercent } = require('../shared/node/process');
const { enginesRoot, pyenvPython, scriptPath } = require('../shared/node/paths');

const WARMUP = scriptPath('ocr_warmup.py');

const WINGET = {
  pandoc: { id: 'JohnMacFarlane.Pandoc', name: 'Pandoc' },
};
const LIBREOFFICE = 'TheDocumentFoundation.LibreOffice';
const LO_UNPACKED_BYTES = 1.5e9;                       // size of the unpacked MSI, to turn "bytes written so far" into a percentage
const PYTHON = { id: 'Python.Python.3.12', name: 'Python' };
// PyMuPDF is pinned: its 2.x releases pull in a layout-analysis stack (ONNX models, networkx and more, 120 MB) that nothing here uses.
const PY_PACKAGES = ['pymupdf==1.28.2', 'python-docx', 'pillow-heif', 'rapidocr==3.10.0', 'onnxruntime'];
// Engines that come from the same install: adding PDF, OCR or HEIC adds all three. (pdf2docx is the name 0.1.0 to 0.1.2 used for pdf.)
const PACK = { pdf: 'python', pdf2docx: 'python', ocr: 'python', heic: 'python', soffice: 'soffice', pandoc: 'pandoc' };
const WINGET_FLAGS = ['--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'];

// %LOCALAPPDATA%\Pomelo is Pomelo's own folder: once the engines are gone it should not be left behind empty.
// A folder with anything else in it stays.
async function removeEmptyPomeloDir(dir) {
  if (!/^pomelo$/i.test(path.basename(dir))) return;
  for (let attempt = 0; attempt < 8; attempt++) {
    try { fs.rmdirSync(dir); return; } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTEMPTY') return; }
    await sleep(500);
  }
}

// The unpacked MSI carries things a conversion never uses: help, every spelling dictionary but English, and the
// installer itself. The Visual C++ runtime that LibreOffice ships is copied next to soffice.exe so it starts on a PC without it.
function pruneLibreOffice(dir) {
  for (const d of ['help', 'readmes']) fs.rmSync(path.join(dir, d), { recursive: true, force: true });
  for (const f of fs.readdirSync(dir)) if (/\.msi$/i.test(f)) fs.rmSync(path.join(dir, f), { force: true });
  const extensions = path.join(dir, 'share', 'extensions');
  if (fs.existsSync(extensions)) {
    for (const d of fs.readdirSync(extensions)) if (/^dict-/.test(d) && d !== 'dict-en') fs.rmSync(path.join(extensions, d), { recursive: true, force: true });
  }
  const runtime = path.join(dir, 'System64');
  if (fs.existsSync(runtime)) {
    for (const f of fs.readdirSync(runtime)) if (/\.dll$/i.test(f)) fs.copyFileSync(path.join(runtime, f), path.join(dir, 'program', f));
  }
}

// A result with code -1 and ENOENT means winget itself could not be started, as opposed to a package that failed to install.
function wingetRan(r) {
  if (r.code === -1 && /ENOENT/.test(r.out)) throw new Error('Windows Package Manager (winget) is not available on this PC');
}

// deps are replaceable so the logic can be tested without installing anything.
function createInstaller({ root = enginesRoot(), run = runStatus, redetect = () => ({}) } = {}) {
  const manifestFile = path.join(root, 'manifest.json');
  let busy = null;

  const readManifest = () => {
    try { return { winget: [], pyenv: false, soffice: false, ...JSON.parse(fs.readFileSync(manifestFile, 'utf8')) }; } catch { return { winget: [], pyenv: false, soffice: false }; }
  };
  const writeManifest = (m) => { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(manifestFile, JSON.stringify(m, null, 2)); };
  const record = (patch) => {
    const m = readManifest();
    if (patch.winget && !m.winget.some((w) => w.id === patch.winget.id)) m.winget.push(patch.winget);
    if (patch.pyenv) m.pyenv = true;
    if (patch.soffice) m.soffice = true;
    writeManifest(m);
  };

  // A Python the engine's packages ship wheels for (3.9 to 3.13). A newer one (a pre-release such as 3.15 is what `py -3` can
  // pick) has no ONNX Runtime yet, so it is skipped and Python 3.12 is added instead, for this user only.
  async function findPython() {
    for (const [cmd, args] of [['py', ['-3.12']], ['py', ['-3.13']], ['py', ['-3.11']], ['py', ['-3.10']], ['python', []], ['py', ['-3']]]) {
      const r = await run(cmd, [...args, '-c', 'import sys; print(sys.version_info[0] * 100 + sys.version_info[1]); print(sys.executable)']);
      if (r.code !== 0) continue;
      const [version, exe] = r.out.trim().split(/\r?\n/).slice(-2);
      if (+version >= 309 && +version <= 313 && exe && fs.existsSync(exe.trim())) return exe.trim();   // skips the Microsoft Store stub, which prints nothing useful
    }
    return null;
  }

  async function winget(entry, note) {
    note(`Installing ${entry.name}…`);
    const r = await run('winget', ['install', '--id', entry.id, ...WINGET_FLAGS, ...(entry.args || [])], { onLine: (l) => note(`${entry.name}: ${l}`.slice(0, 90), parsePercent(l)) });
    wingetRan(r);
    if (r.code !== 0) throw new Error(`${entry.name} could not be installed: ${lastMeaningfulLine(r.out)}`);
    record({ winget: { id: entry.id, name: entry.name } });
  }

  // Download the official MSI (winget checks its hash), unpack it into root/libreoffice, tidy it. No installation, no admin.
  async function installLibreOffice(note) {
    const target = path.join(root, 'libreoffice');
    const downloads = path.join(root, 'downloads');
    await removeDirReliably(target);
    await removeDirReliably(downloads);
    fs.mkdirSync(downloads, { recursive: true });
    try {
      note('Downloading LibreOffice…', 0);
      const d = await run('winget', ['download', '--id', LIBREOFFICE, '--exact', '--skip-dependencies', '--download-directory', downloads, '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'],
        { onLine: (l) => note(`LibreOffice: ${l}`.slice(0, 90), 0.25 * (parsePercent(l) ?? 0)) });
      wingetRan(d);
      if (d.code !== 0) throw new Error(`LibreOffice could not be downloaded: ${lastMeaningfulLine(d.out)}`);
      const msi = fs.readdirSync(downloads).find((f) => /\.msi$/i.test(f));
      if (!msi) throw new Error('LibreOffice could not be downloaded: no installer file was found');

      note('Unpacking LibreOffice. This takes a few minutes…', 0.25);
      const timer = setInterval(() => note('Unpacking LibreOffice. This takes a few minutes…', 0.25 + 0.7 * Math.min(1, dirBytes(target) / LO_UNPACKED_BYTES)), 2000);
      let u;
      try { u = await run('msiexec.exe', ['/a', `"${path.join(downloads, msi)}"`, '/qn', `TARGETDIR="${target}"`], { verbatim: true }); } finally { clearInterval(timer); }
      if (u.code !== 0) throw new Error(`LibreOffice could not be unpacked (Windows Installer code ${u.code})`);

      note('Tidying up…', 0.97);
      pruneLibreOffice(target);
      record({ soffice: true });
    } catch (e) {
      await removeDirReliably(target);                                                    // no half-unpacked copy left behind
      throw e;
    } finally { await removeDirReliably(downloads); }
  }

  async function installPython(note) {
    let py = await findPython();
    if (!py) {
      await winget({ ...PYTHON, args: ['--scope', 'user'] }, note);
      const known = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'python.exe');
      py = fs.existsSync(known) ? known : await findPython();
      if (!py) throw new Error('Python was installed but could not be found. Restart Pomelo and try again');
    }
    const env = path.join(root, 'pyenv');
    try {
      await removeDirReliably(env);                                                          // an older environment (other package versions) is rebuilt, not patched
      note('Creating a private Python environment…', 0.05);
      let r = await run(py, ['-m', 'venv', env]);
      if (r.code !== 0) throw new Error(`Could not create the Python environment: ${lastMeaningfulLine(r.out)}`);
      record({ pyenv: true });
      note('Downloading the PDF, OCR and HEIC components…', 0.1);
      r = await run(pyenvPython(root), ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', ...PY_PACKAGES], { onLine: (l) => note(l.slice(0, 90)) });
      if (r.code !== 0) throw new Error(`Could not download the components: ${lastMeaningfulLine(r.out)}`);
      note('Checking the components…', 0.85);
      r = await run(pyenvPython(root), ['-W', 'ignore', '-c', 'import pymupdf, docx, pillow_heif, rapidocr']);
      if (r.code !== 0) throw new Error(`The components did not start: ${lastMeaningfulLine(r.out)}`);
      note('Downloading the text-recognition models…', 0.92);
      await run(pyenvPython(root), ['-W', 'ignore', WARMUP], { timeout: 10 * 60 * 1000 });     // best effort: a scan fetches them itself when it first needs them
    } catch (e) {
      fs.rmSync(env, { recursive: true, force: true });                              // no half-installed environment left behind
      throw e;
    }
  }

  // Install what `key` (pdf | ocr | heic | soffice | pandoc) needs. Resolves { ok, message, engines }.
  async function install(key, note = () => {}) {
    const pack = PACK[key];
    if (!pack) return { ok: false, message: 'Unknown engine' };
    if (busy) return { ok: false, message: `Still installing ${busy}. Wait for it to finish` };
    busy = { python: 'the PDF, OCR and HEIC engine', soffice: 'LibreOffice', pandoc: 'Pandoc' }[pack];
    try {
      if (pack === 'python') await installPython(note);
      else if (pack === 'soffice') await installLibreOffice(note);
      else await winget(WINGET[pack], note);
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
    const m = readManifest();
    const removed = [];
    const failed = [];
    const hasPyenv = m.pyenv || fs.existsSync(path.join(root, 'pyenv'));
    const hasOffice = m.soffice || fs.existsSync(path.join(root, 'libreoffice'));
    const steps = (hasPyenv ? 1 : 0) + (hasOffice ? 1 : 0) + m.winget.length;
    let done = 0;
    const folder = async (dir, name) => {
      note(`Removing ${name}…`, done / steps);
      (await removeDirReliably(path.join(root, dir)) ? removed : failed).push(name);
      done++;
    };
    if (hasPyenv) await folder('pyenv', 'PDF, OCR and HEIC components');
    if (hasOffice) await folder('libreoffice', 'LibreOffice');
    for (const w of [...m.winget].reverse()) {                                        // Python last: the environment above depends on it
      note(`Removing ${w.name}…`, done / steps);
      const r = await run('winget', ['uninstall', '--id', w.id, '--exact', '--silent', '--disable-interactivity']);
      (r.code === 0 ? removed : failed).push(w.name);
      done++;
    }
    if (!failed.length) { await removeDirReliably(root); await removeEmptyPomeloDir(path.dirname(root)); }
    else writeManifest({ pyenv: m.pyenv && failed.includes('PDF, OCR and HEIC components'), soffice: m.soffice && failed.includes('LibreOffice'), winget: m.winget.filter((w) => failed.includes(w.name)) });   // keep what is still installed on the list
    return { removed, failed };
  }

  return { install, uninstall, readManifest };
}

module.exports = { createInstaller, PACK };

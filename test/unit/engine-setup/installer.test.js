// SPDX-License-Identifier: AGPL-3.0-or-later
// Engine installer and uninstaller logic with a fake command runner (nothing is installed).   node test/unit/engine-setup/installer.test.js
const fs = require('fs');
const path = require('path');
const { createInstaller } = require('../../../src/features/engine-setup/installer');

const { expect, failed } = require('../../support/expect');
const finish = require('../../support/finish');
const { dir: tmpDir } = require('../../support/tmp');
const tmp = () => tmpDir('inst');
const touch = (p) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, ''); };

// A runner that records every call. `script(cmd, args)` may return { code, out } to override the default success.
function fake(script = () => null) {
  const calls = [];
  const run = async (cmd, args) => { calls.push([cmd, ...args]); return script(cmd, args) || { code: 0, out: '' }; };
  return { run, calls, named: (cmd) => calls.filter((c) => c[0] === cmd) };
}

(async () => {
  const savedLocal = process.env.LOCALAPPDATA;

  console.log('winget engines');
  {
    const root = tmp(); const f = fake();
    const inst = createInstaller({ root, run: f.run, redetect: () => ({ pandoc: 'C:/P/pandoc.exe' }) });
    const notes = [];
    const r = await inst.install('pandoc', (n) => notes.push(n));
    const call = f.named('winget')[0];
    expect('installs Pandoc by its exact winget id, silently', r.ok && call.includes('JohnMacFarlane.Pandoc') && call.includes('--silent') && call.includes('--exact'), call.join(' '));
    expect('accepts the package agreements so nothing waits for a keypress', call.includes('--accept-package-agreements') && call.includes('--disable-interactivity'));
    expect('progress text is reported', notes.some((n) => /Pandoc/.test(n)));
    expect('what Pomelo installed is written to the manifest', inst.readManifest().winget.map((w) => w.id).join() === 'JohnMacFarlane.Pandoc');
    expect('the same install can be repeated afterwards (no stuck lock)', (await inst.install('pandoc')).ok);
  }
  {
    const root = tmp();
    const f = fake((cmd) => (cmd === 'winget' ? { code: 0, out: '' } : null));
    const seen = [];
    const run = async (cmd, args, opts) => { if (opts?.onLine && cmd === 'winget') opts.onLine('  ██████▒▒▒▒ 45%'); return f.run(cmd, args); };
    await createInstaller({ root, run, redetect: () => ({ pandoc: 'p' }) }).install('pandoc', (text, fraction) => seen.push(fraction));
    expect('winget\'s percentage becomes the progress fraction', seen.includes(0.45), JSON.stringify(seen));
  }
  {
    const root = tmp();
    const seen = [];
    const run = async (cmd, args, opts) => {
      if (cmd === 'winget') { opts.onLine('  ██████▒▒▒▒▒▒  90 MB / 360 MB'); touch(path.join(args[args.indexOf('--download-directory') + 1], 'LibreOffice.msi')); }
      return { code: 0, out: '' };
    };
    await createInstaller({ root, run, redetect: () => ({ soffice: 'x' }) }).install('soffice', (text, fraction) => seen.push(fraction)).catch(() => {});
    expect('a download shown as "90 MB / 360 MB" moves the bar (a quarter of the download share)', seen.some((f) => Math.abs(f - 0.0625) < 1e-9), JSON.stringify(seen));
  }

  console.log('LibreOffice: unpacked into Pomelo\'s own folder, never installed');
  {
    const root = tmp();
    // The fake plays winget (puts an MSI in the download folder) and msiexec (writes what an unpacked LibreOffice contains).
    const f = fake((cmd, args) => {
      if (cmd === 'winget') touch(path.join(args[args.indexOf('--download-directory') + 1], 'LibreOffice.msi'));
      if (cmd === 'msiexec.exe') {
        const target = args.find((a) => a.startsWith('TARGETDIR=')).slice(11, -1);
        for (const p of ['program/soffice.exe', 'help/index.html', 'readmes/README_en-US', 'LibreOffice.msi', 'share/extensions/dict-en/a.dic', 'share/extensions/dict-de/a.dic', 'share/extensions/nlpsolver/a', 'System64/vcruntime140.dll']) touch(path.join(target, p));
      }
      return null;
    });
    const inst = createInstaller({ root, run: f.run, redetect: () => ({ soffice: path.join(root, 'libreoffice', 'program', 'soffice.exe') }) });
    const seen = [];
    const r = await inst.install('soffice', (text, fraction) => seen.push(fraction));
    const dl = f.named('winget')[0];
    const msi = f.named('msiexec.exe')[0];
    const target = path.join(root, 'libreoffice');
    expect('downloads the official package with winget, hash-checked by winget, without its dependencies', r.ok && dl[1] === 'download' && dl.includes('TheDocumentFoundation.LibreOffice') && dl.includes('--skip-dependencies'), dl.join(' '));
    expect('never runs the installer: no "winget install", no administrator permission', f.named('winget').every((c) => c[1] === 'download'));
    expect('unpacks the MSI with an administrative image into Pomelo\'s folder (path quoted for spaces)', msi[1] === '/a' && msi[3] === '/qn' && msi[4] === `TARGETDIR="${target}"` && /^".*LibreOffice\.msi"$/.test(msi[2]), msi.join(' '));
    expect('drops help, readmes, the copied MSI and the other languages\' spelling dictionaries', !['help', 'readmes', 'LibreOffice.msi', 'share/extensions/dict-de'].some((p) => fs.existsSync(path.join(target, p))));
    expect('keeps soffice, English spelling and the rest of the extensions', ['program/soffice.exe', 'share/extensions/dict-en/a.dic', 'share/extensions/nlpsolver/a'].every((p) => fs.existsSync(path.join(target, p))));
    expect('copies the C++ runtime next to soffice.exe', fs.existsSync(path.join(target, 'program', 'vcruntime140.dll')));
    expect('removes the downloaded installer', !fs.existsSync(path.join(root, 'downloads')));
    expect('is on the manifest, so uninstall removes the folder', inst.readManifest().soffice === true && inst.readManifest().winget.length === 0);
    expect('progress only moves forward and ends below 1 (done is reported by the caller)', seen.filter((x) => x !== undefined).every((x, i, a) => i === 0 || x >= a[i - 1]) && seen.some((x) => x >= 0.97));
  }
  {
    const root = tmp();
    const f = fake((cmd, args) => {
      if (cmd === 'winget') touch(path.join(args[args.indexOf('--download-directory') + 1], 'LibreOffice.msi'));
      if (cmd === 'msiexec.exe') { touch(path.join(args.find((a) => a.startsWith('TARGETDIR=')).slice(11, -1), 'program', 'half.dll')); return { code: 1603, out: '' }; }
      return null;
    });
    const inst = createInstaller({ root, run: f.run, redetect: () => ({}) });
    const r = await inst.install('soffice');
    expect('a failed unpack says so, leaves no half-unpacked copy and records nothing', !r.ok && /1603/.test(r.message) && !fs.existsSync(path.join(root, 'libreoffice')) && !fs.existsSync(path.join(root, 'downloads')) && !inst.readManifest().soffice, r.message);
  }
  {
    const root = tmp();
    const r1 = await createInstaller({ root, run: fake((cmd) => (cmd === 'winget' ? { code: -1, out: 'spawn winget ENOENT' } : null)).run }).install('soffice');
    expect('no winget: a plain explanation', !r1.ok && /winget/.test(r1.message), r1.message);
    const r2 = await createInstaller({ root, run: fake((cmd) => (cmd === 'winget' ? { code: 1, out: 'Download failed\nInstaller hash does not match' } : null)).run }).install('soffice');
    expect('a failed download reports the reason', !r2.ok && /hash does not match/.test(r2.message), r2.message);
    const r3 = await createInstaller({ root, run: fake().run }).install('soffice');
    expect('no installer file after the download -> error', !r3.ok && /no installer file/.test(r3.message), r3.message);
  }
  {
    const root = tmp();
    const f = fake((cmd) => (cmd === 'winget' ? { code: -1, out: 'spawn winget ENOENT' } : null));
    const r = await createInstaller({ root, run: f.run, redetect: () => ({}) }).install('pandoc');
    expect('no winget: a plain explanation', !r.ok && /winget/.test(r.message), r.message);
  }
  {
    const root = tmp();
    const f = fake(() => ({ code: 1, out: 'Downloading\nInstaller hash does not match' }));
    const inst = createInstaller({ root, run: f.run, redetect: () => ({}) });
    const r = await inst.install('pandoc');
    expect('a failed install reports the reason and records nothing', !r.ok && /hash does not match/.test(r.message) && inst.readManifest().winget.length === 0, r.message);
  }
  {
    const root = tmp();
    const r = await createInstaller({ root, run: fake().run, redetect: () => ({ pandoc: null }) }).install('pandoc');
    expect('install "succeeded" but the engine is still not found -> error, not a fake Ready', !r.ok && /still cannot find/.test(r.message), r.message);
  }
  expect('unknown engine is refused', !(await createInstaller({ root: tmp(), run: fake().run }).install('rm -rf')).ok);

  console.log('python pack (PDF engine + OCR + HEIC)');
  {
    const root = tmp(); const py = path.join(root, 'sys-python.exe'); touch(py);
    const f = fake((cmd, args) => {
      if (args.includes('-c') && /sys.executable/.test(args[args.indexOf('-c') + 1])) return { code: 0, out: `312\n${py}\n` };
      if (args[0] === '-m' && args[1] === 'venv') { touch(path.join(args[2], 'Scripts', 'python.exe')); return null; }
      return null;
    });
    const inst = createInstaller({ root, run: f.run, redetect: () => ({ pdf: 'x', ocr: 'z', heic: 'y' }) });
    const r = await inst.install('pdf');
    const pip = f.calls.find((c) => c.includes('pip'));
    expect('uses the Python already on the PC (no winget)', r.ok && f.named('winget').length === 0);
    const file = pip && pip[pip.indexOf('-r') + 1];
    const pins = file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')) : [];
    expect('pip installs python/requirements.txt', pip && pip.includes('-r') && path.basename(file) === 'requirements.txt' && path.basename(path.dirname(file)) === 'python', String(pip));
    expect('which pins PyMuPDF (so its 2.x layout stack is not pulled in), python-docx, OCR and HEIC', pins.includes('pymupdf==1.28.2') && pins.includes('python-docx') && pins.includes('pillow-heif') && pins.some((a) => /^rapidocr==/.test(a)) && !pins.some((a) => /pdf2docx|pymupdf4llm/.test(a)), pins.join(' '));
    expect('environment lives under the engines folder and is on the manifest', inst.readManifest().pyenv === true && fs.existsSync(path.join(root, 'pyenv', 'Scripts', 'python.exe')));
    expect('Python itself was not recorded (the user already had it)', inst.readManifest().winget.length === 0);
  }
  {
    const local = tmp(); process.env.LOCALAPPDATA = local;
    const root = tmp(); let installed = false;
    const f = fake((cmd, args) => {
      if (cmd === 'winget') { installed = true; touch(path.join(local, 'Programs', 'Python', 'Python312', 'python.exe')); return null; }
      if (args.includes('-c') && /sys.executable/.test(args[args.indexOf('-c') + 1]) && !installed) return { code: 9009, out: 'Python was not found' };
      if (args[0] === '-m' && args[1] === 'venv') { touch(path.join(args[2], 'Scripts', 'python.exe')); return null; }
      return null;
    });
    const inst = createInstaller({ root, run: f.run, redetect: () => ({ pdf: 'x', ocr: 'z', heic: 'y' }) });
    const r = await inst.install('heic');
    const w = f.named('winget')[0];
    expect('no Python: adds it for the current user only, then carries on', r.ok && w && w.includes('Python.Python.3.12') && w.includes('--scope') && w.includes('user'), String(w));
    expect('Python is on the manifest so uninstall can remove it again', inst.readManifest().winget.some((x) => x.id === 'Python.Python.3.12'));
    process.env.LOCALAPPDATA = savedLocal;
  }
  {
    const root = tmp(); const py = path.join(root, 'sys-python.exe'); touch(py);
    const f = fake((cmd, args) => {
      if (args.includes('-c') && /sys.executable/.test(args[args.indexOf('-c') + 1])) return { code: 0, out: `311\n${py}\n` };
      if (args[0] === '-m' && args[1] === 'venv') { touch(path.join(args[2], 'Scripts', 'python.exe')); return null; }
      if (args.includes('pip')) return { code: 1, out: 'ERROR: No matching distribution found for pymupdf' };
      return null;
    });
    const r = await createInstaller({ root, run: f.run, redetect: () => ({}) }).install('pdf');
    expect('pip failure: reason shown, half-built environment removed', !r.ok && /No matching distribution/.test(r.message) && !fs.existsSync(path.join(root, 'pyenv')), r.message);
  }
  {
    const root = tmp(); let release;
    const gate = new Promise((r) => { release = r; });
    const inst = createInstaller({ root, run: async () => { await gate; return { code: 0, out: '' }; }, redetect: () => ({ pandoc: 'p', soffice: 's' }) });
    const first = inst.install('pandoc');
    const second = await inst.install('soffice');
    expect('a second Install while one is running is refused politely', !second.ok && /Still installing/.test(second.message), second.message);
    release(); await first;
  }

  console.log('an update that adds an engine to the PDF pack');
  {
    const root = tmp();
    const inst = createInstaller({ root, run: fake().run });
    const old = { pdf: 'py', ocr: null, heic: 'py', soffice: null, pandoc: null };
    expect('no environment built by Pomelo: nothing to add, even when an engine is missing', inst.pending(old).length === 0);
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ winget: [], pyenv: true, soffice: false }));
    const p = inst.pending(old);
    expect('PDF found but OCR missing: the pack is named once, by the engine that is missing', p.length === 1 && p[0].key === 'ocr' && p[0].label === 'PDF, OCR and HEIC components', JSON.stringify(p));
    expect('everything found: nothing to add', inst.pending({ ...old, ocr: 'py' }).length === 0);
    expect('nothing found (environment gone): left alone, the Install button is for that', inst.pending({ pdf: null, ocr: null, heic: null }).length === 0);
    expect('engines that are not in this pack are never added (LibreOffice and Pandoc stay as the user left them)', inst.pending({ pdf: 'py', ocr: 'py', heic: 'py', soffice: null, pandoc: null }).length === 0);
    expect('before engines are detected the map is empty: nothing to add', inst.pending({}).length === 0);
  }

  console.log('uninstall removes only what Pomelo installed');
  {
    const root = tmp();
    touch(path.join(root, 'pyenv', 'Scripts', 'python.exe'));
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ pyenv: true, winget: [{ id: 'Python.Python.3.12', name: 'Python' }, { id: 'JohnMacFarlane.Pandoc', name: 'Pandoc' }] }));
    const f = fake();
    const r = await createInstaller({ root, run: f.run }).uninstall();
    const ids = f.named('winget').map((c) => c[c.indexOf('--id') + 1]);
    expect('uninstalls exactly the listed packages, newest first so Python goes last', ids.join() === 'JohnMacFarlane.Pandoc,Python.Python.3.12', ids.join());
    expect('LibreOffice (not on the list) is never touched', !ids.includes('TheDocumentFoundation.LibreOffice'));
    expect('the engines folder is gone', !fs.existsSync(root) && r.failed.length === 0, JSON.stringify(r));
  }
  {
    const root = tmp();
    touch(path.join(root, 'libreoffice', 'program', 'soffice.exe'));
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ pyenv: false, soffice: true, winget: [] }));
    const f = fake();
    const fractions = [];
    const r = await createInstaller({ root, run: f.run }).uninstall((text, fraction) => fractions.push(fraction));
    expect('the unpacked LibreOffice is removed by deleting its folder: no winget, no administrator permission', f.calls.length === 0 && r.removed.join() === 'LibreOffice' && r.failed.length === 0 && !fs.existsSync(root), JSON.stringify(r));
    expect('removal progress is reported as a fraction', fractions.length === 1 && fractions[0] === 0, JSON.stringify(fractions));
  }
  {
    const root = tmp();
    const f = fake();
    const r = await createInstaller({ root, run: f.run }).uninstall();
    expect('nothing recorded -> nothing is uninstalled', f.calls.length === 0 && r.removed.length === 0 && r.failed.length === 0);
  }
  {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ pyenv: false, winget: [{ id: 'A.One', name: 'One' }, { id: 'B.Two', name: 'Two' }] }));
    const f = fake((cmd, args) => (args.includes('A.One') ? { code: 1, out: 'busy' } : null));
    const inst = createInstaller({ root, run: f.run });
    const r = await inst.uninstall();
    expect('a package that will not uninstall stays on the list for next time', r.failed.join() === 'One' && r.removed.join() === 'Two' && inst.readManifest().winget.map((w) => w.name).join() === 'One');
  }
  {
    // The manifest an install made with Pomelo 0.1.2 (the same format today): what is still installed is kept by id, not by name.
    const root = tmp();
    touch(path.join(root, 'pyenv', 'Scripts', 'python.exe'));
    touch(path.join(root, 'libreoffice', 'program', 'soffice.exe'));
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ winget: [{ id: 'Python.Python.3.12', name: 'Python' }, { id: 'JohnMacFarlane.Pandoc', name: 'Pandoc' }], pyenv: true, soffice: true }));
    const f = fake((cmd, args) => (args.includes('JohnMacFarlane.Pandoc') ? { code: 1, out: 'in use' } : null));
    const inst = createInstaller({ root, run: f.run });
    const r = await inst.uninstall();
    const m = inst.readManifest();
    expect('the Python environment and LibreOffice are removed, Python is uninstalled, Pandoc fails', r.removed.join() === 'PDF, OCR and HEIC components,LibreOffice,Python' && r.failed.join() === 'Pandoc', JSON.stringify(r));
    expect('only Pandoc stays on the manifest, and the flags for what is gone are cleared', m.winget.map((w) => w.id).join() === 'JohnMacFarlane.Pandoc' && m.pyenv === false && m.soffice === false, JSON.stringify(m));
    expect('and the names for the confirmation come from the manifest', inst.installed().join() === 'Pandoc');
  }

  console.log(failed() ? `\n${failed()} failed` : '\nall passed');
  finish();
})();

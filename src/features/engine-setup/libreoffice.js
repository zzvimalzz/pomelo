// SPDX-License-Identifier: AGPL-3.0-or-later
// LibreOffice: download the official MSI (winget checks its hash), unpack it into root/libreoffice and tidy it. No installation,
// so no administrator permission, no shortcuts and no registry entries; removing it is deleting the folder.
const fs = require('fs');
const path = require('path');
const { PACKS } = require('./packs');
const { wingetRan } = require('./winget');
const { removeDirReliably, dirBytes } = require('#shared/node/fs');
const { lastMeaningfulLine, parsePercent } = require('#shared/node/process');

const LO_UNPACKED_BYTES = 1.5e9;                       // size of the unpacked MSI, to turn "bytes written so far" into a percentage

// The unpacked MSI carries things a conversion never uses: help, every spelling dictionary but English, and the
// installer itself. The Visual C++ runtime that LibreOffice ships is copied next to soffice.exe so it starts on a PC without it.
function prune(dir) {
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

async function installLibreOffice({ run, root, note, manifest }) {
  const target = path.join(root, 'libreoffice');
  const downloads = path.join(root, 'downloads');
  await removeDirReliably(target);
  await removeDirReliably(downloads);
  fs.mkdirSync(downloads, { recursive: true });
  try {
    note('Downloading LibreOffice…', 0);
    const d = await run('winget', ['download', '--id', PACKS.soffice.wingetId, '--exact', '--skip-dependencies', '--download-directory', downloads, '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'],
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
    prune(target);
    manifest.record({ soffice: true });
  } catch (e) {
    await removeDirReliably(target);                                                    // no half-unpacked copy left behind
    throw e;
  } finally { await removeDirReliably(downloads); }
}

module.exports = { installLibreOffice };

// SPDX-License-Identifier: AGPL-3.0-or-later
// Archives: ZIP, 7Z, TAR, GZIP (tar.gz, or a single gzipped file) and RAR (input only), plus folders.
//   - 7-Zip (the 7zip-bin build, LGPL) reads and writes zip / 7z / tar. It handles accented and CJK file names,
//     which Windows' own tar.exe does not.
//   - tar.gz is a tar made by 7-Zip, gzipped here with zlib.
//   - Windows' bsdtar (libarchive) reads RAR 3/5 with its own open-source reader (no encrypted or multi-part RAR).
//     Writing RAR needs WinRAR's closed-source compressor, so RAR is input only.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { run, tempPath, uniquePath } = require('../convert/util');

const BSDTAR = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe');
const FROM = new Set(['zip', '7z', 'tar', 'gz', 'rar']);
const TO = new Set(['zip', '7z', 'tar', 'gz']);

function detect() {
  try {
    const p = require('7zip-bin').path7za;
    const unpacked = p && p.replace('app.asar', 'app.asar.unpacked');
    return unpacked && fs.existsSync(unpacked) ? unpacked : null;
  } catch { return null; }
}

const sevenZip = (engines, args, opts) => run(engines.sevenZip, ['-bd', '-y', ...args], { timeout: 3600000, ...opts });

// Is this .gz a tar archive (tar.gz / tgz) rather than one compressed file?
async function gzIsTar(src) {
  if (/\.(tar\.gz|tgz)$/i.test(src)) return true;
  const head = await new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    const gunzip = zlib.createGunzip();
    const done = () => resolve(Buffer.concat(chunks));
    gunzip.on('data', (d) => { chunks.push(d); size += d.length; if (size >= 512) { gunzip.destroy(); done(); } });
    gunzip.on('error', done);
    gunzip.on('end', done);
    fs.createReadStream(src, { end: 65535 }).pipe(gunzip);
  });
  return head.length >= 262 && head.toString('latin1', 257, 262) === 'ustar';
}

// An archive must never write outside the folder it is extracted to ("zip slip"): check what actually landed on disk.
function assertContained(root) {
  const base = fs.realpathSync(root);
  const inside = (p) => p === base || p.startsWith(base + path.sep);
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        let target;
        try { target = fs.realpathSync(full); } catch { target = null; }
        if (!target || !inside(target)) throw new Error('The archive contains a link that points outside itself, so it was not extracted');
      } else if (entry.isDirectory()) walk(full);
    }
  };
  walk(base);
}

async function extract(src, from, dest, engines) {
  if (from === 'rar') {
    // tar.exe cannot open non-ASCII paths, so read a copy that has an ASCII name
    const staged = tempPath('rar');
    fs.copyFileSync(src, staged);
    try { await run(BSDTAR, ['-xf', staged, '-C', dest], { timeout: 3600000 }); } finally { fs.rmSync(staged, { force: true }); }
  } else if (from === 'gz' && !(await gzIsTar(src))) {
    const name = path.basename(src).replace(/\.gz$/i, '') || 'file';
    await pipeline(fs.createReadStream(src), zlib.createGunzip(), fs.createWriteStream(path.join(dest, name)));
  } else if (from === 'gz') {
    const tar = tempPath('tar');
    try {
      await pipeline(fs.createReadStream(src), zlib.createGunzip(), fs.createWriteStream(tar));
      await sevenZip(engines, ['x', `-o${dest}`, tar]);
    } finally { fs.rmSync(tar, { force: true }); }
  } else {
    await sevenZip(engines, ['x', `-o${dest}`, src]);                        // zip, 7z, tar
  }
  assertContained(dest);
}

// Names that a command line could mistake for an option ("-x") or a 7-Zip list file ("@x").
const safeName = (n) => (/^[-@]/.test(n) ? './' + n : n);

// Compress `names` (relative to cwd) into `out`.
async function compress(names, to, out, cwd, engines) {
  const list = names.map(safeName);
  if (to === 'gz') {                                                         // tar.gz
    const tar = tempPath('tar');
    try {
      await sevenZip(engines, ['a', '-ttar', tar, ...list], { cwd });
      await pipeline(fs.createReadStream(tar), zlib.createGzip({ level: 9 }), fs.createWriteStream(out));
    } finally { fs.rmSync(tar, { force: true }); }
    return;
  }
  await sevenZip(engines, ['a', `-t${to}`, ...(to === 'tar' ? [] : ['-mx=5']), out, ...list], { cwd });
}

async function pack(dir, to, outDir, base, engines) {
  const entries = fs.readdirSync(dir);
  if (!entries.length) throw new Error('The archive is empty');
  if (to === 'gz' && entries.length === 1 && fs.statSync(path.join(dir, entries[0])).isFile()) {
    const out = uniquePath(outDir, entries[0], 'gz');                       // report.txt -> report.txt.gz
    await pipeline(fs.createReadStream(path.join(dir, entries[0])), zlib.createGzip({ level: 9 }), fs.createWriteStream(out));
    return out;
  }
  const out = uniquePath(outDir, base, to === 'gz' ? 'tar.gz' : to);
  await compress(entries.length > 150 ? ['.'] : entries, to, out, dir, engines);
  return out;
}

// A folder -> zip / 7z / tar / tar.gz, stored next to the folder.
async function packFolder(src, to, outDir, base, engines) {
  const out = uniquePath(outDir, base, to === 'gz' ? 'tar.gz' : to);
  await compress([path.basename(src)], to, out, path.dirname(src), engines);
  return out;
}

// An archive -> a folder next to it. If everything sits inside one top-level folder, that folder is used
// directly (photos.zip containing photos/ gives photos/, not photos/photos/).
async function extractToFolder(src, from, outDir, base, engines) {
  const work = tempPath('d');
  fs.mkdirSync(work);
  try {
    await extract(src, from, work, engines);
    const entries = fs.readdirSync(work);
    if (!entries.length) throw new Error('The archive is empty');
    const single = entries.length === 1 && fs.statSync(path.join(work, entries[0])).isDirectory();
    const out = uniquePath(outDir, single ? entries[0] : base, '');
    fs.cpSync(single ? path.join(work, entries[0]) : work, out, { recursive: true });
    return out;
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

module.exports = {
  name: 'archive',
  detect,
  supports: (from, to, engines) => !!engines.sevenZip && from !== to
    && ((FROM.has(from) && (TO.has(to) || to === 'folder')) || (from === 'folder' && TO.has(to))),
  async run({ src, from, to, dir, base, engines }) {
    if (to === 'folder') return [await extractToFolder(src, from, dir, base, engines)];
    if (from === 'folder') return [await packFolder(src, to, dir, base, engines)];
    const work = tempPath('d');
    fs.mkdirSync(work);
    try {
      await extract(src, from, work, engines);
      return [await pack(work, to, dir, base, engines)];
    } finally { fs.rmSync(work, { recursive: true, force: true }); }
  },
};

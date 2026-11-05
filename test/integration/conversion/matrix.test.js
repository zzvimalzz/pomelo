// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs the conversion matrix inside Electron (printToPDF / nativeImage need it).  npx electron test/integration/conversion/matrix.test.js
//   npx electron test/integration/conversion/matrix.test.js --only=mp4,pdf      only these source formats
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const convert = require('../../../src/features/conversion');
const { TARGET_ORDER, VIDEO, AUDIO, extOf } = require('../../../src/features/conversion/catalog/formats');
const pdf = require('../../../src/features/conversion/lib/pdfjs');
const finish = require('../../support/finish');
const tmp = require('../../support/tmp');

const MARK = 'Pomelo converts files';
const SUB = 'Hello subtitles';
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',');
const TAR = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe');
const MEDIA = new Set([...VIDEO, ...AUDIO]);

// ---- a tiny stored (uncompressed) RAR5 archive, so the RAR reader can be tested without WinRAR ----
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const vint = (n) => { const out = []; do { let b = n & 0x7f; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n); return Buffer.from(out); };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
function rar5Block(body) {            // body = type, flags, ... ; prefixed with its size and CRC
  const size = vint(body.length);
  return Buffer.concat([u32(crc32(Buffer.concat([size, body]))), size, body]);
}
function buildRar5(name, data) {
  const nameBuf = Buffer.from(name);
  const main = rar5Block(Buffer.concat([vint(1), vint(0), vint(0)]));
  const file = rar5Block(Buffer.concat([vint(2), vint(2), vint(data.length), vint(4), vint(data.length), vint(0), u32(crc32(data)), vint(0), vint(0), vint(nameBuf.length), nameBuf]));
  const end = rar5Block(Buffer.concat([vint(5), vint(0), vint(0)]));
  return Buffer.concat([Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]), main, file, data, end]);
}

async function makeFixtures(dir) {
  const { Document, Packer, Paragraph, HeadingLevel, Table, TableRow, TableCell } = require('docx');
  const XLSX = require('xlsx');
  const sharp = require('sharp');
  const f = (n) => path.join(dir, n);
  const cell = (t) => new TableCell({ children: [new Paragraph(t)] });
  const docx = await Packer.toBuffer(new Document({ sections: [{ children: [
    new Paragraph({ text: 'Quarterly Report', heading: HeadingLevel.HEADING_1 }),
    new Paragraph(`${MARK} without leaving your flow.`),
    new Paragraph({ text: 'First point', bullet: { level: 0 } }),
    new Paragraph({ text: 'Second point', bullet: { level: 0 } }),
    new Table({ rows: [new TableRow({ children: [cell('Item'), cell('Qty')] }), new TableRow({ children: [cell('Widget'), cell('42')] })] }),
  ] }] }));
  fs.writeFileSync(f('report.docx'), docx);
  fs.writeFileSync(f('notes.txt'), `Notes\n\n${MARK} quickly.\nSecond line.\n`);
  fs.writeFileSync(f('readme.md'), `# Title\n\n${MARK} **fast**.\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n`);
  fs.writeFileSync(f('page.html'), `<html><body><h1>Page</h1><p>${MARK} well.</p><ul><li>x</li></ul></body></html>`);
  fs.writeFileSync(f('data.csv'), 'Item,Qty,Note\nWidget,42,"has, comma"\nGadget,7,é ü ñ\n');
  fs.writeFileSync(f('semi.csv'), 'Item;Qty\nWidget;42\n');
  fs.writeFileSync(f('data.tsv'), 'Item\tQty\nWidget\t42\n');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Item', 'Qty'], ['Widget', 42], ['Gadget', 7]]), 'Sales');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Name'], ['Widget']]), 'Other');
  fs.writeFileSync(f('book.xlsx'), XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }));
  const png = await sharp({ create: { width: 120, height: 80, channels: 4, background: { r: 255, g: 138, b: 31, alpha: 1 } } }).png().toBuffer();
  fs.writeFileSync(f('pic.png'), png);
  fs.writeFileSync(f('vec.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><rect width="100" height="60" fill="#f80"/></svg>');
  await sharp(png).jpeg().toFile(f('pic.jpg'));
  await sharp(png).webp().toFile(f('pic.webp'));
  await sharp(png).gif().toFile(f('pic.gif'));
  // PDF fixture (text based), via the built-in engine
  await convert.convertFile(f('readme.md'), 'pdf');
  fs.renameSync(f('readme.pdf'), f('doc.pdf'));
  // a PDF with a clearly ruled table, for PDF -> XLSX
  fs.writeFileSync(f('grid.html'), '<html><body style="font:14pt Arial"><h2>Prices</h2><table style="border-collapse:collapse;width:100%">' +
    [['Item', 'Qty', 'Price'], ['Widget', '42', '9.50'], ['Gadget', '7', '120']].map((r) => '<tr>' + r.map((c) => `<td style="border:2px solid #000;padding:14px">${c}</td>`).join('') + '</tr>').join('') + '</table></body></html>');
  await convert.convertFile(f('grid.html'), 'pdf');
  fs.rmSync(f('grid.html'));
  // Formats the built-in engine can write
  await convert.convertFile(f('book.xlsx'), 'xls'); fs.renameSync(f('book.xls'), f('old.xls'));
  await convert.convertFile(f('book.xlsx'), 'ods'); fs.renameSync(f('book.ods'), f('open.ods'));
  await convert.convertFile(f('readme.md'), 'epub'); fs.renameSync(f('readme.epub'), f('book.epub'));
  const PptxGenJS = require('pptxgenjs');
  const deck = new PptxGenJS();
  deck.addSlide().addText(`${MARK} slide one`, { x: 1, y: 1, fontSize: 28 });
  deck.addSlide().addText('Slide two', { x: 1, y: 1, fontSize: 28 });
  await deck.writeFile({ fileName: f('deck.pptx') });
  // Legacy/binary document formats can only be written by LibreOffice
  if (convert.getEngines().soffice) {
    for (const to of ['doc', 'rtf', 'odt']) { await convert.convertFile(f('report.docx'), to); fs.renameSync(f('report.' + to), f('legacy.' + to)); }
    await convert.convertFile(f('deck.pptx'), 'ppt'); fs.renameSync(f('deck.ppt'), f('old.ppt'));
  }
  if (convert.getEngines().heic) { await convert.convertFile(f('pic.png'), 'heic'); fs.renameSync(f('pic.heic'), f('photo.heic')); }

  // subtitles
  fs.writeFileSync(f('movie.srt'), `1\n00:00:01,000 --> 00:00:03,500\n${SUB}\n\n2\n00:00:04,000 --> 00:00:06,000\n<i>Second</i> line\n`);
  fs.writeFileSync(f('talk.vtt'), `WEBVTT\n\nNOTE a comment\n\ncue-1\n00:01.000 --> 00:03.500 align:start\n${SUB}\n\n01:00:04.000 --> 01:00:06.000\nSecond line\n`);

  // archives
  const src = f('_payload'); fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(src, 'hello.txt'), 'hello archive\n'); fs.writeFileSync(path.join(src, 'sub', 'deep.txt'), 'deep\n');
  for (const [name, args] of [['demo.zip', ['--format', 'zip', '-cf']], ['demo.tar', ['-cf']], ['demo.tar.gz', ['-czf']]]) {
    const r = spawnSync(TAR, [...args, f(name), '-C', src, 'hello.txt', 'sub'], { windowsHide: true });
    if (r.status !== 0) throw new Error('could not build ' + name + ': ' + r.stderr);
  }
  const sz = convert.getEngines().sevenZip;
  if (sz) { const r = spawnSync(sz, ['a', '-t7z', '-bd', f('demo.7z'), 'hello.txt', 'sub'], { cwd: src, windowsHide: true }); if (r.status !== 0) throw new Error('could not build demo.7z: ' + r.stdout); }
  fs.writeFileSync(f('single.txt.gz'), zlib.gzipSync(Buffer.from('just one file\n')));
  fs.writeFileSync(f('demo.rar'), buildRar5('hello.txt', Buffer.from('hello from rar\n')));
  fs.rmSync(src, { recursive: true, force: true });

  // video and audio (generated by ffmpeg itself)
  const ff = convert.getEngines().ffmpeg;
  if (ff) {
    const gen = (out, extra) => { const r = spawnSync(ff, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', ...extra, f(out)], { windowsHide: true }); if (r.status !== 0) throw new Error('ffmpeg fixture ' + out + ': ' + r.stderr); };
    gen('clip.mp4', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']);
    gen('movie.mkv', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']);
    const tone = (out, extra) => { const r = spawnSync(ff, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', ...extra, f(out)], { windowsHide: true }); if (r.status !== 0) throw new Error('ffmpeg fixture ' + out + ': ' + r.stderr); };
    tone('tone.wav', ['-c:a', 'pcm_s16le']);
    tone('song.mp3', ['-c:a', 'libmp3lame']);
  }
}

const ffOk = (out) => {
  const r = spawnSync(convert.getEngines().ffmpeg, ['-v', 'error', '-i', out, '-f', 'null', '-'], { windowsHide: true });
  if (r.status !== 0) throw new Error('not playable: ' + String(r.stderr).trim().split('\n').pop());
};

async function validate(out, to, from) {
  const st = fs.statSync(out);
  if (!st.isDirectory() && !st.size) throw new Error('empty output');       // (folders report size 0)
  const text = () => fs.readFileSync(out, 'utf8');
  if (MEDIA.has(to) || to === 'gif' && MEDIA.has(from)) return ffOk(out);
  if (['srt', 'vtt', 'txt'].includes(to) && ['srt', 'vtt'].includes(from)) { if (!text().includes(SUB)) throw new Error('subtitle text missing'); return; }
  if (to === '7z') {
    const r = spawnSync(convert.getEngines().sevenZip, ['l', out], { windowsHide: true });
    if (r.status !== 0 || !/hello\.txt|single\.txt/.test(String(r.stdout))) throw new Error('7z archive unreadable or missing entries');
    return;
  }
  if (to === 'folder') {
    if (!fs.statSync(out).isDirectory()) throw new Error('not a folder');
    const seen = fs.readdirSync(out);
    if (!seen.some((n) => /hello|single|deep/.test(n) || n === 'sub')) throw new Error('nothing extracted: ' + seen.join(','));
    return;
  }
  if (['zip', 'tar'].includes(to) || (to === 'gz' && /\.tar\.gz$/.test(out))) {
    const r = spawnSync(TAR, ['-tf', out], { windowsHide: true });
    if (r.status !== 0) throw new Error('archive unreadable: ' + r.stderr);
    const list = String(r.stdout);
    if (!/hello\.txt/.test(list) && !/just one file|single/.test(out)) throw new Error('missing entries: ' + list.slice(0, 80));
    return;
  }
  if (to === 'gz') { if (zlib.gunzipSync(fs.readFileSync(out)).length === 0) throw new Error('empty gz'); return; }
  if (to === 'epub') {
    const zip = await require('jszip').loadAsync(fs.readFileSync(out));
    if ((await zip.file('mimetype').async('string')) !== 'application/epub+zip') throw new Error('bad mimetype');
    if (!zip.file(/content\.opf$/).length && !zip.file(/package\.opf$/).length) throw new Error('no package document');
    return;
  }
  if (to === 'heic') { if (!fs.readFileSync(out).slice(4, 12).toString().startsWith('ftyp')) throw new Error('not a HEIF file'); return; }
  if (to === 'pptx') { const zip = await require('jszip').loadAsync(fs.readFileSync(out)); if (!zip.file('ppt/slides/slide1.xml')) throw new Error('no slides'); return; }
  if (to === 'xlsx' && from === 'pdf') { const wb = require('xlsx').readFile(out); if (!wb.SheetNames.length) throw new Error('no sheets'); return; }
  if (['txt', 'md', 'html', 'csv', 'tsv', 'json'].includes(to)) return;   // content spot checks are in the per-source expectations below
  if (to === 'pdf') { const { pages } = await pdf.extractBlocks(out).catch(() => ({ pages: [[{ text: '' }]] })); return pages.flat().map((b) => b.text).join(' '); }
  if (to === 'docx') return (await require('mammoth').extractRawText({ path: out })).value;
  if (['png', 'jpg', 'webp', 'avif', 'tiff', 'gif'].includes(to)) { const m = await require('sharp')(out).metadata(); if (!m.width) throw new Error('bad image'); }
  void text;
}

app.on('window-all-closed', () => {});   // hidden print windows come and go; don't quit

(async () => {
  await app.whenReady();
  const eng = convert.detectEngines();
  console.log('engines:', JSON.stringify(eng));
  const dir = tmp.dir('test');
  await makeFixtures(dir);
  const files = fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isFile());
  console.log('fixtures:', files.join(', '), '\n');

  let pass = 0; const fails = []; const skipped = new Set();
  for (const name of files) {
    const from = extOf(name);
    if (only && !only.includes(from)) continue;
    for (const to of TARGET_ORDER[from] || []) {
      if (!convert.canConvert(from, to)) { skipped.add(`${from}->${to}`); continue; }
      const t0 = Date.now();
      try {
        const outs = await convert.convertFile(path.join(dir, name), to);
        const textOut = await validate(outs[0], to, from);
        // validate() hands back the text of pdf and docx outputs; the plain-text formats are read here
        const outText = typeof textOut === 'string' ? textOut : ['txt', 'md', 'html'].includes(to) ? fs.readFileSync(outs[0], 'utf8') : null;
        if (outText !== null && /^(report|readme|notes|page|legacy|doc)\./.test(name) && !outText.includes('Pomelo')) throw new Error(`missing text in output: "${outText.slice(0, 60)}"`);
        if (['csv', 'html', 'json'].includes(to) && /^(book|data|old|open)\.(xlsx|xls|ods|csv|tsv)$/.test(name) && !fs.readFileSync(outs[0], 'utf8').includes('Widget')) throw new Error('missing cell data');
        if (to === 'epub') { const book = await require('../../../src/features/conversion/lib/epub').read(outs[0]).catch(() => null); if (book && /^(report|readme|notes|page)\./.test(name) && !book.body.includes('Pomelo')) throw new Error('missing text in epub'); }
        if (to === 'xlsx' && name === 'grid.pdf') { const wb = require('xlsx').readFile(outs[0]); if (!require('xlsx').utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]]).includes('Widget,42')) throw new Error('table cells wrong'); }
        pass++;
        console.log(`  ok  ${name.padEnd(16)} -> ${to.padEnd(5)} ${String(Date.now() - t0).padStart(5)}ms  ${outs.length > 1 ? outs.length + ' files' : path.basename(outs[0])}`);
      } catch (e) {
        fails.push(`${name} -> ${to}: ${e.message}`);
        console.log(`  FAIL ${name.padEnd(16)} -> ${to.padEnd(5)} ${e.message}`);
      }
    }
  }
  // Compressing a folder (name with a dot, nested content), and what the wheel offers for folders and zips
  if (!only || only.includes('folder')) {
    const proj = path.join(dir, 'Project v1.2');
    fs.mkdirSync(path.join(proj, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'hello.txt'), 'hello folder\n'); fs.writeFileSync(path.join(proj, 'sub', 'deep.txt'), 'deep\n');
    const ids = (p) => convert.targetsFor([p]).map((t) => t.id).join(',');
    const expectIds = (what, got, want) => { if (got !== want) { fails.push(`${what}: wheel offers "${got}", expected "${want}"`); console.log(`  FAIL ${what}: wheel offers "${got}"`); } else { pass++; console.log(`  ok   ${what}: wheel offers ${got}`); } };
    expectIds('folder', ids(proj), 'zip,7z,tar,gz');
    expectIds('mixed folder + file', convert.targetsFor([proj, path.join(dir, 'notes.txt')]).map((t) => t.id).join(','), '');
    for (const to of ['zip', '7z', 'tar', 'gz']) {
      const t0 = Date.now();
      try {
        const [o] = await convert.convertFile(proj, to);
        const r = spawnSync(TAR, ['-tf', o], { windowsHide: true });
        const list = String(r.stdout).replace(/\\/g, '/');
        if (r.status !== 0 || !/hello\.txt/.test(list) || !/sub\/deep\.txt/.test(list)) throw new Error('archive content wrong: ' + list.slice(0, 100));
        if (!path.basename(o).startsWith('Project v1.2.')) throw new Error('bad output name ' + path.basename(o));
        pass++; console.log(`  ok   Project v1.2/ (folder) -> ${to.padEnd(4)} ${String(Date.now() - t0).padStart(5)}ms  ${path.basename(o)}`);
      } catch (e) { fails.push(`folder -> ${to}: ${e.message}`); console.log(`  FAIL folder -> ${to} ${e.message}`); }
    }
  }

  console.log(`\n${pass} passed, ${fails.length} failed`);
  if (skipped.size) console.log('not available (missing engine): ' + [...skipped].join(', '));
  fails.forEach((f) => console.log('  - ' + f));
  require('sharp').cache(false);   // libvips keeps the images it read open, and Windows will not delete an open file
  finish(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); finish(2); });

// SPDX-License-Identifier: AGPL-3.0-or-later
// Edge cases that real files hit: odd names, local and remote images, broken input, parallel jobs.
//   npx electron test/edge-cases.js
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');
const sharp = require('sharp');
const convert = require('../src/main/convert');
const pdf = require('../src/features/conversion/lib/pdfjs');
const { Jobs } = require('../src/main/jobs');

app.on('window-all-closed', () => {});
const { expect, failed } = require('./support/expect');
const finish = require('./support/finish');
const tmp = require('./support/tmp');
const within = (ms, promise) => Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`still running after ${ms / 1000}s`)), ms))]);
const ORANGE = (r, g, b) => r > 220 && g > 100 && g < 180 && b < 80;

// does any rendered page of this PDF contain the orange test picture?
async function pdfHasOrange(file) {
  const [png] = await pdf.renderPages(file, 'png', 60);
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += info.channels) if (ORANGE(data[i], data[i + 1], data[i + 2])) return true;
  return false;
}

app.whenReady().then(async () => {
  convert.detectEngines();
  const dir = tmp.dir('edge');
  const f = (n) => path.join(dir, n);
  const { Document, Packer, Paragraph } = require('docx');
  const png = await sharp({ create: { width: 160, height: 100, channels: 3, background: { r: 255, g: 138, b: 31 } } }).png().toBuffer();

  console.log('names with accents, CJK, spaces and brackets');
  const odd = 'résumé 日本語 (1) [draft] #2.docx';
  fs.writeFileSync(f(odd), await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('Pomelo handles odd names')] }] })));
  for (const to of ['pdf', 'txt', 'md', 'html']) {
    try { const [out] = await within(60000, convert.convertFile(f(odd), to)); expect(`docx -> ${to}: ${path.basename(out)}`, fs.statSync(out).size > 0); }
    catch (e) { expect(`docx -> ${to}`, false, e.message); }
  }
  const folder = f('Ünï cødé 日本 folder');
  fs.mkdirSync(path.join(folder, 'sub dir'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'sub dir', 'файл.txt'), 'hello');
  for (const to of ['zip', '7z', 'tar']) {
    try { const [out] = await within(60000, convert.convertFile(folder, to)); expect(`folder -> ${to}: ${path.basename(out)}`, fs.statSync(out).size > 0); }
    catch (e) { expect(`folder -> ${to}`, false, e.message); }
  }

  console.log('local images next to a Markdown / HTML file');
  fs.writeFileSync(f('orange.png'), png);
  fs.writeFileSync(f('with image.md'), '# Title\n\n![orange](orange.png)\n');
  fs.writeFileSync(f('with image.html'), '<html><body><h1>T</h1><img src="orange.png"></body></html>');
  for (const name of ['with image.md', 'with image.html']) {
    try { const [out] = await within(60000, convert.convertFile(f(name), 'pdf')); expect(`${name} -> pdf shows the picture`, await pdfHasOrange(out)); }
    catch (e) { expect(`${name} -> pdf`, false, e.message); }
  }

  console.log('remote images must not cause network requests (files never leave the machine)');
  let hits = 0;
  const server = http.createServer((req, res) => { hits++; res.setHeader('content-type', 'image/png'); res.end(png); }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const remote = `http://127.0.0.1:${server.address().port}/tracker.png`;
  fs.writeFileSync(f('remote.html'), `<html><body><h1>R</h1><img src="${remote}"></body></html>`);
  fs.writeFileSync(f('remote.md'), `# R\n\n![x](${remote})\n`);
  for (const [name, to] of [['remote.html', 'pdf'], ['remote.md', 'pdf'], ['remote.html', 'docx'], ['remote.md', 'docx'], ['remote.html', 'epub'], ['remote.md', 'html']]) {
    const before = hits;
    try { await within(60000, convert.convertFile(f(name), to)); } catch { /* failing is fine, calling out is not */ }
    expect(`${name} -> ${to}: no request to the remote host`, hits === before, hits === before ? '' : `${hits - before} request(s) made`);
  }
  server.close();

  console.log('broken input fails fast with a message');
  fs.writeFileSync(f('empty.docx'), '');
  fs.writeFileSync(f('corrupt.pdf'), 'this is not a pdf');
  fs.writeFileSync(f('fake.zip'), Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 37) & 255)));
  fs.writeFileSync(f('fake.png'), 'not an image');
  fs.writeFileSync(f('fake.xlsx'), 'not a workbook');
  for (const [name, to] of [['empty.docx', 'pdf'], ['corrupt.pdf', 'docx'], ['corrupt.pdf', 'txt'], ['corrupt.pdf', 'png'], ['fake.zip', 'folder'], ['fake.png', 'jpg'], ['fake.xlsx', 'csv']]) {
    const t0 = Date.now();
    try { await within(90000, convert.convertFile(f(name), to)); expect(`${name} -> ${to}: should not "succeed"`, false); }
    catch (e) { expect(`${name} -> ${to}: rejected in ${Date.now() - t0}ms`, !!e.message && !/still running/.test(e.message) && Date.now() - t0 < 60000, e.message.slice(0, 70)); }
  }

  console.log('two drops of the same file to the same format at once');
  fs.writeFileSync(f('twice.docx'), await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('twice')] }] })));
  const jobs = new Jobs({ convert: (s, t, o) => convert.convertFile(s, t, o), concurrency: 3, maxStack: 3 });
  jobs.addConversion(f('twice.docx'), 'pdf', 'PDF');
  jobs.addConversion(f('twice.docx'), 'pdf', 'PDF');
  await within(120000, new Promise((r) => { const iv = setInterval(() => { if (!jobs.active().length) { clearInterval(iv); r(); } }, 150); }));
  const pdfs = fs.readdirSync(dir).filter((n) => /^twice.*\.pdf$/.test(n)).sort();
  expect('both outputs exist under different names', pdfs.length === 2, pdfs.join(', '));
  expect('neither job failed', jobs.batch.every((j) => j.state === 'done'), jobs.batch.map((j) => j.state + (j.error ? ': ' + j.error : '')).join(' | '));

  console.log('GIF export: whole clip, any source, animation kept');
  {
    const { execFileSync } = require('child_process');
    const ffmpegBin = convert.getEngines().ffmpeg;
    const lengthOf = (file) => { try { execFileSync(ffmpegBin, ['-hide_banner', '-i', file], { windowsHide: true, stdio: 'pipe' }); } catch (e) { const m = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(String(e.stderr)); return m ? +m[1] * 3600 + +m[2] * 60 + parseFloat(m[3]) : 0; } return 0; };
    execFileSync(ffmpegBin, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10', '-t', '45', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('clip45.mp4')], { windowsHide: true });
    let gif;
    try { [gif] = await within(120000, convert.convertFile(f('clip45.mp4'), 'gif')); expect('a 45 s video becomes a 45 s GIF (no silent cut-off)', Math.abs(lengthOf(gif) - 45) < 1, `${lengthOf(gif)}s`); }
    catch (e) { expect('mp4 -> gif', false, e.message); }
    try { const [webp] = await within(60000, convert.convertFile(gif, 'webp')); const m = await sharp(webp, { animated: true }).metadata(); expect('animated GIF -> WebP keeps every frame', m.pages > 100, `${m.pages} frames`); }
    catch (e) { expect('gif -> webp', false, e.message); }
  }

  console.log('cancelling a long conversion stops the helper and leaves nothing behind');
  {
    const { execFileSync } = require('child_process');
    const ffmpegBin = convert.getEngines().ffmpeg;
    const src = f('long.mp4');
    execFileSync(ffmpegBin, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '90', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', src], { windowsHide: true });
    const running = () => execFileSync('tasklist', ['/FI', 'IMAGENAME eq ffmpeg.exe', '/NH'], { windowsHide: true }).toString().includes('ffmpeg.exe');
    const cjobs = new Jobs({ convert: (s, t, o) => convert.convertFile(s, t, o), concurrency: 3, maxStack: 3 });
    const before = fs.readdirSync(dir).length;
    cjobs.addConversion(src, 'webm', 'WEBM');
    await new Promise((r) => setTimeout(r, 2500));
    expect('the conversion is running', cjobs.batch[0].state === 'working' && running());
    const t0 = Date.now();
    cjobs.cancel(cjobs.batch[0].id);
    await new Promise((r) => setTimeout(r, 1500));
    expect('FFmpeg is gone within a moment', !running(), `${Date.now() - t0}ms`);
    expect('no partial output left in the folder', fs.readdirSync(dir).length === before, fs.readdirSync(dir).filter((n) => /^long.*webm/.test(n)).join(', '));
    expect('a cancelled job shows no card', cjobs.view().cards.length === 0);
  }

  console.log(failed() ? `\n${failed()} failed` : '\nall passed');
  sharp.cache(false);   // libvips keeps the clips it read open, and Windows will not delete an open file
  finish();
});

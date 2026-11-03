// SPDX-License-Identifier: AGPL-3.0-or-later
// Built-in converters: no Office needed. Documents, spreadsheets, PDFs and images.
const fs = require('fs');
const path = require('path');
const { uniquePath, tempPath, esc, readText } = require('../convert/util');
const pdf = require('./pdf');
const epub = require('./epub');

// The page margin has to be here: a CSS @page rule beats the margins passed to printToPDF, and with `margin: 0` the
// text used to run to the very edge of the sheet.
const BASE_CSS = `
  @page { margin: 17.8mm 20.3mm }
  body { font: 11pt/1.5 Calibri, "Segoe UI", Arial, sans-serif; color: #111; margin: 0 }
  h1 { font-size: 22pt; margin: 18pt 0 8pt } h2 { font-size: 16pt; margin: 14pt 0 6pt } h3 { font-size: 13pt }
  p { margin: 0 0 8pt } img { max-width: 100% } pre, code { font-family: Consolas, monospace; font-size: 10pt }
  pre { background: #f5f5f5; padding: 8pt; white-space: pre-wrap }
  table { border-collapse: collapse; margin: 6pt 0 } td, th { border: 1px solid #bbb; padding: 3pt 6pt; vertical-align: top }
  blockquote { margin: 8pt 0 8pt 12pt; padding-left: 10pt; border-left: 3px solid #ccc; color: #444 }`;

// base: file:// URL of the source's folder, so images next to a .md/.html file resolve
const wrapHtml = (body, title, css = '', base = '') =>
  `<!doctype html><html><head><meta charset="utf-8">${base ? `<base href="${esc(base)}">` : ''}<title>${esc(title)}</title><style>${BASE_CSS}${css}</style></head><body>${body}</body></html>`;

const baseHrefOf = (file) => require('url').pathToFileURL(path.dirname(file) + path.sep).href;

// Add a <base> to a complete HTML document (unless it has one already).
function withBase(html, href) {
  if (/<base\b/i.test(html)) return html;
  const tag = `<base href="${esc(href)}">`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + tag) : tag + html;
}

// The page that gets printed is built from a user's document, so it must not be able to call out to the internet
// (remote images, tracking pixels). Local files stay readable.
let printSession;
function offlineSession() {
  if (!printSession) {
    printSession = require('electron').session.fromPartition('pomelo-print');
    printSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] }, (_details, callback) => callback({ cancel: true }));
  }
  return printSession;
}

async function htmlToPdf(html, out, { landscape = false } = {}) {
  const { BrowserWindow } = require('electron');
  const file = tempPath('html');
  fs.writeFileSync(file, html, 'utf8');
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false, session: offlineSession() } });
  try {
    await win.loadFile(file);
    const buf = await win.webContents.printToPDF({
      pageSize: 'A4', landscape, printBackground: true, preferCSSPageSize: true,   // a document that states its own page size keeps it
      margins: { top: 0.7, bottom: 0.7, left: 0.8, right: 0.8 },
    });
    fs.writeFileSync(out, buf);
  } finally {
    win.destroy();
    fs.rmSync(file, { force: true });
  }
}

// ---- PDF blocks -> text formats -------------------------------------------------------------
const flat = (pages) => pages.flat();

function blocksToHtml(pages, title) {
  let html = '', inList = false;
  for (const b of flat(pages)) {
    if (b.type !== 'li' && inList) { html += '</ul>'; inList = false; }
    if (b.type === 'li') { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${esc(b.text)}</li>`; }
    else html += `<${b.type}>${esc(b.text)}</${b.type}>`;
  }
  return wrapHtml(html + (inList ? '</ul>' : ''), title);
}

const blocksToMd = (pages) => flat(pages).map((b) => (b.type === 'h1' ? '# ' : b.type === 'h2' ? '## ' : b.type === 'li' ? '- ' : '') + b.text)
  .join('\n').replace(/^(- .*)\n(?=[^-])/gm, '$1\n\n').replace(/\n(?=#)/g, '\n\n') + '\n';

const blocksToTxt = (pages) => pages.map((p) => p.map((b) => (b.type === 'li' ? '• ' : '') + b.text).join('\n\n')).join('\n\n') + '\n';

async function blocksToDocx(pages) {
  const { Document, Packer, Paragraph, HeadingLevel } = require('docx');
  const kids = flat(pages).map((b) => new Paragraph(
    b.type === 'h1' ? { text: b.text, heading: HeadingLevel.HEADING_1 }
      : b.type === 'h2' ? { text: b.text, heading: HeadingLevel.HEADING_2 }
        : b.type === 'li' ? { text: b.text, bullet: { level: 0 } }
          : { text: b.text, spacing: { after: 140 } }));
  return Packer.toBuffer(new Document({ sections: [{ children: kids }] }));
}

async function htmlToDocx(html) {
  const HTMLtoDOCX = require('html-to-docx');
  html = html.replace(/<img\b[^>]*\bsrc\s*=\s*["']https?:[^>]*>/gi, '');     // html-to-docx would download remote images
  const out = await HTMLtoDOCX(html, null, { table: { row: { cantSplit: true } }, footer: false, pageNumber: false });
  return Buffer.from(out);
}

function htmlToMd(html) {
  const TurndownService = require('turndown');
  const { gfm } = require('turndown-plugin-gfm');
  const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' });
  td.use(gfm);
  return td.turndown(html).trim() + '\n';
}

function htmlToTxt(html) {
  return require('html-to-text').convert(html, { wordwrap: false, selectors: [{ selector: 'img', format: 'skip' }] }).trim() + '\n';
}

const txtToHtml = (text, title) => wrapHtml(
  text.replace(/\r\n?/g, '\n').split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join(''), title);

// What a .docx says about its own page and default text, so a printed copy gets the same paper size, margins, font and
// size instead of Pomelo's defaults. Anything missing or odd is simply left out.
async function docxLook(src) {
  try {
    const zip = await require('jszip').loadAsync(fs.readFileSync(src));
    const doc = await zip.file('word/document.xml').async('string');
    const styles = zip.file('word/styles.xml') ? await zip.file('word/styles.xml').async('string') : '';
    const attr = (tag, name) => { const m = new RegExp(`${name}="(-?\\d+)"`).exec(tag || ''); return m ? +m[1] : null; };
    const mm = (twips) => `${(twips / 1440 * 25.4).toFixed(1)}mm`;
    const tags = (re, text) => [...text.matchAll(re)].map((m) => m[0]);
    const pgSz = tags(/<w:pgSz\b[^>]*>/g, doc).pop();
    const pgMar = tags(/<w:pgMar\b[^>]*>/g, doc).pop();
    let css = '';
    const w = attr(pgSz, 'w:w'), h = attr(pgSz, 'w:h');
    if (w > 4000 && h > 4000) css += `@page { size: ${mm(w)} ${mm(h)}; margin: ${['top', 'right', 'bottom', 'left'].map((s) => mm(Math.max(0, attr(pgMar, `w:${s}`) ?? 1134))).join(' ')} }`;
    const normal = /<w:style\b[^>]*w:styleId="Normal"[\s\S]*?<\/w:style>/.exec(styles)?.[0] || '';
    const defaults = /<w:docDefaults>[\s\S]*?<\/w:docDefaults>/.exec(styles)?.[0] || '';
    const font = /w:ascii="([^"]+)"/.exec(normal)?.[1] || /w:ascii="([^"]+)"/.exec(defaults)?.[1];
    const half = attr(/<w:sz\b[^>]*>/.exec(normal)?.[0], 'w:val') || attr(/<w:sz\b[^>]*>/.exec(defaults)?.[0], 'w:val');
    if (font || half) css += ` body { ${font ? `font-family: "${font.replace(/"/g, '')}", Calibri, "Segoe UI", Arial, sans-serif;` : ''} ${half ? `font-size: ${half / 2}pt;` : ''} }`;
    return css;
  } catch { return ''; }
}

// Normalised HTML for any document source.
async function sourceToHtml(src, from) {
  const title = path.basename(src);
  if (from === 'docx') return wrapHtml((await require('mammoth').convertToHtml({ path: src })).value, title, await docxLook(src));
  if (from === 'md') return wrapHtml(require('marked').marked.parse(readText(src)), title, '', baseHrefOf(src));
  if (from === 'html') return withBase(readText(src), baseHrefOf(src));
  if (from === 'txt') return txtToHtml(readText(src), title);
  if (from === 'epub') { const book = await epub.read(src); return wrapHtml(book.body, book.title); }
  throw new Error(`Cannot read .${from}`);
}

// ---- spreadsheets ---------------------------------------------------------------------------
const SHEET_EXT = ['xlsx', 'xls', 'ods', 'csv', 'tsv'];

function readWorkbook(src, from) {
  const XLSX = require('xlsx');
  if (from === 'xlsx' || from === 'ods') {         // both are ZIP packages; anything else is a renamed file, not a workbook
    const head = Buffer.alloc(2);
    const fd = fs.openSync(src, 'r');
    try { fs.readSync(fd, head, 0, 2, 0); } finally { fs.closeSync(fd); }
    if (head[0] !== 0x50 || head[1] !== 0x4b) throw new Error(`This is not a valid .${from} file`);
  }
  if (from === 'csv' || from === 'tsv') {
    let t = readText(src);
    const head = t.split('\n', 1)[0];
    const FS = [',', ';', '\t', '|'].map((c) => [c, head.split(c).length]).sort((a, b) => b[1] - a[1])[0][0];
    return XLSX.read(t, { type: 'string', FS: from === 'tsv' ? '\t' : FS });
  }
  return XLSX.readFile(src, { cellDates: true });
}

const safe = (s) => String(s).replace(/[\\/:*?"<>|]/g, '_').trim() || 'Sheet';

function sheetsToHtml(wb, title) {
  const XLSX = require('xlsx');
  const many = wb.SheetNames.length > 1;
  const css = 'td{font-size:9pt}th,td{white-space:nowrap}h2{break-before:page}h2:first-child{break-before:auto}';
  const body = wb.SheetNames.map((n) => {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: '' });
    const table = `<table>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table>`;
    return (many ? `<h2>${esc(n)}</h2>` : '') + table;
  }).join('');
  return wrapHtml(body, title, css);
}

async function sheetRun({ src, from, to, dir, base }) {
  const XLSX = require('xlsx');
  const wb = readWorkbook(src, from);
  if (to === 'xlsx' || to === 'xls' || to === 'ods') {
    const out = uniquePath(dir, base, to);
    fs.writeFileSync(out, XLSX.write(wb, { bookType: to === 'xls' ? 'biff8' : to, type: 'buffer', cellDates: true }));
    return [out];
  }
  if (to === 'csv' || to === 'tsv') {
    const FS = to === 'tsv' ? '\t' : ',';
    return wb.SheetNames.map((n) => {
      const out = uniquePath(dir, wb.SheetNames.length > 1 ? `${base} - ${safe(n)}` : base, to);
      fs.writeFileSync(out, '\uFEFF' + XLSX.utils.sheet_to_csv(wb.Sheets[n], { FS }), 'utf8');   // BOM: Excel opens UTF-8 correctly
      return out;
    });
  }
  if (to === 'json') {
    const data = Object.fromEntries(wb.SheetNames.map((n) => [n, XLSX.utils.sheet_to_json(wb.Sheets[n], { defval: null })]));
    const out = uniquePath(dir, base, 'json');
    fs.writeFileSync(out, JSON.stringify(wb.SheetNames.length === 1 ? data[wb.SheetNames[0]] : data, null, 2), 'utf8');
    return [out];
  }
  const html = sheetsToHtml(wb, base);
  const out = uniquePath(dir, base, to);
  if (to === 'html') { fs.writeFileSync(out, html, 'utf8'); return [out]; }
  const widest = Math.max(...wb.SheetNames.map((n) => XLSX.utils.decode_range(wb.Sheets[n]['!ref'] || 'A1').e.c + 1));
  await htmlToPdf(html, out, { landscape: widest > 7 });
  return [out];
}

// ---- images ---------------------------------------------------------------------------------
async function sharpInput(src, from, animated = false) {
  const sharp = require('sharp');
  if (from === 'bmp') {   // libvips has no BMP reader; Chromium does
    const img = require('electron').nativeImage.createFromPath(src);
    if (img.isEmpty()) throw new Error('Could not read this BMP');
    return sharp(img.toPNG());
  }
  if (from === 'heic') {  // WASM libheif decoder
    const png = await require('heic-convert')({ buffer: fs.readFileSync(src), format: 'PNG' });
    return sharp(Buffer.from(png));
  }
  return sharp(src, { density: from === 'svg' ? 192 : undefined, animated });
}

async function toBmp(img) {
  const { data, info } = await img.flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const rowSize = Math.ceil((info.width * 3) / 4) * 4;
  const buf = Buffer.alloc(54 + rowSize * info.height);
  buf.write('BM'); buf.writeUInt32LE(buf.length, 2); buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14); buf.writeInt32LE(info.width, 18); buf.writeInt32LE(info.height, 22);
  buf.writeUInt16LE(1, 26); buf.writeUInt16LE(24, 28); buf.writeUInt32LE(rowSize * info.height, 34);
  for (let y = 0; y < info.height; y++) {
    const rowStart = 54 + (info.height - 1 - y) * rowSize;
    for (let x = 0; x < info.width; x++) {
      const s = (y * info.width + x) * 3;
      buf[rowStart + x * 3] = data[s + 2]; buf[rowStart + x * 3 + 1] = data[s + 1]; buf[rowStart + x * 3 + 2] = data[s];
    }
  }
  return buf;
}

async function imageToPdf(img, out) {
  const { PDFDocument } = require('pdf-lib');
  const png = await img.png().toBuffer({ resolveWithObject: true });
  const doc = await PDFDocument.create();
  const embedded = await doc.embedPng(png.data);
  const k = Math.min(0.75, 842 / Math.max(png.info.width, png.info.height));   // px -> pt, capped to ~A4
  const page = doc.addPage([png.info.width * k, png.info.height * k]);
  page.drawImage(embedded, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
  fs.writeFileSync(out, await doc.save());
}

async function imageRun({ src, from, to, dir, base }) {
  const moving = (from === 'gif' || from === 'webp') && (to === 'gif' || to === 'webp');   // keep every frame; other targets take the first
  const img = await sharpInput(src, from, moving);
  const out = uniquePath(dir, base, to);
  if (to === 'bmp') fs.writeFileSync(out, await toBmp(img));
  else if (to === 'pdf') await imageToPdf(img, out);
  else if (to === 'jpg') await img.flatten({ background: '#ffffff' }).jpeg({ quality: 92, mozjpeg: true }).toFile(out);
  else if (to === 'png') await img.png().toFile(out);
  else if (to === 'webp') await img.webp({ quality: 90 }).toFile(out);
  else if (to === 'avif') await img.avif({ quality: 60 }).toFile(out);
  else if (to === 'tiff') await img.tiff({ compression: 'lzw' }).toFile(out);
  else if (to === 'gif') await img.gif({ effort: 7 }).toFile(out);
  return [out];
}

// ---- PDF source -----------------------------------------------------------------------------
// One image per slide, slide size = page size. Looks identical but is not editable text (LibreOffice gives editable slides).
async function pdfToPptx({ src, dir, base, onProgress }) {
  const PptxGenJS = require('pptxgenjs');
  const sharp = require('sharp');
  const DPI = 150;
  const pages = await pdf.renderPages(src, 'jpg', DPI, onProgress);
  const meta = await sharp(pages[0]).metadata();
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'PDF', width: meta.width / DPI, height: meta.height / DPI });
  pptx.layout = 'PDF';
  for (const buf of pages) {
    const m = await sharp(buf).metadata();
    pptx.addSlide().addImage({ data: 'image/jpeg;base64,' + buf.toString('base64'), x: 0, y: 0, w: m.width / DPI, h: m.height / DPI });
  }
  const out = uniquePath(dir, base, 'pptx');
  await pptx.writeFile({ fileName: out });
  return [out];
}

async function pdfRun({ src, to, dir, base, onProgress }) {
  if (to === 'pptx') return pdfToPptx({ src, dir, base, onProgress });
  if (to === 'png' || to === 'jpg') {
    const pages = await pdf.renderPages(src, to, 200, onProgress);
    if (pages.length === 1) { const out = uniquePath(dir, base, to); fs.writeFileSync(out, pages[0]); return [out]; }
    const folder = uniquePath(dir, `${base} (${to.toUpperCase()})`, '');
    fs.mkdirSync(folder);
    return pages.map((buf, i) => { const out = path.join(folder, `${base}-${i + 1}.${to}`); fs.writeFileSync(out, buf); return out; });
  }
  const { pages } = await pdf.extractBlocks(src, onProgress);
  const out = uniquePath(dir, base, to);
  if (to === 'epub') { await epub.write(blocksToHtml(pages, base), { title: base }, out); return [out]; }
  if (to === 'txt') fs.writeFileSync(out, blocksToTxt(pages), 'utf8');
  else if (to === 'md') fs.writeFileSync(out, blocksToMd(pages), 'utf8');
  else if (to === 'html') fs.writeFileSync(out, blocksToHtml(pages, base), 'utf8');
  else if (to === 'docx') fs.writeFileSync(out, await blocksToDocx(pages));
  return [out];
}

// ---- documents ------------------------------------------------------------------------------
// Legacy .doc without Office: pull out the text only (no styling) and reuse the PDF-block writers.
async function legacyDocRun({ src, to, dir, base }) {
  const WordExtractor = require('word-extractor');
  const body = (await new WordExtractor().extract(src)).getBody();
  const paras = body.split(new RegExp('[' + String.fromCharCode(13, 10) + ']+')).map((t) => t.trim()).filter(Boolean).map((text) => ({ type: 'p', text }));
  if (!paras.length) throw new Error('No text found in this .doc file');
  const pages = [paras];
  const out = uniquePath(dir, base, to);
  if (to === 'txt') fs.writeFileSync(out, blocksToTxt(pages), 'utf8');
  else if (to === 'md') fs.writeFileSync(out, blocksToMd(pages), 'utf8');
  else if (to === 'html') fs.writeFileSync(out, blocksToHtml(pages, base), 'utf8');
  else if (to === 'docx') fs.writeFileSync(out, await blocksToDocx(pages));
  else if (to === 'pdf') await htmlToPdf(blocksToHtml(pages, base), out);
  return [out];
}

async function docRun({ src, from, to, dir, base }) {
  if (from === 'doc') return legacyDocRun({ src, to, dir, base });
  const out = uniquePath(dir, base, to);
  if (from === 'docx' && to === 'txt') { fs.writeFileSync(out, (await require('mammoth').extractRawText({ path: src })).value, 'utf8'); return [out]; }
  if (from === 'txt' && to === 'epub') { await epub.write(txtToHtml(readText(src), base), { title: base }, out); return [out]; }
  if (from === 'md' && to === 'txt') { fs.writeFileSync(out, htmlToTxt(require('marked').marked.parse(readText(src))), 'utf8'); return [out]; }
  if (from === 'txt' && to === 'docx') {
    const { Document, Packer, Paragraph } = require('docx');
    const kids = readText(src).replace(/\r\n?/g, '\n').split('\n').map((l) => new Paragraph({ text: l }));
    fs.writeFileSync(out, await Packer.toBuffer(new Document({ sections: [{ children: kids }] })));
    return [out];
  }
  const html = await sourceToHtml(src, from);
  if (to === 'epub') { await epub.write(html, { title: base }, out); return [out]; }
  if (to === 'html') fs.writeFileSync(out, html, 'utf8');
  else if (to === 'md') fs.writeFileSync(out, htmlToMd(html), 'utf8');
  else if (to === 'txt') fs.writeFileSync(out, htmlToTxt(html), 'utf8');
  else if (to === 'docx') fs.writeFileSync(out, await htmlToDocx(html));
  else if (to === 'pdf') await htmlToPdf(from === 'txt' ? html.replace('<style>', '<style>body{font-family:Consolas,monospace;font-size:10pt}') : html, out);
  return [out];
}

// ---- dispatch -------------------------------------------------------------------------------
const DOC_TO = {
  doc: ['pdf', 'docx', 'txt', 'md', 'html'], docx: ['pdf', 'txt', 'md', 'html', 'epub'], txt: ['pdf', 'docx', 'md', 'html', 'epub'],
  md: ['pdf', 'docx', 'html', 'txt', 'epub'], html: ['pdf', 'docx', 'md', 'txt', 'epub'], epub: ['pdf', 'docx', 'md', 'txt', 'html'],
};
const SHEET_TO = ['xlsx', 'xls', 'ods', 'csv', 'tsv', 'html', 'json', 'pdf'];
const IMG_FROM = ['png', 'jpg', 'webp', 'bmp', 'gif', 'tiff', 'avif', 'svg', 'heic'];
const IMG_TO = ['png', 'jpg', 'webp', 'avif', 'tiff', 'bmp', 'gif', 'pdf'];

module.exports = {
  name: 'pure',
  supports(from, to) {
    if (from === to) return false;
    if (DOC_TO[from]) return DOC_TO[from].includes(to);
    if (from === 'pdf') return ['txt', 'md', 'html', 'docx', 'png', 'jpg', 'epub', 'pptx'].includes(to);
    if (SHEET_EXT.includes(from)) return SHEET_TO.includes(to);
    if (IMG_FROM.includes(from)) return IMG_TO.includes(to);
    return false;
  },
  run(job) {
    const { from } = job;
    if (from === 'pdf') return pdfRun(job);
    if (SHEET_EXT.includes(from)) return sheetRun(job);
    if (IMG_FROM.includes(from)) return imageRun(job);
    return docRun(job);
  },
};

// SPDX-License-Identifier: AGPL-3.0-or-later
// Built-in converters for documents: DOCX, Markdown, HTML, plain text and EPUB, read into HTML and written out from there.
const fs = require('fs');
const path = require('path');
const { uniquePath } = require('../../engine-kit/outputs');
const epub = require('../../lib/epub');
const { wrapHtml, baseHrefOf, withBase, htmlToDocx, htmlToMd, htmlToTxt, txtToHtml } = require('../../lib/html');
const { htmlToPdf } = require('../../lib/print-pdf');
const { readText } = require('#shared/node/fs');
const legacyDoc = require('./legacy-doc');

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

async function run({ src, from, to, dir, base }) {
  if (from === 'doc') return legacyDoc.run({ src, to, dir, base });
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

const DOC_TO = {
  doc: ['pdf', 'docx', 'txt', 'md', 'html'], docx: ['pdf', 'txt', 'md', 'html', 'epub'], txt: ['pdf', 'docx', 'md', 'html', 'epub'],
  md: ['pdf', 'docx', 'html', 'txt', 'epub'], html: ['pdf', 'docx', 'md', 'txt', 'epub'], epub: ['pdf', 'docx', 'md', 'txt', 'html'],
};

module.exports = { reads: (from) => !!DOC_TO[from], writes: (from) => DOC_TO[from], run };

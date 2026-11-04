// SPDX-License-Identifier: AGPL-3.0-or-later
// Built-in converters for PDFs (pdf.js): text formats and EPUB from the extracted blocks, pages as images, and one image per slide.
const fs = require('fs');
const path = require('path');
const { uniquePath } = require('../../engine-kit/outputs');
const pdf = require('../../lib/pdfjs');
const epub = require('../../lib/epub');
const { newDeck } = require('../../lib/pptx');
const { blocksToHtml, writeBlocks } = require('../../lib/text-blocks');

// One image per slide, slide size = page size. Looks identical but is not editable text (LibreOffice gives editable slides).
async function pdfToPptx({ src, dir, base, onProgress }) {
  const sharp = require('sharp');
  const DPI = 150;
  const pages = await pdf.renderPages(src, 'jpg', DPI, onProgress);
  const meta = await sharp(pages[0]).metadata();
  const pptx = newDeck(meta.width / DPI, meta.height / DPI);
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
  await writeBlocks(pages, to, out, base);
  return [out];
}

const PDF_TO = ['txt', 'md', 'html', 'docx', 'png', 'jpg', 'epub', 'pptx'];

module.exports = { reads: (from) => from === 'pdf', writes: () => PDF_TO, run: pdfRun };

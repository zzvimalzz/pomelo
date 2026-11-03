// SPDX-License-Identifier: AGPL-3.0-or-later
// PDF reading: structured text extraction and page rendering (pdfjs-dist + @napi-rs/canvas).
const fs = require('fs');
const path = require('path');

let pdfjsPromise;
const getPdfjs = () => (pdfjsPromise ||= import('pdfjs-dist/legacy/build/pdf.mjs'));

const pdfjsRoot = () => path.dirname(require.resolve('pdfjs-dist/package.json'));
const asDir = (p) => p.replace(/\\/g, '/').replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked') + '/';

async function openPdf(file) {
  const pdfjs = await getPdfjs();
  const data = new Uint8Array(fs.readFileSync(file));
  const root = pdfjsRoot();
  const task = pdfjs.getDocument({
    data,
    verbosity: 0,
    isEvalSupported: false,
    standardFontDataUrl: asDir(path.join(root, 'standard_fonts')),
    cMapUrl: asDir(path.join(root, 'cmaps')),
    cMapPacked: true,
  });
  const doc = await task.promise;
  doc.release = () => task.destroy();
  return doc;
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 12; };

// Rebuild lines -> paragraphs -> headings/list items from positioned text runs.
function pageToBlocks(items, bodySize) {
  const runs = items.filter((i) => i.str && i.str.trim() !== '' || i.str === ' ')
    .map((i) => ({ s: i.str, x: i.transform[4], y: i.transform[5], size: Math.hypot(i.transform[0], i.transform[1]) || i.height || 10, w: i.width }));
  const lines = [];
  for (const r of runs.sort((a, b) => b.y - a.y || a.x - b.x)) {
    const line = lines.find((l) => Math.abs(l.y - r.y) <= Math.max(2, r.size * 0.35));
    if (line) line.runs.push(r); else lines.push({ y: r.y, runs: [r] });
  }
  lines.sort((a, b) => b.y - a.y);
  const out = [];
  for (const l of lines) {
    l.runs.sort((a, b) => a.x - b.x);
    let text = '';
    let prevEnd = null;
    for (const r of l.runs) {
      if (prevEnd !== null && r.x - prevEnd > r.size * 0.2 && !text.endsWith(' ') && !r.s.startsWith(' ')) text += ' ';
      text += r.s;
      prevEnd = r.x + r.w;
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const size = Math.max(...l.runs.map((r) => r.size));
    out.push({ text, size, y: l.y });
  }
  const blocks = [];
  let prev = null;
  for (const l of out) {
    const ratio = l.size / bodySize;
    const type = ratio >= 1.6 ? 'h1' : ratio >= 1.25 ? 'h2' : /^([•●▪◦·\-–—*]|\d{1,2}[.)])\s+/.test(l.text) ? 'li' : 'p';
    const gap = prev ? prev.y - l.y : 0;
    const joinable = prev && type === 'p' && prev.type === 'p' && gap < l.size * 1.7 && Math.abs(prev.size - l.size) < 1;
    if (joinable) {
      blocks[blocks.length - 1].text += (blocks[blocks.length - 1].text.endsWith('-') ? '' : ' ') + l.text;
    } else {
      blocks.push({ type, text: l.text.replace(/^([•●▪◦·]|[-–—*])\s+/, '') });
    }
    prev = { type, y: l.y, size: l.size };
  }
  return blocks;
}

// -> { pages: [[{type:'h1'|'h2'|'p'|'li', text}]], count }
async function extractBlocks(file) {
  const doc = await openPdf(file);
  try {
    const contents = [];
    const sizes = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const tc = await page.getTextContent();
      contents.push(tc.items);
      for (const i of tc.items) if (i.str && i.str.trim()) for (let k = 0; k < Math.min(i.str.length, 40); k++) sizes.push(Math.hypot(i.transform[0], i.transform[1]));
    }
    const body = median(sizes);
    const pages = contents.map((items) => pageToBlocks(items, body));
    if (!pages.some((p) => p.length)) {
      throw new Error('This PDF has no selectable text (it looks scanned). OCR is not supported yet.');
    }
    return { pages, count: doc.numPages };
  } finally { await doc.release(); }
}

// Render pages to image buffers. format: 'png' | 'jpg'. dpi default 200.
async function renderPages(file, format, dpi = 200) {
  const doc = await openPdf(file);
  try {
    const bufs = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: dpi / 72 });
      const { canvas, context } = doc.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport, canvas }).promise;
      bufs.push(format === 'jpg' ? canvas.toBuffer('image/jpeg', 92) : canvas.toBuffer('image/png'));
      page.cleanup();
    }
    return bufs;
  } finally { await doc.release(); }
}

module.exports = { extractBlocks, renderPages };

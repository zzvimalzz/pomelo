// SPDX-License-Identifier: AGPL-3.0-or-later
// PDF to PowerPoint through the Python helper: slides that look like the pages.
const fs = require('fs');
const path = require('path');
const { uniquePath } = require('../../engine-kit/outputs');
const { runHelper } = require('../../engine-kit/python');
const { scaled } = require('../../engine-kit/progress');
const { mimeOf } = require('../../lib/mime');
const { newDeck } = require('../../lib/pptx');
const { withTempDir } = require('#shared/node/fs');

// Slides that look like the pages: each page's pictures, shapes and backgrounds as one picture behind the text, and the
// text as real text boxes at the same places, fonts, sizes and colours, links included.
async function pdfToPptx({ src, dir, base, engines, onProgress }) {
  return withTempDir(async (tmp) => {
    await runHelper(engines.pdf, 'pdf_to_layout.py', [src, tmp], { src, onProgress: scaled(onProgress, 0, 0.9) });
    const layout = JSON.parse(fs.readFileSync(path.join(tmp, 'layout.json'), 'utf8'));
    const pages = layout.pages;
    if (!pages.length) throw new Error('This PDF has no pages');
    const W = pages[0].w / 72, H = pages[0].h / 72;                      // one slide size for the whole deck: the first page's
    const pptx = newDeck(W, H, layout.title);
    pages.forEach((page, i) => {
      const slide = pptx.addSlide();
      const k = Math.min(W * 72 / page.w, H * 72 / page.h);              // a page of another size is scaled to fit and centred
      const ox = (W * 72 - page.w * k) / 2, oy = (H * 72 - page.h * k) / 2;
      if (page.background) {
        const buf = fs.readFileSync(path.join(tmp, page.background));
        const mime = mimeOf(path.extname(page.background).slice(1)) || 'image/jpeg';
        slide.addImage({ data: `${mime};base64,${buf.toString('base64')}`, x: ox / 72, y: oy / 72, w: page.w * k / 72, h: page.h * k / 72 });
      }
      for (const t of page.texts) {
        const size = t.size * k;
        const top = (t.baseline - t.ascender * t.size) * k + oy;
        const runs = t.runs.map((r) => ({ text: r.text, options: { fontFace: r.font, fontSize: Math.round(r.size * k * 10) / 10, bold: r.bold, italic: r.italic, color: r.color, ...(r.link ? { hyperlink: { url: r.link } } : {}) } }));
        // the box is wider than the text (x1.4 and 24 pt): a wider substitute font must not wrap
        slide.addText(runs, { x: (t.x * k + ox) / 72, y: top / 72, w: ((t.width * 1.4 + 24) * k) / 72, h: (size * 1.25) / 72, margin: 0, valign: 'top', wrap: false, fit: 'none', paraSpaceBefore: 0, paraSpaceAfter: 0 });
      }
      if (onProgress) onProgress(0.9 + 0.09 * ((i + 1) / pages.length));
    });
    const out = uniquePath(dir, base, 'pptx');
    await pptx.writeFile({ fileName: out });
    return [out];
  });
}

module.exports = { pdfToPptx };

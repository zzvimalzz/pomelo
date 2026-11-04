// SPDX-License-Identifier: AGPL-3.0-or-later
// PDF conversion through Python packages, each run as a separate process:
//   PyMuPDF     (AGPL-3.0) reads the PDF: PDF -> DOCX (scripts/pdf_flow.py: real paragraphs, lists and tables, always editable),
//                          Markdown / HTML / text / EPUB (reading order), XLSX (tables found by its table finder, written to Excel
//                          here) and PowerPoint (text boxes on a picture of the rest)
//   python-docx (MIT)      writes the Word file
//   RapidOCR    (Apache-2.0) reads scanned pages first, so every route above also works on a scan (scripts/pdf_ocr.py)
// Environment: Pomelo's Install button creates one in %LOCALAPPDATA%\Pomelo\engines\pyenv (see engineInstaller.js);
// `npm run setup:pdf` creates vendor/pyenv for development; an existing system Python with the packages also works.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { run, uniquePath } = require('../convert/util');
const { withTempDir, withTempFile } = require('../../shared/node/fs');
const { pyenvPython, scriptPath: script, vendorRoots } = require('../../shared/node/paths');

function pythons() {
  const envs = [pyenvPython(), ...vendorRoots().map((v) => pyenvPython(v))];   // the one Pomelo installs, then a developer's vendor/pyenv
  return [...envs.filter((p) => fs.existsSync(p)), 'python', 'py'];
}

// First Python that can import `modules`, or null.
function find(modules) {
  for (const py of pythons()) {
    try {
      execFileSync(py, ['-W', 'ignore', '-c', `import ${modules}`], { windowsHide: true, timeout: 30000, stdio: 'ignore' });
      return py;
    } catch { /* try the next one */ }
  }
  return null;
}

const detect = () => find('pymupdf, docx');
const detectOcr = () => find('rapidocr');
const detectHeic = () => find('pillow_heif, PIL');

// Turns the helper scripts' output into a 0..1 progress figure: they print "POMELO_PROGRESS 0.4" as they go.
function progressReader(onProgress) {
  if (!onProgress) return undefined;
  return (line) => {
    const own = /^POMELO_PROGRESS ([0-9.]+)/.exec(line);
    if (own) onProgress(Math.min(0.99, +own[1]));
  };
}

// A long PDF (or a scan, which is read page by page) needs longer than a short one: ten minutes, and two more for every ten pages.
function timeoutFor(src) {
  let pages = 1;
  try { pages = Math.max(1, Math.ceil(fs.statSync(src).size / 60000)); } catch { /* the helper reports a missing file */ }
  return Math.min(4 * 3600 * 1000, 600000 + Math.ceil(pages / 10) * 120000);
}

const isNumber = (s) => /^-?(0|[1-9]\d{0,14})([.,]\d+)?$/.test(s);

// Markdown, HTML, plain text and EPUB all come from one reading of the PDF (scripts/pdf_structure_run.py), so they
// agree: all of the text in reading order, headings, lists, tables, links, bold and italic, code and pictures.
async function pdfToText({ src, to, dir, base, engines, onProgress }) {
  const opts = { timeout: timeoutFor(src), onLine: progressReader(onProgress) };
  if (to === 'epub') {
    return withTempFile('html', async (tmp) => {
      await run(engines.pdf, ['-W', 'ignore', script('pdf_structure_run.py'), src, tmp, 'html'], opts);
      const out = uniquePath(dir, base, 'epub');
      await require('./epub').write(fs.readFileSync(tmp, 'utf8'), { title: base }, out);
      return [out];
    });
  }
  const out = uniquePath(dir, base, to);
  const args = ['-W', 'ignore', script('pdf_structure_run.py'), src, out, to];
  if (to === 'md') args.push(uniquePath(dir, `${base}_images`, ''));   // made only when the PDF has pictures worth keeping
  await run(engines.pdf, args, opts);
  if (!fs.existsSync(out)) throw new Error('PDF engine produced no output');
  return [out];
}

// Slides that look like the pages: each page's pictures, shapes and backgrounds as one picture behind the text, and the
// text as real text boxes at the same places, fonts, sizes and colours, links included.
async function pdfToPptx({ src, dir, base, engines, onProgress }) {
  const PptxGenJS = require('pptxgenjs');
  return withTempDir(async (tmp) => {
    await run(engines.pdf, ['-W', 'ignore', script('pdf_pptx_export.py'), src, tmp], { timeout: timeoutFor(src), onLine: progressReader(onProgress && ((f) => onProgress(f * 0.9))) });
    const layout = JSON.parse(fs.readFileSync(path.join(tmp, 'layout.json'), 'utf8'));
    const pages = layout.pages;
    if (!pages.length) throw new Error('This PDF has no pages');
    const W = pages[0].w / 72, H = pages[0].h / 72;                      // one slide size for the whole deck: the first page's
    const pptx = new PptxGenJS();
    pptx.defineLayout({ name: 'PDF', width: W, height: H });
    pptx.layout = 'PDF';
    if (layout.title) pptx.title = layout.title;
    pages.forEach((page, i) => {
      const slide = pptx.addSlide();
      const k = Math.min(W * 72 / page.w, H * 72 / page.h);              // a page of another size is scaled to fit and centred
      const ox = (W * 72 - page.w * k) / 2, oy = (H * 72 - page.h * k) / 2;
      if (page.background) {
        const buf = fs.readFileSync(path.join(tmp, page.background));
        const mime = page.background.endsWith('png') ? 'image/png' : 'image/jpeg';
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

async function pdfToXlsx({ src, dir, base, engines, onProgress }) {
  const XLSX = require('xlsx');
  return withTempFile('json', async (tmp) => {
    await run(engines.pdf, ['-W', 'ignore', script('pdf_tables_run.py'), src, tmp], { timeout: timeoutFor(src), onLine: progressReader(onProgress) });
    const tables = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    if (!tables.length) throw new Error('This PDF has no text to put in a spreadsheet');
    const wb = XLSX.utils.book_new();
    for (const t of tables) {
      const rows = t.rows.map((r) => r.map((c) => (isNumber(c) ? Number(c.replace(',', '.')) : c)));
      const sheet = XLSX.utils.aoa_to_sheet(rows);
      sheet['!cols'] = Array.from({ length: Math.max(...rows.map((r) => r.length)) }, (_, i) => ({ wch: Math.min(60, Math.max(8, ...rows.map((r) => String(r[i] ?? '').length)) + 2) }));
      XLSX.utils.book_append_sheet(wb, sheet, t.kind === 'text' ? `P${t.page} text` : `P${t.page} T${t.index}`);
    }
    const out = uniquePath(dir, base, 'xlsx');
    fs.writeFileSync(out, XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }));
    return [out];
  });
}

module.exports = {
  name: 'pdf-hifi',
  detect,
  detectOcr,
  detectHeic,
  supports: (from, to, engines) => from === 'pdf' && !!engines.pdf && ['docx', 'xlsx', 'pptx', 'md', 'html', 'txt', 'epub'].includes(to),
  async run(job) {
    const { src, to, dir, base, engines, onProgress } = job;
    if (to === 'xlsx') return pdfToXlsx(job);
    if (to === 'pptx') return pdfToPptx(job);
    if (to !== 'docx') return pdfToText(job);
    const out = uniquePath(dir, base, to);
    await run(engines.pdf, ['-W', 'ignore', script('pdf_to_docx.py'), src, out], { timeout: timeoutFor(src), onLine: progressReader(onProgress) });
    if (!fs.existsSync(out)) throw new Error('PDF engine produced no output');
    return [out];
  },
};

// SPDX-License-Identifier: AGPL-3.0-or-later
// High-fidelity PDF conversion through Python packages, each run as a separate process:
//   pdf2docx    (MIT)       PDF -> DOCX that keeps fonts, colours, tables, images and spacing
//   PyMuPDF     (AGPL-3.0) PDF -> Markdown / HTML / text / EPUB (its text layer, read in reading order) and
//                          PDF -> XLSX (tables found by its table finder, written to Excel here)
// Environment: Pomelo's Install button creates one in %LOCALAPPDATA%\Pomelo\engines\pyenv (see engineInstaller.js);
// `npm run setup:pdf` creates vendor/pyenv for development; an existing system Python with the packages also works.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { run, uniquePath, tempPath } = require('../convert/util');
const { pyenvPython } = require('../enginesDir');

const unpacked = (p) => p.replace('app.asar', 'app.asar.unpacked');
const ROOT = path.join(__dirname, '..', '..', '..');
const script = (name) => unpacked(path.join(ROOT, 'scripts', name));

function pythons() {
  const vendors = [path.join(ROOT, 'vendor'), process.resourcesPath && path.join(process.resourcesPath, 'vendor')].filter(Boolean);
  const envs = [pyenvPython(), ...vendors.map((v) => path.join(v, 'pyenv', 'Scripts', 'python.exe'))];   // the one Pomelo installs, then a developer's vendor/pyenv
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

const detect = () => find('pdf2docx, fitz');
const detectHeic = () => find('pillow_heif, PIL');

// "exact" keeps every position, font and picture of the PDF page; "editable" rebuilds flowing Word paragraphs.
// POMELO_PDF_MODE overrides the setting (the fidelity harness uses it).
function pdfLayout() {
  if (process.env.POMELO_PDF_MODE) return process.env.POMELO_PDF_MODE;
  try { return require('../settings').get().pdfLayout || 'exact'; } catch { return 'exact'; }   // no Electron: the default
}

// Turns the helper scripts' output into a 0..1 progress figure. The scripts print "POMELO_PROGRESS 0.4"; pdf2docx
// (the flowing rebuild) logs "[3/4] Parsing pages...", "(2/9) Page 2", "[4/4] Creating pages...".
function progressReader(onProgress) {
  if (!onProgress) return undefined;
  let phase = 0;
  return (line) => {
    const own = /^POMELO_PROGRESS ([0-9.]+)/.exec(line);
    if (own) return onProgress(Math.min(0.99, +own[1]));
    if (/\[3\/4\] Parsing pages/.test(line)) { phase = 1; return onProgress(0.05); }
    if (/\[4\/4\] Creating pages/.test(line)) { phase = 2; return onProgress(0.6); }
    const page = /\((\d+)\/(\d+)\) Page \d+/.exec(line);
    if (page && phase) onProgress(Math.min(0.99, phase === 1 ? 0.05 + 0.55 * (+page[1] / +page[2]) : 0.6 + 0.37 * (+page[1] / +page[2])));
  };
}

const isNumber = (s) => /^-?(0|[1-9]\d{0,14})([.,]\d+)?$/.test(s);

// Markdown, HTML, plain text and EPUB all come from one reading of the PDF (scripts/pdf_structure_run.py), so they
// agree: all of the text in reading order, headings, lists, tables, links, bold and italic, code and pictures.
async function pdfToText({ src, to, dir, base, engines, onProgress }) {
  const opts = { timeout: 600000, onLine: progressReader(onProgress) };
  if (to === 'epub') {
    const tmp = tempPath('html');
    try {
      await run(engines.pdf2docx, ['-W', 'ignore', script('pdf_structure_run.py'), src, tmp, 'html'], opts);
      const out = uniquePath(dir, base, 'epub');
      await require('./epub').write(fs.readFileSync(tmp, 'utf8'), { title: base }, out);
      return [out];
    } finally { fs.rmSync(tmp, { force: true }); }
  }
  const out = uniquePath(dir, base, to);
  const args = ['-W', 'ignore', script('pdf_structure_run.py'), src, out, to];
  if (to === 'md') args.push(uniquePath(dir, `${base}_images`, ''));   // made only when the PDF has pictures worth keeping
  await run(engines.pdf2docx, args, opts);
  if (!fs.existsSync(out)) throw new Error('PDF engine produced no output');
  return [out];
}

// Slides that look like the pages: each page's pictures, shapes and backgrounds as one picture behind the text, and the
// text as real text boxes at the same places, fonts, sizes and colours, links included.
async function pdfToPptx({ src, dir, base, engines, onProgress }) {
  const PptxGenJS = require('pptxgenjs');
  const tmp = tempPath('d');
  fs.mkdirSync(tmp);
  try {
    await run(engines.pdf2docx, ['-W', 'ignore', script('pdf_pptx_export.py'), src, tmp], { timeout: 600000, onLine: progressReader(onProgress && ((f) => onProgress(f * 0.9))) });
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
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

async function pdfToXlsx({ src, dir, base, engines, onProgress }) {
  const XLSX = require('xlsx');
  const tmp = tempPath('json');
  try {
    await run(engines.pdf2docx, ['-W', 'ignore', script('pdf_tables_run.py'), src, tmp], { timeout: 600000, onLine: progressReader(onProgress) });
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
  } finally { fs.rmSync(tmp, { force: true }); }
}

module.exports = {
  name: 'pdf-hifi',
  detect,
  detectHeic,
  supports: (from, to, engines) => from === 'pdf' && !!engines.pdf2docx && ['docx', 'xlsx', 'pptx', 'md', 'html', 'txt', 'epub'].includes(to),
  async run(job) {
    const { src, to, dir, base, engines, onProgress, layout } = job;
    if (to === 'xlsx') return pdfToXlsx(job);
    if (to === 'pptx') return pdfToPptx(job);
    if (to !== 'docx') return pdfToText(job);
    const out = uniquePath(dir, base, to);
    // `layout` is set by a conversion that needs one kind of Word file whatever the setting says (RTF cannot hold a fixed layout)
    await run(engines.pdf2docx, ['-W', 'ignore', script('pdf2docx_run.py'), src, out], { timeout: 600000, env: { POMELO_PDF_MODE: layout || pdfLayout() }, onLine: progressReader(onProgress) });
    if (!fs.existsSync(out)) throw new Error('PDF engine produced no output');
    return [out];
  },
};

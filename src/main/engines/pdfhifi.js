// SPDX-License-Identifier: AGPL-3.0-or-later
// High-fidelity PDF conversion through Python packages, each run as a separate process:
//   pdf2docx    (MIT)       PDF -> DOCX that keeps fonts, colours, tables, images and spacing
//   pymupdf4llm             PDF -> Markdown with real heading levels, bold/italic, lists and tables
//   PyMuPDF     (AGPL-3.0) PDF -> XLSX: tables found by its table finder, written to Excel here
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
const detectMarkdown = () => find('pymupdf4llm');
const detectHeic = () => find('pillow_heif, PIL');

const isNumber = (s) => /^-?(0|[1-9]\d{0,14})([.,]\d+)?$/.test(s);

async function pdfToXlsx({ src, dir, base, engines }) {
  const XLSX = require('xlsx');
  const tmp = tempPath('json');
  try {
    await run(engines.pdf2docx, ['-W', 'ignore', script('pdf_tables_run.py'), src, tmp], { timeout: 600000 });
    const tables = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    if (!tables.length) throw new Error('No tables were found in this PDF');
    const wb = XLSX.utils.book_new();
    for (const t of tables) {
      const rows = t.rows.map((r) => r.map((c) => (isNumber(c) ? Number(c.replace(',', '.')) : c)));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), `P${t.page} T${t.index}`);
    }
    const out = uniquePath(dir, base, 'xlsx');
    fs.writeFileSync(out, XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }));
    return [out];
  } finally { fs.rmSync(tmp, { force: true }); }
}

module.exports = {
  name: 'pdf-hifi',
  detect,
  detectMarkdown,
  detectHeic,
  supports: (from, to, engines) => from === 'pdf' && (
    (to === 'docx' && !!engines.pdf2docx) || (to === 'md' && !!engines.pdfmd) || (to === 'xlsx' && !!engines.pdf2docx)),
  async run(job) {
    const { src, to, dir, base, engines } = job;
    if (to === 'xlsx') return pdfToXlsx(job);
    const out = uniquePath(dir, base, to);
    if (to === 'docx') await run(engines.pdf2docx, ['-W', 'ignore', script('pdf2docx_run.py'), src, out], { timeout: 600000 });
    else await run(engines.pdfmd, ['-W', 'ignore', script('pdf_markdown_run.py'), src, out], { timeout: 600000 });
    if (!fs.existsSync(out)) throw new Error('PDF engine produced no output');
    return [out];
  },
};

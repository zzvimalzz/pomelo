// SPDX-License-Identifier: AGPL-3.0-or-later
// PDF conversion through Python packages, each run as a separate process:
//   PyMuPDF     (AGPL-3.0) reads the PDF: PDF -> DOCX (python/pdf_flow.py: real paragraphs, lists and tables, always editable),
//                          Markdown / HTML / text / EPUB (reading order), XLSX (tables found by its table finder, written to Excel
//                          here) and PowerPoint (text boxes on a picture of the rest)
//   python-docx (MIT)      writes the Word file
//   RapidOCR    (Apache-2.0) reads scanned pages first, so every route above also works on a scan (python/pdf_ocr.py)
// Environment: Pomelo's Install button creates one in %LOCALAPPDATA%\Pomelo\engines\pyenv (see engineInstaller.js);
// `npm run setup:pdf` creates vendor/pyenv for development; an existing system Python with the packages also works.
const fs = require('fs');
const { uniquePath, assertProduced } = require('../../engine-kit/outputs');
const { findPython, runHelper } = require('../../engine-kit/python');
const { withTempFile } = require('../../../../shared/node/fs');
const { pdfToPptx } = require('./to-pptx');
const { pdfToXlsx } = require('./to-xlsx');

// The PDF scripts run in the Python found for `pdf`, and they do the OCR themselves, so prefer one that has RapidOCR as well.
// Otherwise a PC with an older environment (no OCR) and a newer one would show OCR as ready and then fail to use it.
const detect = () => ({ pdf: findPython('pymupdf, docx, rapidocr') || findPython('pymupdf, docx'), ocr: findPython('rapidocr') });

// Markdown, HTML, plain text and EPUB all come from one reading of the PDF (python/pdf_to_text.py), so they
// agree: all of the text in reading order, headings, lists, tables, links, bold and italic, code and pictures.
async function pdfToText({ src, to, dir, base, engines, onProgress }) {
  if (to === 'epub') {
    return withTempFile('html', async (tmp) => {
      await runHelper(engines.pdf, 'pdf_to_text.py', [src, tmp, 'html'], { src, onProgress });
      const out = uniquePath(dir, base, 'epub');
      await require('../../lib/epub').write(fs.readFileSync(tmp, 'utf8'), { title: base }, out);
      return [out];
    });
  }
  const out = uniquePath(dir, base, to);
  const args = [src, out, to];
  if (to === 'md') args.push(uniquePath(dir, `${base}_images`, ''));   // made only when the PDF has pictures worth keeping
  await runHelper(engines.pdf, 'pdf_to_text.py', args, { src, onProgress });
  assertProduced(out, 'PDF engine');
  return [out];
}

module.exports = {
  name: 'pdf-hifi',
  detect,
  supports: (from, to, engines) => from === 'pdf' && !!engines.pdf && ['docx', 'xlsx', 'pptx', 'md', 'html', 'txt', 'epub'].includes(to),
  async run(job) {
    const { src, to, dir, base, engines, onProgress } = job;
    if (to === 'xlsx') return pdfToXlsx(job);
    if (to === 'pptx') return pdfToPptx(job);
    if (to !== 'docx') return pdfToText(job);
    const out = uniquePath(dir, base, to);
    await runHelper(engines.pdf, 'pdf_to_docx.py', [src, out], { src, onProgress });
    assertProduced(out, 'PDF engine');
    return [out];
  },
};

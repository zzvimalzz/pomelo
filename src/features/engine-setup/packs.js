// SPDX-License-Identifier: AGPL-3.0-or-later
// The optional engines Pomelo can install, as three packs. The one place for their names, keys, weights and winget ids.
// An engine key (pdf, ocr, heic, soffice, pandoc) names the engine the user asked for; the pack is what gets installed.
// The Python packages are in python/requirements.txt.

const PACKS = {
  // PDF, OCR and HEIC come from one private Python environment. pdf2docx is the name 0.1.0 to 0.1.2 used for pdf.
  python: {
    label: 'PDF, OCR and HEIC components', busy: 'the PDF, OCR and HEIC engine', weight: 220, keys: ['pdf', 'pdf2docx', 'ocr', 'heic'],
    check: 'pymupdf, docx, pillow_heif, rapidocr',                       // what must import once the packages are installed
    runtime: { id: 'Python.Python.3.12', name: 'Python' },               // added with winget only if the PC has no suitable Python
  },
  // The official MSI is fetched with `winget download` and unpacked into Pomelo's own folder: nothing is installed.
  soffice: { label: 'LibreOffice', busy: 'LibreOffice', weight: 450, keys: ['soffice'], wingetId: 'TheDocumentFoundation.LibreOffice' },
  pandoc: { label: 'Pandoc', busy: 'Pandoc', weight: 40, keys: ['pandoc'], winget: { id: 'JohnMacFarlane.Pandoc', name: 'Pandoc' } },
};

// engine key -> pack id
const PACK = Object.fromEntries(Object.entries(PACKS).flatMap(([id, p]) => p.keys.map((k) => [k, id])));

module.exports = { PACKS, PACK };

# Python helpers

The PDF, OCR and HEIC work that Python does better than JavaScript. Each helper runs as its own process, started by `src/features/conversion/engines/pdf-python` and `heic-python` through `runHelper` (`engine-kit/python.js`); nothing here is linked into the app.

The packages are in `requirements.txt`. The in-app installer, `npm run setup:pdf` (`tools/setup-pdf-engine.ps1`) and `tools/make-notices.js` all read it. PyMuPDF is pinned: its 2.x releases pull in a 120 MB layout-analysis stack that nothing here uses. The code runs on Python 3.9 to 3.13.

## Entry points and libraries

An entry point is run with `python -W ignore <script> <arguments>`. Libraries are imported by entry points and never exit the process.

| File | Kind | What it does |
|---|---|---|
| `pdf_to_docx.py` | entry | PDF to editable Word: `<in.pdf> <out.docx>` |
| `pdf_to_text.py` | entry | PDF to Markdown, HTML or plain text: `<in.pdf> <out> <md\|html\|txt> [images folder]` |
| `pdf_to_tables.py` | entry | The tables of a PDF as JSON for the Excel writer: `<in.pdf> <out.json>` |
| `pdf_to_layout.py` | entry | Text with exact positions, plus background pictures, for the PowerPoint writer: `<in.pdf> <out folder>` |
| `image_to_heic.py` | entry | An image to HEIC: `<in image> <out.heic>` |
| `ocr_warmup.py` | entry | Loads the OCR engine once so its models download during the install |
| `helper.py` | library | `require()`, `progress()`, `exit_no_text()` and `run_pdf_job()` |
| `pdf_ocr.py` | library | Reads scanned pages with RapidOCR into a temporary PDF with real text |
| `pdf_spans.py` | library | What the readers share: `hexcolor`, `BAD_XML`, `TEXT_FLAGS`, `has_unmapped_symbols`, `dominant_size`, `dedupe` |
| `pdf_fonts.py` | library | PostScript font names to Word font families |
| `pdf_flow/` | library | PDF to Word (see below) |
| `pdf_structure.py` | library | Reading order, headings, lists and tables, written as Markdown, HTML or text |
| `pdf_layout.py` | library | The exact-position reading for PowerPoint |

`pdf_flow/` is the Word converter, split by responsibility: `common.py` (units, escaping, box geometry), `lines.py` (spans to lines, list markers), `shapes.py` (pictures, rules, boxes, tables), `fonts.py` (text measuring), `page.py` (one page), `builder.py` (laying out a region), `lists.py` (numbering) and `convert.py` (the page loop). Imports only point downwards in that order. `pdf_flow/__init__.py` exports `convert`.

## How a helper runs

Every entry point starts with `import helper`, then `helper.require(...)` for the packages it needs, then runs `main()` under `if __name__ == "__main__"`. For a PDF, `helper.run_pdf_job(src, work)` does the common part: a scan is read with OCR first (the first 70 % of the progress bar), `work(path, progress)` runs on the PDF, a failure becomes a one-line reason, and the temporary OCR copy is deleted. `work` must close every document it opens before it returns, because Windows will not delete a file that is still open.

## Contracts

The Node side depends on these (`test/integration/python/cli-contract.test.js` checks them):

- Arguments as in the table.
- `POMELO_PROGRESS <0..1>` lines on stdout while it works, and `OK` at the end.
- On failure, one line on stderr and an exit code: 1 failed, 2 a component is not installed, 3 the PDF has no text to convert.
- The messages for a password-protected, a damaged and a page-less PDF, and for a scan when OCR is not installed. The tests assert on them.

## Testing

`node test/run.js --tier=pdf` (needs the PDF engine): the command-line contract, the Word layout checks (`pdf-layout`), and the other formats (`pdf-formats`). For real pages, `npm run test:fidelity` scores PDF to Word against `test/fidelity/baseline.json`; any change to `pdf_flow/` must leave every sample's score equal. `node test/fidelity/run.js --word` does the same comparison with Microsoft Word as the renderer (see `test/README.md`).

## Known limits

- The Word and the text/Markdown readers each have their own line pipeline, tuned differently (`dedupe` tolerance 3 versus 4 points, different bullet sets), so their output differs in small ways on purpose.

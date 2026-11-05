# Conversion

Turns one file into another format, next to the original. The rest of the app uses only `index.js`: `detectEngines`, `getEngines`, `targetsFor` (what the wheel offers), `canConvert`, `convertFile`, `plansFor`, `explainNoTargets`, the format helpers `extOf`, `groupOf` and `labelOf`, and `timingFormats` (what the jobs feature needs, handed to it by the app).

## How it works

1. **Catalog** (`catalog/formats.js`). Which extensions exist, their groups, aliases (`jpeg` is `jpg`), the wheel order per source format, and the labels. `extsInGroup`, `OFFICE`, `VIDEO_SOURCES` and `AUDIO_SOURCES` are the lists the engines derive theirs from; add a format here first.
2. **Engines map** (`engines/registry.js`). `detectEngines()` asks each engine that needs a program or a Python environment for its `detect()`, and merges the answers into one map: `soffice`, `pandoc`, `pdf`, `ocr`, `heic`, `ffmpeg`, `sevenZip`, each a path or `null`.
3. **Routing** (`routing/plans.js`). `plansFor(from, to, engines)` returns the plans in the order to try them. A plan is one engine, or two with an intermediate format (`CHAINS`). It is a pure function of the engines map, so `test/unit/conversion/routing.test.js` can run it under any combination.
4. **Running** (`routing/run-plan.js`). `convertFile` tries the plans in order inside a conversion context (`engine-kit/context.js`). A failed attempt deletes its own output and the next plan runs; the first error is the one reported. Cancelling the `signal` kills the helper programs and deletes partial output.

## Files

| Path | Role |
|---|---|
| `index.js` | The public API |
| `catalog/` | `formats.js`; `explain.js` is the reason shown when the wheel has nothing to offer |
| `routing/` | `plans.js`, `run-plan.js` |
| `engine-kit/` | What every engine uses: `context.js` (cancel signal, `CancelledError`), `outputs.js` (`uniquePath`, `assertProduced`, `removeOutputs`), `run.js` (cancellable process run), `python.js` (`findPython`, `runHelper`), `progress.js` (`scaled`) |
| `engines/<name>/` | One folder per engine; `index.js` exports `{ name, supports, run }` and, if it needs something installed, `detect()` |
| `lib/` | Code that engines share and that is no engine: `html.js`, `print-pdf.js`, `text-blocks.js`, `pptx.js`, `pdfjs.js`, `epub.js`, `mime.js`, `image-input.js` |

Engines and what they do:

| Folder | `name` in logs and snapshots | Handles |
|---|---|---|
| `builtin/` | `pure` | Documents, spreadsheets, images and PDFs with no Office and no extra program (`documents.js`, `legacy-doc.js`, `spreadsheets.js`, `images.js`, `pdf.js`) |
| `libreoffice/` | `libreoffice` | Office formats at full fidelity; `profiles.js` lends private LibreOffice profiles |
| `pandoc/` | `pandoc` | Markup conversions |
| `pdf-python/` | `pdf-hifi` | PDF to Word, Excel, slides, Markdown, HTML, text and EPUB through PyMuPDF (`to-pptx.js`, `to-xlsx.js`), with OCR for scans |
| `heic-python/` | `heic` | Writing HEIC through pillow-heif |
| `ffmpeg/` | `ffmpeg` | Video and audio |
| `archive/` | `archive` | ZIP, 7Z, TAR, GZIP and RAR (input only), and folders |
| `subtitle/` | `subtitle` | SRT and VTT |

## Rules

- Code in `engines/<x>/` imports only `engine-kit`, `lib`, `catalog` and `shared`, never another engine. `lib/` never imports `engines/` or `routing/`. `tools/check-boundaries.js` reports breaks.
- `electron` is required only inside a function, and only in the adapters `lib/print-pdf.js` and `engines/builtin/images.js`. `test/pdf-layout-test.js` and `test/pdf-formats-test.js` load this code under plain Node.
- Heavy libraries (`sharp`, `docx`, `xlsx`, `pptxgenjs` and so on) are required inside the function that uses them, so start-up stays fast.
- The engine `name` strings and the engines-map keys appear in `routing.snapshot.json`, in logs and in the settings window. Changing one is a visible change.

## Contracts

- The Python helpers' arguments, the `POMELO_PROGRESS` lines, `OK` and exit codes 1, 2 and 3 (`runHelper` and the scripts in `python/`).
- `settings:get` returns the engines map with the keys above.
- Error messages shown to the user (tests assert on them).

## Testing

`node test/run.js --tier=unit` (routing snapshot, registry), `--tier=integration` (the full matrix of conversions, edge cases), `--tier=pdf` (needs the PDF engine). See `test/README.md`.

## Known limits

- `detectEngines()` is synchronous and takes about 0.75 s on start-up (Python probes).
- `engines.pdf` prefers a Python that also has RapidOCR, so two environments on one PC (an older one without OCR, a newer one with) agree about OCR; `engines.heic` is found separately and can point at another environment.

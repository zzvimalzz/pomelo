# Tests

Every suite is a plain script that prints `ok` or `FAIL` for each check and exits non-zero if one failed. `test/run.js` is the one list of them: the npm scripts and CI both go through it.

## Running

```bash
npm test                                      # unit, integration and pdf tiers (about 5 min with all engines)
npm run test:ui                               # opens real windows; leave the mouse alone (about 65 s)
node test/run.js --tier=unit                  # about 3 s
node test/run.js --only=jobs,matrix           # suites by name
node test/run.js --tier=ui --junit=out.xml    # also write a JUnit report
node test/run.js --timeout=60                 # time limit in seconds for every suite
```

`run.js` kills a suite that runs past its time limit and counts it as failed. It prints a table with the checks that passed, failed and were skipped. A skip is not a pass: a suite that needs an engine you do not have prints `skipped` and the table counts it. In GitHub Actions it also writes an `::error` annotation per failed check and a step summary.

A single suite runs on its own too: `node test/unit/jobs/jobs.test.js`, or `npx electron test/integration/conversion/matrix.test.js --only=mp4,pdf` for the conversion matrix.

## Tiers

| Tier | Runs in | Needs | Suites |
|---|---|---|---|
| `unit` | Node | nothing; the input helper must be built (`npm run build:helper`) | `jobs`, `helper`, `engine-cli`, `installer`, `uninstall`, `autoupdate`, `updater`, `updateinstall`, `postupdate`, `routing`, `kit-and-catalog`, `registry`, `dev-tools`, `check-public`, `paths`, `fs-process`, `text` |
| `integration` | Electron | LibreOffice and Pandoc for their pairs (skipped without) | `app-start` (CI only), `matrix`, `edge-cases` |
| `pdf` | Node | the Python PDF engine, and OCR for the scan check | `pdf-layout`, `pdf-formats` |
| `ui` | Electron | the Windows desktop | `pipeline`, `overlay-shot`, `toast-shot`, `settings-shot`, `downloader-shot` (they also save screenshots to `test/shots/`) |
| `nightly` | Node | network; installs Python packages for real | `real-python` |

The files sit in `unit/<feature>/`, `integration/<area>/` and `ui/`, next to the feature they test by name.

## Writing a suite

- Use `expect(name, ok, extra)` from `support/expect.js`. `run.js` counts the lines it prints, so keep the format.
- Make temp folders with `tmp.dir(prefix)` from `support/tmp.js` and end with `finish()` from `support/finish.js`. `finish` removes them and exits with 1 if a check failed. A leftover `pomelo-*` folder in `%TEMP%` after a run is a bug in the suite.
- A suite that decodes images with `sharp` calls `sharp.cache(false)` before `finish()`: libvips keeps the files open, and Windows will not delete an open file.
- Put a plain-Node test under `unit/<area>/`, and add it to the list in `run.js`.

## Routing snapshot

`unit/conversion/routing.snapshot.json` records which engines handle every (from, to) pair, in the order `convertFile` tries them, and what the wheel offers per extension, under nine engine combinations. A routing change shows up as a failing check. If the change is intended, run `node test/unit/conversion/routing.test.js --update` and review the diff.

## Fidelity

`test/fidelity/` scores PDF to Word conversions: `npm run fidelity:samples` draws the sample PDFs, `npm run test:fidelity` converts them, prints the DOCX back to PDF with LibreOffice and compares. `npm run test:fidelity:formats` does the same for the other output formats. `baseline.json` holds the per-sample scores of the last known good state. Needs LibreOffice and the PDF engine.

LibreOffice lays pages out differently from Word. `node test/fidelity/run.js --word [files or folders]` prints each DOCX with Microsoft Word instead (`word-print.ps1`, through COM) and compares the PDF Word makes with the original. Per file it reports the page count, how many pages keep their size, **recall** (the share of the source words that Word prints), **order** (how alike the word sequences are), **visual** (1 minus the mean grey difference per page at 36 dpi) and **xml** (the share of the source words found in the DOCX itself, so lost text shows up without Word). Without Word it prints `skip`. Notes:

- Each file gets its own Word with a limit of 120 s. A file that runs over is reported and the batch carries on; only the Word process the script started is stopped, never one you have open. If a Word of yours is already running, leave it as it is.
- `--out <folder>` keeps the converted files, the printed PDFs and the page images in a folder of your choice instead of `test/fidelity/out`.
- A source PDF with no text layer (a scan) has no recall or order; the other columns still apply.
- If Word shows "Recovered" documents when it starts, open it by hand once, close each with **Don't Save** and quit before running again.
- `python test/fidelity/compare.py --docx-words <original.pdf> <converted.docx>` runs the xml check alone.

## Things that trip people up

- Some editors set `ELECTRON_RUN_AS_NODE=1`, which makes Electron behave as Node. `run.js` removes it for the Electron suites; do it yourself when starting one by hand.
- `overlay-shot` switches off Chromium's window-occlusion check; without it a window covered by another app cannot be captured.
- `tools/installer-e2e.ps1` installs and uninstalls Pomelo for real. It runs only on a CI runner, or with `-IUnderstand`.

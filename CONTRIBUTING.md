# Contributing to Pomelo

Thanks for helping. Pomelo is a Windows app, free software under the [GNU AGPL v3 or later](LICENSE). By contributing you agree that your work is released under the same licence. Please read the [Code of Conduct](CODE_OF_CONDUCT.md) first.

## Set up

Requirements: Windows 10/11, Node 20+, and (optional, for the full feature set) Python 3.9+, LibreOffice and Pandoc. See the README for what each optional engine adds.

```bash
git clone https://github.com/zzvimalzz/pomelo.git
cd pomelo
npm install
npm run setup:pdf      # optional: PDF fidelity and HEIC export (needs Python)
npm start
```

## Before you open a pull request

```bash
npm run check          # ESLint plus a scan for unused exports and IPC channels
npm test               # job logic, updater, routing snapshot, the full conversion matrix, edge cases
npm run test:ui        # wheel, toast and settings window (opens real windows; leave the mouse alone)
```

`test/run.js` is the one list of suites. `node test/run.js --tier=unit` takes a second; `--only=jobs,matrix` picks suites by name; `--junit=<file>` writes a JUnit report. A suite that hangs is killed at its time limit and counted as failed.

Tests that need an engine you have not installed (for example LibreOffice) are skipped, not failed. The summary counts the skips: a skip is not a pass.

The routing snapshot (`test/unit/conversion/routing.snapshot.json`) pins which engine handles each conversion. If you change routing on purpose, run `node test/unit/conversion/routing.test.js --update` and review the diff.

## Where things live

| Path | What it is |
| --- | --- |
| `native/pomelo-input.cs` | The input helper: global mouse/trigger-key hook and "which files are being dragged?" lookup. `npm run build:helper` compiles it (`npm start` and `npm test` do that for you) |
| `src/main/explorer.js` | Starts the helper and talks to it over stdin/stdout |
| `src/main/trigger.js` | The drag + key gesture state machine |
| `src/main/overlay.js`, `src/renderer/overlay.*` | The wheel window (also the drop target) |
| `src/main/jobs.js`, `toast.js`, `src/renderer/toast.*` | Parallel conversions and the bottom-right toast stack |
| `src/main/formats.js` | Formats, and which targets the wheel offers for each |
| `src/main/convert/index.js` | Picks the engine(s) for each conversion and falls back when one fails |
| `src/main/engines/` | One file per engine: built-in JS, LibreOffice/Pandoc, FFmpeg, archives, PDF, HEIC, subtitles, EPUB |
| `src/main/updater.js`, `src/renderer/settings.*` | Check for updates and the Settings window |
| `src/main/engineCli.js` | The headless `--install-engines` / `--uninstall-engines` switches the installer runs |
| `installer/pomelo.iss` | The Inno Setup script (three screens, per-user). `npm run package`, then `npm run build:installer` (needs Inno Setup 6.3+) |
| `.github/workflows/release.yml` | On a `v*` tag: builds the installer and attaches it, with its SHA-256, to a draft release |
| `tools/make-icons.js` | Draws the logo, tray icon, `.ico` and installer artwork. `npm run icons` |

## Adding a format or an engine

1. Add the extension to `GROUP_OF`, `TARGET_ORDER` and `LABELS` in `src/main/formats.js` (the wheel shows the first 8 available targets).
2. Implement it in an engine under `src/main/engines/`. An engine exports `supports(from, to, engines)` and `run(job)` that returns the files it wrote. Never overwrite: use `uniquePath`.
3. Register the engine, and any chain through an intermediate format, in `src/main/convert/index.js`.
4. Add a fixture and a content check in `test/entry.js`. Check the output, not just that a file exists.

## Ground rules

- **Privacy.** Nothing a user converts may leave the machine. No telemetry, no remote fetches while converting.
- **Licences.** Only add dependencies whose licence is compatible with AGPL-3.0-or-later and that are genuinely open source. Anything source-available or non-commercial (for example `pymupdf-layout`) is not acceptable. Add new packages to `THIRD_PARTY_NOTICES.md` (`node tools/make-notices.js`).
- **No dead code.** Remove what you stop using; `npm run check` flags unused exports.
- **Keep it small.** Prefer a well-maintained library or an existing engine over new code.

# Contributing to Pomelo

Thanks for helping. Pomelo is a Windows app, free software under the [GNU AGPL v3 or later](LICENSE). Please read the [Code of Conduct](CODE_OF_CONDUCT.md) first.

## Licence of your contribution

You keep the copyright in what you contribute. Pomelo is released under the AGPL, and by contributing you agree to the [Contributor Licence Agreement](CLA.md), which also lets the maintainer offer your contribution under other licence terms while the public source stays AGPL. Read it before your first pull request, then tick the licence box in the pull request template. A pull request without that agreement cannot be merged.

If you contribute as part of a job, your employer has to agree too. Open an issue first and say so.

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
npm run check          # ESLint, a scan for unused exports and IPC channels, and a check for stray private notes
npm test               # job logic, updater, routing snapshot, the full conversion matrix, edge cases
npm run test:ui        # wheel, toast and settings window (opens real windows; leave the mouse alone)
```

`test/run.js` is the one list of suites. `node test/run.js --tier=unit` takes a second; `--only=jobs,matrix` picks suites by name; `--junit=<file>` writes a JUnit report. A suite that hangs is killed at its time limit and counted as failed.

Tests that need an engine you have not installed (for example LibreOffice) are skipped, not failed. The summary counts the skips: a skip is not a pass.

The routing snapshot (`test/unit/conversion/routing.snapshot.json`) pins which engine handles each conversion. If you change routing on purpose, run `node test/unit/conversion/routing.test.js --update` and review the diff.

## Where things live

Each feature is a folder in `src/features/<feature>/`. Its `index.js` is the only file the rest of the app imports, its windows' pages sit in `ui/`, and its `README.md` says what it does, where the code is and how to test it. Features never import each other: `src/app/` connects them. Code that more than one part needs goes in `src/shared/` (logic) or `src/ui-shared/` (the windows' pages), and is imported from outside `shared/` as `require('#shared/node/fs')`. `npm run check` fails on an import that breaks these rules (`tools/check-boundaries.js`).

| Path | What it is |
| --- | --- |
| `src/app/` | The entry point (`main.js`) and the wiring between features: tray, drop flow, shutdown |
| `src/features/gesture/` | The input-helper client, the drag + key state machine, and the wheel window (also the drop target) |
| `src/features/jobs/` | Parallel conversions, time estimates and the bottom-right toast stack |
| `src/features/conversion/` | Everything about converting: the format catalog, which engines handle a pair, running them with fallback, and one folder per engine under `engines/`. See its `README.md` |
| `src/features/settings/` | The stored settings and the Settings window |
| `src/features/updates/` | Check for updates, download and install in place |
| `src/features/engine-setup/` | Installing and removing the optional engines, and the headless `--install-engines` / `--uninstall-engines` switches the installer runs |
| `src/features/uninstall/` | The Uninstall button |
| `src/shared/`, `src/ui-shared/` | Helpers used by more than one part: paths, processes, temp files, text; the colours and DOM helper of the windows' pages |
| `python/` | The Python helpers for PDF, OCR and HEIC, each run as its own process; `requirements.txt` pins the packages (the in-app installer, `npm run setup:pdf` and the notices check all read it). See its `README.md` |
| `native/pomelo-input.cs` | The input helper: global mouse/trigger-key hook and "which files are being dragged?" lookup. `npm run build:helper` compiles it (`npm start` and `npm test` do that for you) |
| `test/` | `unit/<feature>/`, `integration/<area>/` and `ui/`, listed in `test/run.js`; `fidelity/` scores PDF to Word. See `test/README.md` |
| `tools/` | Dev tools: the checks behind `npm run check`, icons, packaging, the installer build and the notices list |
| `installer/pomelo.iss` | The Inno Setup script (three screens, per-user). `npm run package`, then `npm run build:installer` (needs Inno Setup 6.3+) |
| `.github/workflows/release.yml` | On a `v*` tag: builds the installer and attaches it, with its SHA-256, to a draft release |

## Adding a format or an engine

1. Add the extension to `GROUP_OF`, `TARGET_ORDER` and `LABELS` in `src/features/conversion/catalog/formats.js` (the wheel shows the first 8 available targets). The lists the engines use are derived from it.
2. For a new engine, make `src/features/conversion/engines/<name>/index.js`. It exports `name`, `supports(from, to, engines)` and `run(job)`, which returns the files it wrote, and `detect()` if it needs a program or a Python environment. Never overwrite a file: use `uniquePath`. An engine imports only `engine-kit`, `lib`, `catalog` and `shared`, never another engine.
3. Register it with one line in `engines/registry.js` (and in `DETECTED` if it has `detect()`). Set its place in the order, and any chain through an intermediate format, in `routing/plans.js`.
4. Add a fixture and a content check in `test/integration/conversion/matrix.test.js`. Check the output, not just that a file exists.
5. Run `node test/unit/conversion/routing.test.js --update` and review the snapshot diff: it should show exactly the routes you added.
6. Update the engine table in `src/features/conversion/README.md`, and add a line to `CHANGELOG.md` under `[Unreleased]`.

## Ground rules

- **Privacy.** Nothing a user converts may leave the machine. No telemetry, no remote fetches while converting.
- **Licences.** Only add dependencies whose licence is compatible with AGPL-3.0-or-later and that are genuinely open source. Anything source-available or non-commercial (for example `pymupdf-layout`) is not acceptable. Add new packages to `THIRD_PARTY_NOTICES.md` (`node tools/make-notices.js`).
- **No dead code.** Remove what you stop using; `npm run check` flags unused exports.
- **Documentation.** A change to a feature updates that feature's `README.md` in the same pull request.
- **Keep it small.** Prefer a well-maintained library or an existing engine over new code.

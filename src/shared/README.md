# Shared code

Helpers that more than one part of the app needs, split by what they may depend on. They hold no feature logic.

| Folder | May use | Files |
|---|---|---|
| `core/` | nothing | `text.js`: `middleEllipsis`, `capitalize`, `escapeHtml`; `bounds.js`: `startBounds`, `MIN` |
| `node/` | Node built-ins and `core/` | `paths.js`, `which.js`, `fs.js`, `process.js` |
| `electron/` | Electron | `windows.js`, `user-data.js` |

`tools/check-boundaries.js` fails `npm run check` on imports that break these rules. Code outside `shared/` imports it as `require('#shared/node/fs')`; the alias is the `imports` field of `package.json`.

## Files

| File | Role |
|---|---|
| `node/paths.js` | `APP_ROOT`, `inApp()`, `scriptPath()` for the Python scripts, `vendorRoots()`, `enginesRoot()` and `pyenvPython()`. `bundled()` is the one place that points a path inside an asar archive at its unpacked copy; Pomelo packages with `asar: false`, so today it changes nothing |
| `node/which.js` | `where(name)` looks on PATH; `findExe(name, subdirs)` looks in `vendor/`, the engines folder and the usual install folders first |
| `node/fs.js` | `withTempFile(ext, fn)` and `withTempDir(fn)` remove what they hand out when `fn` ends or throws; `makeTempDir(tag)` makes a folder the caller removes itself and `sweepTempDirs(tag, maxAgeMs)` removes the folders of that tag left by an earlier run (judged by when each was last changed); `readText` decodes UTF-8, UTF-16 and Windows-1252; `dirBytes`; `removeDirReliably` retries while Windows holds a folder; `fileIdentity(file)` and `sameFile(a, b)` say whether a path is still the file it was; `replaceFile(src, target, expected)` puts a copy of `src` in place of `target` through `File.Replace`, keeping permissions and the downloaded-file mark, or resolves `{ stop }` (`changed`, `read-only`, `no-space`, `locked`) with `target` untouched; `sleep` |
| `node/process.js` | `runCapture` resolves with stdout and rejects with the program's last meaningful line; `runStatus` never throws and resolves `{ code, out }` (`env` adds variables for the child). `track` and `killAll` keep a list of every child so quitting Pomelo stops them; `killOnAbort` ties a child to an `AbortSignal`; `lastMeaningfulLine` and `parsePercent` read program output |
| `core/bounds.js` | `startBounds(saved, workAreas)` says where an app window opens: the place it was saved in the last 24 hours if at least 100 px of its title row is still on a screen, otherwise 1200 x 800 in the middle of the main screen; `MIN` is the smallest size, 900 x 600 |
| `electron/windows.js` | `createAppWindow({ asset, solid, saved, onBounds, partition, preload, page })` makes a resizable window whose title row is part of the page (acrylic on Windows 11 or opaque with `solid`, caption buttons that follow the theme, a session that blocks the network and refuses every permission, saved place reported after a 400 ms pause) and loads `page`; `lockNavigation(win)` (a page never navigates away or opens a window), `createFloatingWindow` for the wheel and the toast, and `blockNetwork(session)`, which cancels every `http`, `https`, `ws`, `wss` and `ftp` request of a session: the print window and the PDF workspace use it so a page built from a user's file stays offline |
| `core/text.js` | Text helpers |

## Contracts

- `enginesRoot()` is `%LOCALAPPDATA%\Pomelo\engines`. The installer and the uninstaller find the engines there.
- `runStatus` reports a program that cannot start as `code: -1` with the reason in `out` (the installer tests for `ENOENT`).

## Testing

`node test/run.js --tier=unit` covers all of it (`paths`, `fs-process` and `text` suites). `paths` also checks that every file Pomelo ships exists when run from source.

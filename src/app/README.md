# App

The entry point and the wiring. `main.js` (package.json `"main"`) creates every feature and hands each one what it needs from the others. Features never import each other, so every link between them is made here.

## How it works

1. `main.js` points the debug log at `%APPDATA%\Pomelo\debug.log` before anything else, then checks the command line. `--install-engines=` and `--uninstall-engines` run the installer's headless work (`engine-setup`) and exit; no window, no tray, no single-instance lock.
2. Otherwise it takes the single-instance lock, and once Electron is ready: writes the default settings, detects the engines, starts the input helper, creates the wheel window, the job list with its toast, the gesture trigger and the tray, and registers each feature's IPC.
3. It applies the settings (gesture key, enabled, "Start with Windows"), starts the automatic update check if it is on, reports how an in-app update went (`--updated`), writes `ready` to the log, and opens Settings unless `--hidden` was given.

## Files

| File | Role |
|---|---|
| `main.js` | Start-up order, command line, the connections between features |
| `drop-flow.js` | From the gesture to the jobs: `onOpen(files)` offers the wheel or explains why there is none; `onDrop(paths, to)` makes one job per file. `describeSelection` builds what the wheel shows in its centre |
| `tray.js` | Tray icon, tooltip, menu |
| `shutdown.js` | `stopAll(helper)`: stops the input helper and every converter process, at quit and before an update |

## Contracts

- Command-line switches: `--install-engines=`, `--uninstall-engines`, `--progress-file=`, `--hidden`, `--updated[=version]`.
- The log line `ready` appears once everything is wired; `test/integration/app/start.test.js` waits for it.
- `app.setLoginItemSettings` is called with `--hidden` (and the app folder when run from source).

## Testing

`node test/integration/app/start.test.js` starts the app and waits for `ready`. It skips on a developer PC, because starting Pomelo rewrites the "Start with Windows" entry of the Electron app that runs; CI runs it, and `--i-understand` runs it here. The windows themselves are covered by `npm run test:ui`.

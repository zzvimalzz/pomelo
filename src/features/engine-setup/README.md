# Engine setup

Installs and removes the optional engines: the PDF, OCR and HEIC components, LibreOffice and Pandoc. From the Install buttons in Settings, and from the command line for the Windows installer.

## How it works

`packs.js` is the one table of what can be installed: three packs (`python`, `soffice`, `pandoc`) with their label, the engine keys they provide (`pdf`, `pdf2docx`, `ocr`, `heic` all come from `python`), a weight for the installer's progress bar, and their winget ids. `PACK` maps an engine key to its pack.

`installer.js` (`createInstaller`) installs a pack and records what it added in `manifest.json` (`manifest.js`), so uninstalling removes exactly that and never anything the user installed themselves. It does one install at a time.

- **python** (`python-env.js`): finds a Python 3.9 to 3.13, or adds Python 3.12 for this user with winget; builds `pyenv` in the engines folder; installs `python/requirements.txt` with pip; checks the packages import; fetches the OCR models.
- **soffice** (`libreoffice.js`): `winget download` of the official MSI (hash-checked), unpacked with `msiexec /a` into `libreoffice`, then pruned. Nothing is installed, so no administrator rights.
- **pandoc**: `winget install` (`winget.js`).

`installer.pending(engines)` is for an update that adds an engine to a pack that is already there: when Pomelo built the PDF environment and the engines map finds PDF but not OCR, it names the missing engine so the app can install it (the install rebuilds the whole pack). An environment that is not Pomelo's, or is not there at all, gives nothing.

`cli.js` is the headless side: `--install-engines=pdf,soffice,pandoc` installs one pack after another, `--uninstall-engines` removes everything, including the right-click menu entries, `--progress-file=` keeps a small file the installer's wizard polls. `engine-setup.ipc.js` handles the Install button, keeps track of an install in progress, and offers the same install as `run(key, onNote)` to the app.

## Files

| File | Role |
|---|---|
| `index.js` | `createInstaller`, `parseCommandLine`, `runCommandLine`, `fileProgress`, `registerEngineSetupIpc` |
| `packs.js` | Labels, keys, weights, winget ids |
| `installer.js` | `install`, `uninstall`, `installed` |
| `manifest.js` | `manifest.json` |
| `python-env.js`, `libreoffice.js`, `winget.js` | The three installs |
| `cli.js`, `engine-setup.ipc.js` | Command line and Settings messages |

## Contracts

- Command-line switches `--install-engines=`, `--uninstall-engines`, `--progress-file=`; exit code 0 or 1; the progress file format.
- `manifest.json`: `{ "winget": [{ "id", "name" }], "pyenv": bool, "soffice": bool }`. Older versions and the Windows uninstaller read it.
- The engines folder is `%LOCALAPPDATA%\Pomelo\engines` (`pyenv`, `libreoffice`, `lo-profile-N`, `manifest.json`).
- The Python packages are in `python/requirements.txt`, also read by `npm run setup:pdf` and checked against `THIRD_PARTY_NOTICES.md` by `tools/make-notices.js`.
- IPC channels: `engines:install`, `engines:progress`.

## Testing

`node test/unit/engine-setup/installer.test.js` and `cli.test.js` use a fake command runner: nothing is installed. `node test/run.js --tier=nightly` builds the Python environment for real (downloads about 60 MB). CI installs the PDF engine through `--install-engines=pdf` before the PDF tests.

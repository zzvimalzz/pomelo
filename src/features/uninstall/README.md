# Uninstall

The Uninstall button in Settings. It asks, then hands over to the Windows uninstaller.

## How it works

`uninstall.ipc.js` shows the confirmation (`confirmText`, which lists the engines Pomelo itself installed and says that anything the user installed, and all converted files, stay). On "Uninstall":

- **Installed with the installer** (`unins000.exe` sits next to `Pomelo.exe`): `uninstall.js` starts it with `/SILENT` and detached, and Pomelo quits. The Windows uninstaller removes the engines (through `--uninstall-engines`), the program, the settings and the "Start with Windows" entry, so uninstalling here and from Windows Settings is the same thing.
- **Run from source**: no Windows uninstaller exists, so the engines are removed right away and "Start with Windows" is switched off. If some cannot be removed, a message names them.

## Files

| File | Role |
|---|---|
| `index.js` | `registerUninstallIpc` |
| `uninstall.js` | `plan`, `confirmText`, `uninstall` |
| `uninstall.ipc.js` | The `app:uninstall` message and its dialogs |

## Contracts

- `unins000.exe` and `/SILENT`; the installer finds Pomelo through the `%APPDATA%\Pomelo` folder name.
- IPC channel: `app:uninstall`; `engines:progress` carries the removal progress to the page.

## Testing

`node test/unit/uninstall/uninstall.test.js`. The installer's own uninstall is covered by `installer-e2e.ps1` on CI only; never run it on a developer PC.

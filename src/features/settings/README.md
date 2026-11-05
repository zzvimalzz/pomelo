# Settings

What the user can set, where it is kept, and the Settings window.

## How it works

`store.js` keeps the settings in a JSON file whose path the app hands in (`%APPDATA%\Pomelo\settings.json`): `createStore(file)` returns `get()` and `set(patch)`. Missing keys get the defaults, and `set` writes the file at once. There is no Electron in it.

`settings.window.js` opens the window. It reports its natural height to the main process (`fit`), which sizes the window to its content, so nothing scrolls unless the screen is too small. `settings.ipc.js` answers the page: `settings:get` returns the stored settings together with the state other features own (engines, an install in progress, the version, an update that was found, whether this start followed an update), which the app supplies through `getState()`; `settings:set` stores a patch and calls `onChange(patch)` so the app can apply it.

The `theme` setting (`system`, `light` or `dark`) is applied in `src/app/main.js` through `nativeTheme.themeSource`, so the wheel, toast, settings and downloader pages all switch through their existing `prefers-color-scheme` rules. An unknown value falls back to `system`.

The page (`ui/`) shows the everyday switches, and under Advanced the engines with their Install buttons, the log, diagnostics, a link to the source code and licences, and Uninstall. Install, update and uninstall messages belong to their own features.

## Files

| File | Role |
|---|---|
| `index.js` | `createStore`, `openSettingsWindow`, `getSettingsWindow`, `registerSettingsIpc` |
| `store.js` | Defaults and the JSON file |
| `settings.window.js`, `settings.ipc.js` | The window and its messages |
| `ui/` | `settings.html`, `settings.css`, `settings.js`, `preload.js`, `logo.png` |

## Contracts

- The keys of `settings.json`: `enabled`, `key`, `openAtLogin`, `advanced`, `theme`, `autoUpdate`, `lastUpdateCheck`, `updateNotified`.
- IPC channels: `settings:get`, `settings:set`, `settings:fit`, `app:copy`, `app:open-logs`.
- Not validated: `settings:set` accepts any patch. A bad `key` reaches the input helper, and an empty one throws when the tray menu is built.

## Testing

`npx electron test/ui/settings-shot.js` drives the real window with fake state: layout, the engine rows, update states, uninstall, screenshots (about 40 s).

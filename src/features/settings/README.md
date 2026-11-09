# Settings

What the user can set, where it is kept, and the Settings window, which also holds the help for new users.

## How it works

`store.js` keeps the settings in a JSON file whose path the app hands in (`%APPDATA%\Pomelo\settings.json`): `createStore(file)` returns `get()` and `set(patch)`. Missing keys get the defaults, and `set` writes the file at once. There is no Electron in it.

`settings.window.js` opens one fixed window, 880 x 600 (shorter on a screen that cannot hold it; the page scrolls inside). Its title bar is part of the page (`titleBarStyle: 'hidden'` with `titleBarOverlay`): the page draws the logo and the search box, and Windows draws the minimise and close buttons over the right-hand end in colours that follow the theme (`setTitleBarOverlay`, called again when the theme changes). `open(asset, target)` takes an optional `{ page, check }`: a new window opens on that section (through the page's query string), an open window is sent `settings:go` (after it has finished loading, and the page keeps the target until it has its state). `check: true` also starts an update check. The tray's "How Pomelo works" and "Check for updates" use it, so does the first start (which opens on Help) and the toast that announces an update (which opens on Updates).

`settings.ipc.js` answers the page: `settings:get` returns the stored settings together with the state other features own (engines, an install in progress, the version, an update that was found, whether this start followed an update), which the app supplies through `getState()`; `settings:set` stores a patch and calls `onChange(patch)` so the app can apply it; `settings:samples` gives the three sample files of the Help animation with the formats each can become (from the app, through `describe(name)`); `settings:website` opens `https://pomelo.swymble.com` (the address is fixed in the main process). The app sends `settings:changed` when the tray changed a setting, so an open window follows.

The `theme` setting (`system`, `light` or `dark`) is applied in `src/app/main.js` through `nativeTheme.themeSource`, so every page switches through its `prefers-color-scheme` rules. An unknown value falls back to `system`.

## The page

`ui/settings.js` builds everything from one list, `SECTIONS`: each entry has an id, a sidebar label, an icon, a group, a title and a `render` function. The sidebar, the page, the search box and the navigation need nothing else, so a new section is one entry. The sections are General, Appearance, Engines and Updates (group Settings), How Pomelo works (Help), and Diagnostics and About (Advanced). The search box in the title bar filters the rows and questions of every section; Ctrl+F focuses it and Esc clears it.

Pages are built once and stay in the document. A change to a setting updates what shows it in place (`sync`), so a switch keeps the focus; only the Engines and Updates sections are drawn again when their state changes. Text that comes from outside (an update message, a folder name, an install error) goes through `esc` before it enters a template.

The Help page (`ui/help.js`, `ui/help.css`) shows an animation of the gesture and seven questions. The animation is built from the same code the real wheel uses (`ui-shared/wheel-shapes.js`, `wheel-glyphs.js`, `wheel-icons.js`) with the formats of this PC, so what it shows is what the wheel would show. Every ten-second loop it moves on to the next sample file. The motion is CSS only: one loop in `help.css` where every animation has the same length so they cannot drift apart, and only `opacity`, `translate`, `scale`, `rotate` and the ring's `stroke-dashoffset` change. To change the timeline, keep every animation at `10s` and make the last keyframe of each equal its first, or the loop will jump. With reduced motion in Windows the animation stops on a still picture of the open wheel. Each question has a Q badge and a bold title, and its answer sits on its own tinted panel with an A badge; only one is open at a time. Three answers have a picture drawn in HTML and CSS (the original next to its converted file, the two right-click menus, and the tray with its pop-up), so they follow the theme and stay sharp at any scale.

## Files

| File | Role |
|---|---|
| `index.js` | `createStore`, `openSettingsWindow`, `getSettingsWindow`, `registerSettingsIpc` |
| `store.js` | Defaults and the JSON file |
| `settings.window.js`, `settings.ipc.js` | The window and its messages |
| `ui/` | `settings.html`, `settings.css`, `settings.js` (sections, search, state), `help.js`, `help.css` (the Help page), `preload.js`, `logo.png` |

## Contracts

- The keys of `settings.json`: `enabled`, `outputDir`, `openAtLogin`, `advanced`, `theme`, `autoUpdate`, `lastUpdateCheck`, `updateNotified`. `advanced` is no longer used by the page and stays so the file keeps its shape.
- IPC channels: `settings:get`, `settings:set`, `settings:choose-output`, `settings:samples`, `settings:website`, `app:copy`, `app:open-logs` (page to main), `settings:go`, `settings:changed` (main to page).
- The **Save conversions to** dropdown is drawn by the page, not a native `<select>`, so it matches the rest of the window and uses its font; it works with the mouse and with the arrow keys, Home, End, Enter, Space and Esc. It shows Default, the folder in use when there is one, and Choose folder (never more than three; a new folder replaces the old one). `outputDir` is the folder conversions are saved to, `''` for next to the original. It is only stored from the folder dialog behind `settings:choose-output`; `settings:set` drops it unless it is `''`, which clears it.
- `settings:set` keeps only `enabled`, `openAtLogin` and `autoUpdate` (booleans), `theme` (`system`, `light` or `dark`) and `outputDir` (only `''`). Anything else in the patch, including the update checker's keys, is dropped.
- The page keeps the strict Content-Security-Policy, so nothing in it uses an inline style attribute; values that vary (the engine meter) are set through the DOM.
- Class names the wheel's shared styles use (`seg`, `gl`, `label`, `sub`, `plate`, `disc`, `badge`, `picon`) are not used for anything else on these pages.

## Testing

`npx electron test/ui/settings-shot.js` drives the real window with fake state: every section in both themes, search, the dropdown, engines, update states, uninstall, opening on a section, and the Help page (the animation at fixed moments of its loop by pausing it, the questions and the pictures, reduced motion). It saves screenshots to `test/shots/` (about 2 minutes).

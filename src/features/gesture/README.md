# Gesture

Drag a file, tap a key, drop it on a format. This feature reads the mouse and keyboard, decides when to open the wheel, and draws it.

## How it works

`input-helper.js` starts `native/bin/pomelo-input.exe` and talks to it over stdin and stdout: global mouse and key events, and "which files are being dragged?". `trigger.js` is the state machine over those events: a drag that starts on files, then a tap of Ctrl, opens the wheel; releasing the key or the mouse folds it away. It emits `open` (with the files), `release`, `cancel` and `unsupported`. The key is Ctrl: the app never sends the helper's `key` command, so the helper reports its default.

`wheel.window.js` is the transparent, always-on-top window that hosts the wheel. It is also the drop target. The app tells it what to show with `openWheel(info, targets, pickFiles)`; `info` is `{ name, ext, group, count }` with the name already shortened. With `pickFiles` (the right-click menu's "Convert with Pomelo") the wheel takes focus and a click on a segment, not a drop, converts those files; a click elsewhere, Esc or losing focus closes it. `wheel.ipc.js` has the messages from the page (`ui/`). The page draws the centre as a Pomelo file icon from `info`: `ui-shared/wheel-icons.js` picks the colour from the format, draws the file or folder shape, adds the format's picture from `ui-shared/wheel-glyphs.js` (one for every format in `TARGET_ORDER`) and its name as text, and stacks pages behind it for several files. A format with no picture is drawn as a plain coloured file. A new source format needs an entry in `wheel-glyphs.js` and `EXT_COLOR`; the overlay test fails until every source format has its own picture. The centre disc is opaque on purpose, so the icon reads clearly over whatever is behind the wheel.

## Files

| File | Role |
|---|---|
| `index.js` | `InputHelper`, `Trigger`, `WheelWindow` |
| `input-helper.js` | Client of the native helper |
| `trigger.js` | The gesture state machine |
| `wheel.window.js`, `wheel.ipc.js` | The wheel window and its messages |
| `ui/` | `wheel.html`, `wheel.css`, `wheel.js`, `preload.js`. The segment geometry, the segment look and the file icons are in `src/ui-shared`, because the Help page's animation draws the same wheel |

## Contracts

- The helper's stdin and stdout protocol (`native/pomelo-input.cs`) and the path `native/bin/pomelo-input.exe`.
- IPC channels: `wheel:open`, `wheel:close` (to the page), `wheel:drop`, `wheel:pick`, `wheel:cancel`, `overlay:log`, `overlay:ready`. `overlay:ready` is registered before the page loads.
- This feature does not know about formats. The app builds `info` and the list of targets from the conversion feature.

## Testing

`node test/integration/gesture/input-helper.test.js` (the protocol; needs `npm run build:helper`, presses no keys); `npx electron test/ui/pipeline.js` and `npx electron test/ui/overlay-shot.js` (synthetic events through the trigger to a real wheel, and screenshots). Dragging a real file and tapping Ctrl is still a manual check.

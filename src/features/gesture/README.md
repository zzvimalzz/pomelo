# Gesture

Drag a file, tap a key, drop it on a format, or tap Shift and drop a PDF on Open. This feature reads the mouse and keyboard, decides when to open a wheel, and draws it.

## How it works

`input-helper.js` starts `native/bin/pomelo-input.exe` and talks to it over stdin and stdout: global mouse and key events, and "which files are being dragged?". `trigger.js` is the state machine over those events: a drag that starts on files, then a tap of Ctrl, opens the conversion wheel; a tap of Shift opens the Open wheel. While a wheel shows, the other key turns it into the other wheel, and the key of the wheel already showing does nothing. Releasing the mouse folds the wheel away; Esc cancels it. It emits `open` (with the files and `{ wheel: 'convert' | 'open' }`), `switch` (with the wheel to turn to), `release`, `cancel` and `unsupported`. `KEY_WHEELS` in `trigger.js` says which key shows which wheel, and `InputHelper` asks the native helper for exactly those keys (`keys ctrl shift`) when it reports that it is ready. A helper that does not say `"keys":true` in its ready line is older: it ignores the command and reports Ctrl only, and `keysSupported` is false, so the conversion wheel does not name Shift.

`wheel.window.js` is the transparent, always-on-top window that hosts the wheel. It is also the drop target. The app tells it what to show with `openWheel(info, targets, pickFiles)`; `info` is `{ name, ext, group, count }` with the name already shortened. With `pickFiles` (the right-click menu's "Convert with Pomelo") the wheel takes focus and a click on a segment, not a drop, converts those files; a click elsewhere, Esc or losing focus closes it. `wheel.ipc.js` has the messages from the page (`ui/`). `openWheel(info, targets, pickFiles, view)` takes `view = { wheel, droppable, switchable }`: `wheel` is `convert` (the default) or `open`, `droppable` is whether the dragged files can be dropped on it (default true), and `switchable` is whether the pill that names the key of the other wheel is shown (never for the right-click menu's wheel). `switchWheel(targets, view)` turns the wheel on show into the other one. The Open wheel has one target, `{ id: 'open', label: 'Open', icon: 'book' }`, which fills the whole ring (`ringPath()` in `ui-shared/wheel-shapes.js`) with the icon above the word. When the files are not all PDFs the ring takes no drop and says `PDF files only` while the pointer is over it. The pill floats in a 64 px band above the wheel's 400 px box, about 28 px clear of the plate, so the window is 400 x 464 and the wheel is centred on the cursor as before; the page finds the wheel from the stage's position, not from the window's corner. The page draws the centre as a Pomelo file icon from `info`: `ui-shared/wheel-icons.js` picks the colour from the format, draws the file or folder shape, adds the format's picture from `ui-shared/wheel-glyphs.js` (one for every format in `TARGET_ORDER`) and its name as text, and stacks pages behind it for several files. A format with no picture is drawn as a plain coloured file. A new source format needs an entry in `wheel-glyphs.js` and `EXT_COLOR`; the overlay test fails until every source format has its own picture. The centre disc is opaque on purpose, so the icon reads clearly over whatever is behind the wheel.

**The turn.** `wheel:switch` builds the new segments, each in a group of its own, while the old ones turn away about the centre and fade, one after another, and the new ones turn in with a slight overshoot: the old ones last 200 ms, the new ones start after 90 ms and take 330 ms, so with eight segments the turn ends at 490 ms. The plate breathes in and the file dips and tilts. The pill's key cap sinks, its words lift away and the other key and name rise in while it eases to its new width. The new segments take drops from the first frame. A turn pressed during a turn goes on from where the segments are. With reduced motion the segments cross-fade and the pill changes at once.

## Files

| File | Role |
|---|---|
| `index.js` | `InputHelper`, `Trigger`, `WheelWindow` |
| `input-helper.js` | Client of the native helper |
| `trigger.js` | The gesture state machine |
| `wheel.window.js`, `wheel.ipc.js` | The wheel window and its messages |
| `ui/` | `wheel.html`, `wheel.css`, `wheel.js`, `preload.js`. The segment geometry, the segment look and the file icons are in `src/ui-shared`, because the Help page's animation draws the same wheel |

## Contracts

- The helper's stdin and stdout protocol (`native/pomelo-input.cs`) and the path `native/bin/pomelo-input.exe`. `key <name>` sets one trigger key and `keys <name> <name>…` sets several; every name must be `ctrl`, `alt` or `shift`, or the command is ignored. With neither command the helper reports Ctrl. The ready line is `{"ready":true,"keys":true}`; an older helper sends `{"ready":true}`.
- IPC channels: `wheel:open`, `wheel:switch`, `wheel:close` (to the page), `wheel:drop`, `wheel:pick`, `wheel:cancel`, `overlay:log`, `overlay:ready`. `overlay:ready` is registered before the page loads.
- This feature does not know about formats. The app builds `info` and the list of targets from the conversion feature.

## Testing

`node test/unit/gesture/trigger.test.js` (the keys, the turn, and what each ending does, against a fake helper); `node test/integration/gesture/input-helper.test.js` (the protocol, including `keys`; needs `npm run build:helper`, presses no keys); `npx electron test/ui/pipeline.js` and `npx electron test/ui/overlay-shot.js` (synthetic events through the trigger to a real wheel, both wheels in both themes, the turn and its timing, reduced motion, and screenshots). Dragging a real file and tapping Ctrl or Shift is still a manual check. The page answers every drag with a copy (`dropEffect`), so a file dragged from Explorer with Shift held, which Explorer would otherwise move, is not moved.

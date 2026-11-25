# Image editor

A window that shows pictures, one tab for each. It opens from the Edit wheel (drag a picture, tap Shift, drop it on **Edit**), draws the picture with WebGL2 and sends nothing over the network. It shows pictures and does not change them.

## How it works

1. `src/app/main.js` creates the editor with `createEditor(deps)` and calls `registerIpc()` at start-up. `main.js` requires only `index.js`; `editor.window.js` is loaded the first time a picture is opened.
2. `src/app/drop-flow.js` offers the Edit wheel when every dragged file is a picture (`canEdit`, which is `limits.js`'s `editable` applied to `extOf`). A drop on it calls `open(paths)`.
3. `open(paths)` is served one call at a time. For each path `images.js` checks that it is a file, decodes it once with `readImage` (the conversion feature's, in `engines/builtin/images.js`: upright through the EXIF orientation, converted to sRGB, RGBA, 8 bits) and keeps it under a random 32-byte token. A picture that is open already (the same path, whatever its case) is shown again. At most ten are open (`Too many images open`, `Close one to open another.`). A picture that is refused gets one notice for the whole call: `This image is too large to edit` (over 50 megapixels or 16 384 pixels on a side), `Can't edit an animated image`, or `Can't open this image` with the reason. The page is never given a path.
4. The window opens on the first picture, or, when one is open, receives the new pictures with `imged:opened` and comes to the front. Closing the last tab closes the window and the main process forgets every picture.
5. The page asks `imged:state` for the open pictures, the remembered view and the piece size, then reads each picture's pixels in pieces of 16 MiB with `imged:pixels(token, begin, end)`. Each piece is a copy, because Electron would send the whole of a typed array's buffer for a view of it. When a picture is read the page calls `imged:pixels-done` and the main process frees its copy. The page keeps the pixels with the tab, because it must be able to make the texture again.
6. `ui/render.js` makes a WebGL2 context that does no premultiplying and no colour conversion, uploads a picture as an `RGBA8` texture and builds its mipmaps once. One fragment shader (`ui/shaders.js`) maps each canvas pixel to a picture pixel from the zoom and the picture's place, so a frame costs the pixels on screen whatever the picture's size. Linear filtering is used from 50 % zoom up, mipmaps below it. The texture exists only while its tab is on show.
7. `ui/view.js` holds the zoom and the place of the picture. The canvas is in device pixels, so 100 % is one picture pixel for each screen pixel. Fit leaves 32 px of air and never enlarges a picture past 100 %, the largest zoom is 800 %, and a picture can be pushed until its edge is 32 px inside the window. The buttons, the keys and the double click glide to a zoom in 220 ms (at once with reduced motion); Ctrl and the mouse wheel follow the hand. The zoom value opens a menu of Fit, 25 %, 50 %, 100 %, 200 %, 400 % and 800 %: the one in use is ticked, a zoom below Fit is greyed out, and Up, Down and Esc work in it.
8. The chequerboard is an element behind the canvas, placed over the picture's rectangle and shown only when the picture can be transparent (`hasAlpha` from sharp's metadata). Its two tones are `--check-a` and `--check-b` in `ui/editor.css`.
9. A picture that is larger than the graphics card's texture limit, a page with no WebGL2 and a lost context all show the card **Can't show this image** (`Editing needs graphics acceleration, which is off on this PC.`) in place of the picture.

## Files

| File | Role |
|---|---|
| `index.js` | `createEditor`: opening, the queue, notices, the window, the remembered view. The only file the app requires |
| `images.js` | The open pictures, their tokens, pieces of pixels. No Electron |
| `limits.js` | Ten tabs, 50 megapixels, 16 384 pixels a side, 16 MiB pieces, the formats that can be edited |
| `view.js` | `cleanView`: the valid fields of `imageView`. No Electron |
| `editor.ipc.js` | The `imged:*` handlers; each refuses a sender that is not the editor's page |
| `editor.window.js` | The window, made with `createAppWindow` (`src/shared/electron/windows.js`) |
| `ui/editor.html`, `editor.css`, `editor.js` | The page, its look, the tabs and the tool switch |
| `ui/view.js`, `render.js`, `shaders.js`, `keys.js` | Zoom and pan, WebGL2, the shader, every shortcut in one table |
| `ui/preload.js` | `window.editorApi`; reads a drop and sends its paths on |

## Contracts

- IPC: `imged:state`, `imged:pixels`, `imged:pixels-done`, `imged:close`, `imged:drop`, `imged:show`, `imged:view`, `imged:full-screen` and `imged:close-window` go from the page; `imged:opened` and `imged:full-screen-changed` go to it. `test/unit/app/ipc.test.js` pairs them with their handlers.
- `settings.json` key `imageView`: `{ window, sections, panel }`. `panel` is whether the right panel is open; `sections` is the list of open panel sections, from `light`, `colour`, `grading`, `curve`, `mixer`, `effects` and `detail`. The page can set only `sections` and `panel`, and `cleanView` drops any field that is not valid.
- The page loads under a strict CSP (`script-src 'self'`, no inline style) in its own session (partition `pomelo-editor`), sandboxed, with every http, https, ws and ftp request cancelled.

## Shortcuts

**Ctrl+=**, **Ctrl+-**, **Ctrl+0** (Fit), **Ctrl+1** (100 %), **Ctrl+B** (panel), **F11** (full screen), **Esc** (closes the zoom menu, then leaves full screen), **A**, **P** and **C** (the Adjust, Presets and Crop tools of the panel).

## Testing

`node test/run.js --only=editor-images,editor-limits,editor-view,drop-flow,ipc` runs the unit tests in a few seconds. `npx electron test/ui/editor-shot.js` opens the real window on pictures it makes: a rotated photo, a transparent PNG, a GIF, refused pictures, ten tabs, zoom, the zoom menu, the panel, full screen and the notice for lost graphics. It saves light and dark screenshots in `test/shots` and opens windows, so run it alone.

## Known limits

- It only shows pictures: no tool changes one and there is nothing to save. The panel's three tools (Adjust, Presets, Crop) have no controls.
- Animated pictures are refused, and so is anything over 50 megapixels or 16 384 pixels on a side.
- Each open tab keeps its decoded pixels in the page (4 bytes a pixel), so ten large pictures take a few hundred megabytes.
- The glass window of Windows 11 cannot be captured by the screenshot test; the opaque window is what it checks.

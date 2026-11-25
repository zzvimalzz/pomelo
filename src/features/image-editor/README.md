# Image editor

A window that shows pictures, one tab for each. It opens from the Edit wheel (drag a picture, tap Shift, drop it on **Edit**), draws the picture with WebGL2 and sends nothing over the network. A picture can be turned and flipped, the changes can be undone, and it can be saved over its file or as a copy.

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
10. An edit is a plain object, `{ geometry: { rotate, flipH, flipV } }`, and a tab keeps its history of them (`ui/model.js`): a list of snapshots, at most 100. Undo steps through results, not moves. A change equal to the one on show does nothing; a change drops what could be redone; arriving back at an earlier snapshot (four quarter turns, two flips of one axis) drops the steps after it; a change made by the same control as the last step replaces that step; anything else is a new step. A tab has changes while its snapshot differs from the one last saved, and the page tells the main process with `imged:dirty`, which is how the window knows to hold its closing.
11. `ui/geometry.js` turns the geometry into the size of the shown picture and a 3 x 3 matrix. The shader (`ui/shaders.js`) finds, for each pixel of the canvas, the point of the shown picture and then, through the matrix, the point of the source. The picture is turned first and flipped second, so a flip stays on the same side of the screen, and with one flip on a quarter turn to the right is stored as a turn to the left. A turn glides the canvas from where the picture was in 320 ms and a flip in 300 ms (not with reduced motion); the view of a zoomed picture is turned or mirrored with it. **Compare** (hold the button or `\`) draws the source with no geometry and cross-fades for 120 ms.
12. Save renders the same shader into an `OffscreenCanvas` the size of the result, with the rows counted from the bottom (`uFlip`), and `readPixels` gives raw RGBA, so the file and the screen cannot differ. `imged:save` sends those bytes with `{ mode, format, quality, longEdge, width, height }`. `save-options.js` checks the options and `save.js` checks that the byte count is `width * height * 4`, then asks `writeImage` (the conversion feature's) to encode into a temp file and `replaceFile` to put it in place. A save over the file needs the format to be the file's own and keeps what the file looked like when it was read: if another program changed it the answer is `{ stop: 'changed' }` and the page offers **Save a copy**. A copy asks for a path in the Save dialog; a name with the wrong extension gets the right one added, and a path that is the original itself counts as a save over it. Once a copy is written the main process opens it as a tab and answers `{ ok: true, copy: 'opened' }`, and the page closes the edited tab without asking, because its changes are in the copy. A copy in a format the editor does not open (GIF, PDF) answers `copy: 'written'`: the edited tab stays as it was. A stop that needs saying (`locked`, `read-only`, `no-space`) is said once in the corner of the screen. A copy can be JPG, PNG, WebP, AVIF, HEIC, TIFF, BMP, GIF or PDF: `writeImage` (the conversion feature's) writes all of them, HEIC through the converter's Python helper, which takes a PNG file, so without that engine the answer is `{ stop: 'engine' }` and a sentence about the components to install. HEIC and SVG pictures cannot be written over, so they go straight to Save a copy, with JPG or PNG chosen. JPG, PNG, WebP and AVIF keep the original's EXIF tags with the orientation set to upright; `writeImage` does it by putting the pixels over an 8 x 8 corner of the original. The first Save over a file asks **Replace the original?** once for that tab. Closing a tab, or the window, with changes asks **Save changes to the file?** for each such tab.

## Files

| File | Role |
|---|---|
| `index.js` | `createEditor`: opening, the queue, notices, the window, the remembered view. The only file the app requires |
| `images.js` | The open pictures, their tokens, pieces of pixels. No Electron |
| `limits.js` | Ten tabs, 50 megapixels, 16 384 pixels a side, 16 MiB pieces, the formats that can be edited and the ones that can be written |
| `save.js` | Checks the pixels the page sends, encodes them and puts the file in place. No Electron |
| `save-options.js` | `check`: a clean copy of the save options, or an error. No Electron |
| `view.js` | `cleanView`: the valid fields of `imageView`. No Electron |
| `editor.ipc.js` | The `imged:*` handlers; each refuses a sender that is not the editor's page |
| `editor.window.js` | The window, made with `createAppWindow` (`src/shared/electron/windows.js`) |
| `ui/editor.html`, `editor.css`, `editor.js` | The page, its look, the tabs, the tool switch, the edits and saving |
| `ui/view.js`, `render.js`, `shaders.js`, `keys.js` | Zoom and pan, Compare, WebGL2 and export, the shader, every shortcut in one table |
| `ui/geometry.js`, `model.js` | Turn and flip maths, the edit and its history |
| `ui/dialogs.js` | The cards: Replace the original, Save changes, Save a copy |
| `ui/preload.js` | `window.editorApi`; reads a drop and sends its paths on |

## Contracts

- IPC: `imged:state`, `imged:pixels`, `imged:pixels-done`, `imged:close`, `imged:drop`, `imged:show`, `imged:view`, `imged:full-screen`, `imged:save`, `imged:dirty` and `imged:close-window` go from the page; `imged:opened`, `imged:closing` and `imged:full-screen-changed` go to it. `test/unit/app/ipc.test.js` pairs them with their handlers.
- `settings.json` key `imageView`: `{ window, sections, panel }`. `panel` is whether the right panel is open; `sections` is the list of open panel sections, from `light`, `colour`, `grading`, `curve`, `mixer`, `effects` and `detail`. The page can set only `sections` and `panel`, and `cleanView` drops any field that is not valid.
- The page loads under a strict CSP (`script-src 'self'`, no inline style) in its own session (partition `pomelo-editor`), sandboxed, with every http, https, ws and ftp request cancelled.

## Shortcuts

**Ctrl+Z** (Undo), **Ctrl+Y** or **Ctrl+Shift+Z** (Redo), **Ctrl+S** (Save), **Ctrl+Shift+S** (Save a copy), **R** and **Shift+R** (turn right and left), **\\** (hold to Compare), **Ctrl+=**, **Ctrl+-**, **Ctrl+0** (Fit), **Ctrl+1** (100 %), **Ctrl+B** (panel), **F11** (full screen), **Esc** (closes a card, the More menu or the zoom menu, then leaves full screen), **A**, **P** and **C** (the Adjust, Presets and Crop tools of the panel). Single keys do nothing while a card is up or a field has the focus.

## Testing

`node test/run.js --only=editor-images,editor-limits,editor-view,editor-save-options,editor-save,editor-geometry,editor-model,drop-flow,ipc` runs the unit tests in a few seconds. `editor-save` writes real files with sharp. `npx electron test/ui/editor-shot.js` opens the real window on pictures it makes: a rotated photo, a transparent PNG, a GIF that is not offered the editor, refused pictures, ten tabs, zoom, the zoom menu, the panel, full screen, the notice for lost graphics, then turning, flipping, undo, Compare, Save a copy, Save over a file, closing with changes, a read-only file and a check that the screen and the saved file agree. It saves light and dark screenshots in `test/shots` and opens windows, so run it alone.

## Known limits

- The only edits are turning and flipping, in the Crop tool. The Adjust and Presets tools have no controls yet, and Crop has no frame.
- Save sends the whole picture to the main process in one message (200 MB at 50 megapixels) and needs free space of that size plus 64 MB on the target drive. A JPG is written with plain libjpeg, about 15 % larger than the converter's.
- GIF and BMP are written flat (a GIF has no partial transparency, a BMP none at all), and a TIFF, GIF, BMP, PDF or HEIC carries no EXIF.
- A GIF is not opened in the editor, whether or not it is animated; it can still be a format of a copy.
- Animated pictures are refused, and so is anything over 50 megapixels or 16 384 pixels on a side.
- Each open tab keeps its decoded pixels in the page (4 bytes a pixel), so ten large pictures take a few hundred megabytes.
- The glass window of Windows 11 cannot be captured by the screenshot test; the opaque window is what it checks.

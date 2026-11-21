# PDF workspace

A window that reads a PDF. It opens from the tray menu (**Open a PDF…**) and from the command line (`--open=<path>`), and shows the document with pdf.js. It works with no engine installed and sends nothing over the network.

## How it works

1. `src/app/main.js` creates the workspace with `createWorkspace(deps)` and calls `registerIpc()` at start-up. `main.js` requires only `index.js`; `workspace.window.js` is loaded the first time a PDF is opened.
2. `open(paths)` opens the first path in `documents.js`: one read handle that stays open until the window closes, a random 32-byte token, the file's name and size. A file that cannot be read stops there with a notice in the corner of the screen (`notify`). While a window is open a later call only brings it to the front.
3. `workspace.window.js` makes the window (below) and loads `ui/workspace.html`. The page asks `pdfws:state` which document it was opened for, and shows its name in the title row.
4. `ui/viewer.js` opens the document with pdf.js. The page never gets a path and never asks for the whole file: pdf.js is given a `PDFDataRangeTransport` whose `requestDataRange` calls `pdfws:read(token, begin, end)`, and the main process reads that range from the held handle. `loadOptions()` is the one place the `getDocument` options are set. A request larger than 4 MiB is read in pieces and handed to pdf.js as one, because pdf.js answers one request with one call.
5. `PDFViewer` draws the pages as the user scrolls and fits the first one to the window.
6. A password-protected file makes pdf.js ask for a password. `ui/dialogs.js` shows the card, `viewer.js` gives the answer to pdf.js and gives up after three wrong ones or on Cancel. Only once pdf.js has accepted a password does the page send it to the main process with `pdfws:unlock`; `documents.js` keeps it as a `Buffer` in a private map, away from the document's record, and overwrites it with zeros when the window closes. The page forgets it at once, and the card's field is emptied before the card goes.
7. `ui/comments-margin.js` listens for `annotationlayerrendered`, reads the page's annotations from pdf.js and draws a marker for each comment (below). It reads only the pages pdf.js has drawn, so a large file is never scanned for them.

## Comments

A comment is a Text (note), Highlight, Underline, StrikeOut, Squiggly, Ink, Square, Circle, Line, Polygon, PolyLine, Caret or Stamp annotation with text in its contents. Free text is left out: its contents are what it shows. Each comment becomes a 26 x 24 px marker 10 px outside the page, level with the first box it covers, never closer than 28 px to the one above. Position and size are kept as fractions of the page, so a zoom moves them without being worked out again. On the left page of a two-page view the markers are on its left; with under 46 px beside the page they move 8 px inside its edge. A marker opens a 240 px card (author and date when the file has them, then the text) and lights what it is about: a wash and underline on commented text, a ring on a note, an outline on any other annotation. The card is closed by the marker, a click elsewhere, or Esc. pdf.js's own note icons and popups are hidden in `workspace.css`, so the page shows nothing of a comment. A marker belongs to the page element, so pdf.js removes it with the page's drawing and it is built again when the page is drawn.

The window is frameless with `titleBarStyle: 'hidden'`. The title row is part of the page and Windows draws the minimise, maximise and close buttons over its right-hand end, in colours that follow the theme. On Windows 11 (build 22621 or later) the window has an acrylic background that the wheel's `--plate` colour tints. Before that, or when `createWorkspace` is given `solid: true`, the window is opaque and the page gets the `solid` class (through `?solid=1`) so `workspace.css` paints the title bar colour of Settings.

The window's size, place and maximised state are saved in `pdfView.window` of `settings.json` after the user pauses, and when the window closes. `bounds.js` decides where it opens: the saved place if at least 100 px of its title row is on a screen, otherwise 1200 × 800 in the middle of the main screen. The minimum size is 900 × 600.

## Files

| File | Role |
|---|---|
| `index.js` | `createWorkspace(deps)`: `open(paths)`, `openDialog()`, `registerIpc()`, `closeAll()` |
| `documents.js` | The open documents: tokens, held handles, `read(token, begin, end)` with its bounds checks, the count of bytes served, `unlock(token, password)`. No Electron |
| `bounds.js` | `startBounds(saved, workAreas)`: where the window opens. No Electron |
| `workspace.window.js` | The window, its offline session, the open dialog |
| `workspace.ipc.js` | `pdfws:state`, `pdfws:read` and `pdfws:unlock`; all refuse any sender but the workspace window |
| `ui/` | `workspace.html`, `workspace.css`, `workspace.js` (start-up, title row, failure message), `viewer.js` (`loadOptions`, the transport, the password loop, the viewer), `comments-margin.js` (markers and cards), `dialogs.js` (the password card), `preload.js` |

## Contracts

- Command line: `--open=<path>`. A relative path starts from the folder the command was run in. A start with this switch opens no Settings window.
- IPC channels: `pdfws:state`, `pdfws:read` and `pdfws:unlock` (page to main). `pdfws:unlock` takes a token and a password of 1 to 4096 characters and refuses anything else; nothing logs its arguments. `pdfws:read` takes a token and two integers and refuses an unknown token, a non-integer, a negative start, an end past the size of the file and a span over 4 MiB. It reads only from the handle held since the file was opened, so a file replaced or deleted afterwards cannot change what the window shows, and a file cut short is an error, never padding.
- Settings key `pdfView`: `{ window: { x, y, width, height, maximised } | null }`. The page cannot change it; the main process writes it.
- The window's session (the in-memory partition `pomelo-workspace`) cancels every `http`, `https`, `ws`, `wss` and `ftp` request and refuses every permission. The page's Content-Security-Policy is `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; worker-src 'self'`. It does not reach pdf.js's worker, which is why the session also blocks the network.
- pdf.js is the exact version pinned in `package.json` (`6.5.438`), loaded from `node_modules/pdfjs-dist` by file URL. Its cMaps, standard fonts, WASM decoders and colour profiles load from the same folder, and `useWorkerFetch: true` is what lets the worker read them from `file:` URLs.
- Text from a document (its file name, the author and text of a comment) is put in the page with `textContent`.
- The page's scroll bar is a thin thumb that is transparent until the pages scroll (the `scrolling` class stays 0.9 s after the last scroll) or the pointer is over them.

## Testing

```
node test/run.js --tier=unit --only=workspace-documents,workspace-bounds,ipc,tray,shell-menu
node test/run.js --tier=ui --only=workspace-shot
```

`workspace-shot` (about 45 s, opens real windows: leave the mouse alone) opens PDFs drawn with pdf-lib: the window's size and place in both themes, the glass and the opaque window, the `loadOptions()` values, the network and path limits, the remembered place, a second start, a file with a note and two highlights that carry comments (markers, their cards and light, two-page view, no room beside the page, scroll bars), a file encrypted by `test/support/encrypted-pdf.js` (the password card, a wrong password, which calls carry the password, Cancel, three wrong passwords), a 41 MB file with 3 000 pages (bytes served to the first page, over five idle seconds and after scrolling 50 pages), a file that is not a PDF and a file that is missing. It saves screenshots to `test/shots/`.

## Known limits

- One document per window. A second start brings the window to the front and opens nothing else.
- Reading only: pages scroll and are fitted to the window. There is no zoom, search, side panel or toolbar.
- Comments are listed only for pages pdf.js has drawn, and cannot be edited or deleted. A reply is shown as a marker of its own.
- Markers are rebuilt when a page is drawn again, so an open comment closes when its page is zoomed.

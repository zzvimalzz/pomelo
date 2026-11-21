# PDF workspace

A window that reads a PDF. It opens from the tray menu (**Open a PDF…**) and from the command line (`--open=<path>`), and shows the document with pdf.js. It works with no engine installed and sends nothing over the network.

## How it works

1. `src/app/main.js` creates the workspace with `createWorkspace(deps)` and calls `registerIpc()` at start-up. `main.js` requires only `index.js`; `workspace.window.js` is loaded the first time a PDF is opened.
2. `open(paths)` opens the first path in `documents.js`: one read handle that stays open until the window closes, a random 32-byte token, the file's name and size. A file that cannot be read stops there with a notice in the corner of the screen (`notify`). While a window is open a later call only brings it to the front.
3. `workspace.window.js` makes the window (below) and loads `ui/workspace.html`. The page asks `pdfws:state` which document it was opened for, and shows its name in the title row.
4. `ui/viewer.js` opens the document with pdf.js. The page never gets a path and never asks for the whole file: pdf.js is given a `PDFDataRangeTransport` whose `requestDataRange` calls `pdfws:read(token, begin, end)`, and the main process reads that range from the held handle. `loadOptions()` is the one place the `getDocument` options are set. A request larger than 4 MiB is read in pieces and handed to pdf.js as one, because pdf.js answers one request with one call.
5. `PDFViewer` draws the pages as the user scrolls and fits the first one to the window.

The window is frameless with `titleBarStyle: 'hidden'`. The title row is part of the page and Windows draws the minimise, maximise and close buttons over its right-hand end, in colours that follow the theme. On Windows 11 (build 22621 or later) the window has an acrylic background that the wheel's `--plate` colour tints. Before that, or when `createWorkspace` is given `solid: true`, the window is opaque and the page gets the `solid` class (through `?solid=1`) so `workspace.css` paints the title bar colour of Settings.

The window's size, place and maximised state are saved in `pdfView.window` of `settings.json` after the user pauses, and when the window closes. `bounds.js` decides where it opens: the saved place if at least 100 px of its title row is on a screen, otherwise 1200 × 800 in the middle of the main screen. The minimum size is 900 × 600.

## Files

| File | Role |
|---|---|
| `index.js` | `createWorkspace(deps)`: `open(paths)`, `openDialog()`, `registerIpc()`, `closeAll()` |
| `documents.js` | The open documents: tokens, held handles, `read(token, begin, end)` with its bounds checks, the count of bytes served. No Electron |
| `bounds.js` | `startBounds(saved, workAreas)`: where the window opens. No Electron |
| `workspace.window.js` | The window, its offline session, the open dialog |
| `workspace.ipc.js` | `pdfws:state` and `pdfws:read`; both refuse any sender but the workspace window |
| `ui/` | `workspace.html`, `workspace.css`, `workspace.js` (start-up, title row, failure message), `viewer.js` (`loadOptions`, the transport, the viewer), `preload.js` |

## Contracts

- Command line: `--open=<path>`. A relative path starts from the folder the command was run in. A start with this switch opens no Settings window.
- IPC channels: `pdfws:state` and `pdfws:read` (page to main). `pdfws:read` takes a token and two integers and refuses an unknown token, a non-integer, a negative start, an end past the size of the file and a span over 4 MiB. It reads only from the handle held since the file was opened, so a file replaced or deleted afterwards cannot change what the window shows, and a file cut short is an error, never padding.
- Settings key `pdfView`: `{ window: { x, y, width, height, maximised } | null }`. The page cannot change it; the main process writes it.
- The window's session (the in-memory partition `pomelo-workspace`) cancels every `http`, `https`, `ws`, `wss` and `ftp` request and refuses every permission. The page's Content-Security-Policy is `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; worker-src 'self'`. It does not reach pdf.js's worker, which is why the session also blocks the network.
- pdf.js is the exact version pinned in `package.json` (`6.5.438`), loaded from `node_modules/pdfjs-dist` by file URL. Its cMaps, standard fonts, WASM decoders and colour profiles load from the same folder, and `useWorkerFetch: true` is what lets the worker read them from `file:` URLs.
- Text from a document (its file name) is put in the page with `textContent`.

## Testing

```
node test/run.js --tier=unit --only=workspace-documents,workspace-bounds,ipc,tray,shell-menu
node test/run.js --tier=ui --only=workspace-shot
```

`workspace-shot` (about 25 s, opens real windows: leave the mouse alone) opens PDFs drawn with pdf-lib: the window's size and place in both themes, the glass and the opaque window, the `loadOptions()` values, the network and path limits, the remembered place, a second start, a 40 MB file with 300 pages (bytes served to the first page and over five idle seconds), a file that is not a PDF and a file that is missing. It saves screenshots to `test/shots/`.

## Known limits

- One document per window. A second start brings the window to the front and opens nothing else.
- Reading only: pages scroll and are fitted to the window. There is no zoom, search, side panel or toolbar.
- A password-protected file is not opened; the window says so.

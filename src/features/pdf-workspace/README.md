# PDF workspace

A window that reads a PDF. It opens from the tray menu (**Open a PDF…**) and from the command line (`--open=<path>`), and shows the document with pdf.js. It works with no engine installed and sends nothing over the network.

## How it works

1. `src/app/main.js` creates the workspace with `createWorkspace(deps)` and calls `registerIpc()` at start-up. `main.js` requires only `index.js`; `workspace.window.js` is loaded the first time a PDF is opened.
2. `open(paths)` opens the first path in `documents.js`: one read handle that stays open until the window closes, a random 32-byte token, the file's name and size. A file that cannot be read stops there with a notice in the corner of the screen (`notify`). While a window is open a later call only brings it to the front.
3. `workspace.window.js` makes the window (below) and loads `ui/workspace.html`. The page asks `pdfws:state` which document it was opened for, and shows its name in the title row.
4. `ui/viewer.js` opens the document with pdf.js. The page never gets a path and never asks for the whole file: pdf.js is given a `PDFDataRangeTransport` whose `requestDataRange` calls `pdfws:read(token, begin, end)`, and the main process reads that range from the held handle. `loadOptions()` is the one place the `getDocument` options are set. A request larger than 4 MiB is read in pieces and handed to pdf.js as one, because pdf.js answers one request with one call.
5. `PDFViewer` draws the pages as the user scrolls and fits the first one to the window. A fit (Fit page or Fit width) is applied again when the window is resized; a zoom the user chose is left alone.
6. A password-protected file makes pdf.js ask for a password. `ui/dialogs.js` shows one card for the whole open, headed by the file as a PDF icon with a lock on it (the icon is drawn by the wheel's `wheel-icons.js`), with an eye button that shows or hides what is typed, and `viewer.js` gives each answer to pdf.js and gives up after five wrong ones or on Cancel. The button is off until something is typed. While pdf.js checks a password the field and the button rest (the button shows a spinner) and Cancel stops the check. A wrong password is answered in the same card: the field turns red and shakes once, **Wrong Password** appears under it, what was typed stays selected, and the button reads **Try Again**. The card is removed, and its field emptied, when the open ends. When it gives up, the page says the file is password-protected and its **Unlock** button runs the whole open again, with a fresh count. Only once pdf.js has accepted a password does the page send it to the main process with `pdfws:unlock`; `documents.js` keeps it as a `Buffer` in a private map, away from the document's record, and overwrites it with zeros when the window closes. The page forgets it at once, and the card's field is emptied before the card goes.
7. `ui/dock.js` builds the dock in the document area once pdf.js has the page count (below). `ui/focus.js` runs focus reading (below). `ui/keys.js` holds every shortcut in one table.
8. `ui/comments-margin.js` listens for `annotationlayerrendered`, reads the page's annotations from pdf.js and draws a marker for each comment (below). It reads only the pages pdf.js has drawn, so a large file is never scanned for them.
9. `ui/sidebar.js` builds the Pages panel the first time the title row's button opens it, and `ui/thumbs.js` draws its thumbnails (below).

## The dock

A glass bar at the bottom centre of the document area, with two groups. **Pages**: Previous, a page box (as wide as its digits, so the page and the total sit in the middle between the arrows) that shows the current page and, with a number and Enter, goes to that page (a number past the end goes to the last page, anything else is ignored), and Next. **Zoom**: Zoom out, the zoom value and Zoom in. The value reads `Fit page`, `Fit width` or a percentage, and opens the View menu: Zoom (`Fit width`, `Fit page`, `Actual size`) and Layout (`Continuous`, `Two pages side by side`, which sets `spreadMode`). The menu closes on a choice, on a click elsewhere or on Esc, and Up and Down move between its items. Zoom buttons and keys step by pdf.js's own steps round the middle of the view. Ctrl and the mouse wheel zoom wherever the pointer is in the window, round the pointer when it is over the document area: the listener is on `window`, turns add up and every 100 (one mouse notch) is a step, so quick turns are never dropped and a trackpad pinch, which sends many small ones, still moves in steps. pdf.js is given the point to hold still in the coordinates of the well, which is the scroller's offset parent.

The dock stays where it is while the document scrolls. A round 36 px button stands just past its end (below a column) and folds it away: the bar slides off the edge it stands at, and 260 ms in the button glides to the middle of the dock's place; pressed again, the button moves aside first and the bar slides back 180 ms later. A folded dock is `inert`, so Tab and the pointer pass it by. The bar (`.dock`) and its button sit in one holder (`.dockwrap`) that carries the place, the drag and the focus-reading slide, so the button is placed by CSS alone and follows the bar through a drag, a resize and focus reading. The fold is not kept: a new window starts with the dock showing. The dock is nearly opaque (`--dock`, 97 %) and `user-select: none`, so highlighted text under it does not show through and nothing can be selected from it. A pill in the top middle of the pages names the page for a moment when the page changes while the dock is folded or in focus reading. Buttons do not take the focus, so keys keep acting on the document. Page Down, Page Up and the arrows only turn pages in focus reading; otherwise the focused scroller does what it does.

## Where the dock stands

The grip at the start end of the dock (a dotted texture; **Drag to move**) is held and dragged. While it is dragged the dock follows the pointer and four dashed places are marked, the one nearest the pointer in the accent: the middle of the bottom edge (the default), top, left and right. On release the dock eases to that place; at the left and right it is a column 76 px wide, its page arrows point up and down (they scroll), the page and the total are stacked without the slash, and its View menu opens beside it; at the top the menu opens below. With the grip focused the arrow keys move it the same way. `dock-place.js` does this and `well[data-dock]` carries the side, which `workspace.css` reads; the fold button, the edge handle, the page pill and focus reading all follow it. The dock eases to its new place in 480 ms while its button stays fixed to it. A click on the grip without a drag changes nothing.

The place is kept in `pdfView.dock` and has no time limit. The page asks the main process to keep it with `pdfws:dock`, which accepts only `bottom`, `top`, `left` or `right`; a stored value that is anything else opens at the bottom.

## The Pages panel

The button at the left of the title row (**Pages**) slides a 214 px panel open beside the document area, which gives up that room; pressed again it slides shut. The panel is part of the glass, with no frame of its own. It shows one entry for every page: a white sheet 120 px wide (a very tall page is held to 240 px high) with the page number under it. The page in view has an accent outline and the panel scrolls to keep it in view; a click on an entry goes to that page and returns the keys to the document. Only the current entry is in the Tab order. The button is off until pdf.js has the page count and shows an accent tint while the panel is open.

Nothing is built until the panel is first opened. Entries are plain buttons whose sheets are sized from the viewer's page sizes; an `IntersectionObserver` on the panel's scroll area (300 px of margin above and below) asks `thumbs.js` for the pages that come into view and lets go of the ones that leave. Shut, the panel's list is `hidden`, so no thumbnail is asked for. `thumbs.js` draws the pages that are asked for one at a time, in the order they were asked, with a pause between two so the main view is never starved; a page that leaves the view while it is being drawn is cancelled. Each is drawn at 120 CSS px at the screen's pixel density (at most twice) into one scratch canvas and kept as an `ImageBitmap`. The last 300 bitmaps are kept, the least recently shown dropped and closed, and a page that is still kept is painted at once when it comes back into view. A thumbnail's canvas lives only while its entry is near the view, so the page count never decides how many canvases exist. In focus reading the panel is not shown, and it comes back as it was.

## Focus reading

The button at the right of the title row, or F11, asks the main process for full screen with `pdfws:focus`. The window answers with `pdfws:focus-changed` when it enters or leaves, and the page changes only then, so leaving by any other route is followed too. In focus reading the title row slides up and the dock down, a faint handle at the bottom edge hints at the dock, the zoom becomes Fit page and the zoom the user had is put back when it ends. The title row returns while the pointer is within 56 px of the top, the dock within 120 px of the edge it stands at (a dock at the top stands below the title row); the dock also stays while the focus is inside it. Esc goes through the open card, menu or field first (they use the key and mark it handled) and leaves focus reading last. The window's size and place are not stored while it is full screen.

## Keys

`ui/keys.js` is the one table of shortcuts: the keys of each action and the text shown in its tooltip. `bind(id, fn)` gives an action its handler; the first handler that does not return `false` takes the key and the page's default is cancelled. Keys are ignored while a text field has the focus, apart from Ctrl combinations and F11. The listener is on `window` so a card that closes itself on Esc has used the key first.

| Keys | Action |
|---|---|
| Ctrl+0, Ctrl+1 | Fit width, actual size |
| Ctrl+= or Ctrl+plus, Ctrl+minus | Zoom in, zoom out |
| F11 | Focus reading |
| Page Down, Right, Down; Page Up, Left, Up | Next, previous page (focus reading) |
| Esc | Close the menu, then leave focus reading |

## Comments

A comment is a Text (note), Highlight, Underline, StrikeOut, Squiggly, Ink, Square, Circle, Line, Polygon, PolyLine, Caret or Stamp annotation with text in its contents. Free text is left out: its contents are what it shows. Each comment becomes a 26 x 24 px marker 10 px outside the page, level with the first box it covers, never closer than 28 px to the one above. Position and size are kept as fractions of the page, so a zoom moves them without being worked out again. On the left page of a two-page view the markers are on its left; with under 46 px beside the page they move 8 px inside its edge. A marker opens a 240 px card (author and date when the file has them, then the text) and lights what it is about: a wash and underline on commented text, a ring on a note, an outline on any other annotation. The card is closed by the marker, a click elsewhere, or Esc. pdf.js's own note icons and popups are hidden in `workspace.css`, so the page shows nothing of a comment. A marker belongs to the page element, so pdf.js removes it with the page's drawing and it is built again when the page is drawn.

The window is frameless with `titleBarStyle: 'hidden'`. The title row is part of the page and Windows draws the minimise, maximise and close buttons over its right-hand end, in colours that follow the theme. On Windows 11 (build 22621 or later) the window has an acrylic background that the wheel's `--plate` colour tints. Before that, or when `createWorkspace` is given `solid: true`, the window is opaque and the page gets the `solid` class (through `?solid=1`) so `workspace.css` paints the title bar colour of Settings.

The window's size, place and maximised state are saved in `pdfView.window` of `settings.json` after the user pauses, and when the window closes, with the time (`savedAt`). `bounds.js` decides where it opens: the saved place if it was saved in the last 24 hours and at least 100 px of its title row is on a screen, otherwise 1200 × 800, not maximised, in the middle of the main screen. A place saved without `savedAt` counts as old. The minimum size is 900 × 600.

## Files

| File | Role |
|---|---|
| `index.js` | `createWorkspace(deps)`: `open(paths)`, `openDialog()`, `registerIpc()`, `closeAll()` |
| `documents.js` | The open documents: tokens, held handles, `read(token, begin, end)` with its bounds checks, the count of bytes served, `unlock(token, password)`. No Electron |
| `bounds.js` | `startBounds(saved, workAreas)`: where the window opens. No Electron |
| `workspace.window.js` | The window, its offline session, the open dialog, and the full-screen events it sends to the page |
| `workspace.ipc.js` | `pdfws:state`, `pdfws:read`, `pdfws:unlock`, `pdfws:focus` and `pdfws:dock`; all refuse any sender but the workspace window |
| `ui/` | `workspace.html`, `workspace.css`, `workspace.js` (start-up, title row, failure message), `viewer.js` (`loadOptions`, the transport, the password loop, the viewer), `comments-margin.js` (markers and cards), `dialogs.js` (the password card), `dock.js` (the dock, the View menu, the fold button), `dock-place.js` (the grip and the four places), `focus.js` (focus reading), `keys.js` (the shortcut table), `sidebar.js` (the Pages panel and its button), `thumbs.js` (thumbnail drawing and the bitmap cache), `preload.js` |

## Contracts

- Command line: `--open=<path>`. A relative path starts from the folder the command was run in. A start with this switch opens no Settings window.
- IPC channels: `pdfws:state`, `pdfws:read`, `pdfws:unlock`, `pdfws:focus` and `pdfws:dock` (page to main), `pdfws:focus-changed` (main to page, a boolean). `pdfws:focus` takes a boolean; anything but `true` leaves full screen. `pdfws:dock` takes one of the four sides and ignores anything else. `pdfws:unlock` takes a token and a password of 1 to 4096 characters and refuses anything else; nothing logs its arguments. `pdfws:read` takes a token and two integers and refuses an unknown token, a non-integer, a negative start, an end past the size of the file and a span over 4 MiB. It reads only from the handle held since the file was opened, so a file replaced or deleted afterwards cannot change what the window shows, and a file cut short is an error, never padding.
- Settings key `pdfView`: `{ window: { x, y, width, height, maximised } | null, dock: 'bottom' | 'top' | 'left' | 'right' }`. The page cannot change it; the main process writes it.
- The window's session (the in-memory partition `pomelo-workspace`) cancels every `http`, `https`, `ws`, `wss` and `ftp` request and refuses every permission. The page's Content-Security-Policy is `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; worker-src 'self'`. It does not reach pdf.js's worker, which is why the session also blocks the network.
- pdf.js is the exact version pinned in `package.json` (`6.5.438`), loaded from `node_modules/pdfjs-dist` by file URL. Its cMaps, standard fonts, WASM decoders and colour profiles load from the same folder, and `useWorkerFetch: true` is what lets the worker read them from `file:` URLs.
- Text from a document (its file name, the author and text of a comment) is put in the page with `textContent`.
- The scroll bars of the pages and of the Pages panel are thin thumbs that is transparent until the area scrolls (the `scrolling` class stays 0.9 s after the last scroll) or the pointer is over it.

## Testing

```
node test/run.js --tier=unit --only=workspace-documents,workspace-bounds,ipc,tray,shell-menu
node test/run.js --tier=ui --only=workspace-shot
```

`workspace-shot` (about 3 min, opens real windows: leave the mouse alone) opens PDFs drawn with pdf-lib: the window's size and place in both themes, the glass and the opaque window, the `loadOptions()` values, the network and path limits, the remembered place, a second start, a file with a note and two highlights that carry comments (markers, their cards and light, two-page view, no room beside the page, scroll bars), a file encrypted by `test/support/encrypted-pdf.js` (the password card and its eye button, a wrong password, which calls carry the password, Cancel and Unlock, five wrong passwords), the dock (its buttons and tooltips, the page box and its centring, every zoom key and button, the View menu, a fit that follows the window and a chosen zoom that does not, the point under the pointer when Ctrl and the wheel zoom, the fold button), Ctrl and the wheel with real input over the page, the dock and the title row, the dock dragged to each of the four places (the marked places, the menu beside it, the saved place, the arrow keys, a value the page may not store), focus reading (full screen, the edges, Tab, page turning, F11 and Esc, the zoom restored, the saved place unchanged), the Pages panel (shut with nothing drawn, its width and the room it takes, the thumbnails' size and proportions, a click, the outline following the page, shutting and reopening, focus reading, the smallest window), a 41 MB file with 3 000 pages (bytes served to the first page, over five idle seconds and after scrolling 50 pages, then the panel walked through hundreds of pages to show the cache stops at 300), a file that is not a PDF and a file that is missing. It saves screenshots to `test/shots/`.

## Known limits

- One document per window. A second start brings the window to the front and opens nothing else.
- Reading only: pages scroll, zoom and lay out one or two across. There is no search, outline, tool or remembered zoom or panel state: each window starts at Fit page with the Pages panel shut.
- Comments are listed only for pages pdf.js has drawn, and cannot be edited or deleted. A reply is shown as a marker of its own.
- Markers are rebuilt when a page is drawn again, so an open comment closes when its page is zoomed.

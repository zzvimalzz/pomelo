# UI shared

What the wheel, toast, settings, downloader and PDF pages have in common. The pages are classic scripts under a strict Content-Security-Policy (`'self'` only), and files in this folder load with a plain `<link>` or `<script src="../ui-shared/...">`.

| File | Role |
|---|---|
| `tokens.css` | Accent, text, ok and error colours, the divider line, the font stack, the surface colours (`--bg`, `--chrome`, `--side`, `--card`, `--raise`), the muted, hover and off tints, `--ok-bg`, `--lift`, `--ease`, and their dark-mode values. Load it before the page's own CSS; a page that needs another value sets it in its own `:root` |
| `controls.css` | The reset, `small`, `.muted`, `kbd`, the focus ring, the `.i` icon size, the title bar (`.titlebar`, `.brand`, `.search`, `.controls`) and `.btn` with its `primary` and `danger` variants. Load it after `tokens.css` and before the page's own CSS |
| `dom.js` | `window.pomeloUi.el(tag, cls, text)` makes an element |
| `icons.js` | `window.pomeloUi.icon(name)` returns the markup of a line icon (`sliders`, `palette`, `cpu`, `refresh`, `activity`, `info`, `external`, `copy`, `file`, `check`, `ban`, `comment`, `lock`, `eye`, `eye-off`, `help`, `left`, `right`, `minus`, `plus`, `expand`, `shrink`), drawn at the `.i` size. Load it after `dom.js` |
| `window.css` | The look of a window with a glass title row: the window colours and spacing tokens (`--solid`, `--well`, `--bar`, `--dock`, `--field*`, `--accent-soft`, `--accent-ink` and more, with dark values), `.window`, `.titlerow`, the name line, `.tabs` and `.tab`, `.ib` buttons, `.body`, `.panel` and `.inner`, the `.seg3` switch, `.sidehead`, `.scanline`, `.scrolly` with its scroll bar, and the card (`.veil`, `.card`, `.uhead`, `.badge`, `.spin`). Load it after the other style sheets and before the page's own |
| `tabs.js` | `window.pomeloTabs.create(strip)` draws a row of tabs in the element `strip` and returns `{ render(docs, active), bind({ select, close }) }`; it handles the click, the keys and the scrolling of a long row |
| `card.js` | `window.pomeloCard`: `frame(host)` puts a card over a veil inside `host` and makes everything round it inert, returning `{ box, close }`; `loop(e, stops)` keeps Tab inside the card; `isOpen()` says whether a card is up |
| `wheel-shapes.js` | `window.pomeloWheelShapes`: the wheel's size and radii, `segmentPath(mid, step)`, `ringPath()` (one target that fills the whole ring), `pt` and `svg(tag, attrs, parent)` for SVG elements |
| `wheel-look.css` | How segments, the plate and the centre disc look, with the wheel's light and dark colours |
| `wheel-glyphs.js` | `window.pomeloGlyphs`: the small white picture of every format Pomelo reads |
| `wheel-icons.js`, `wheel-icons.css` | `window.pomeloIcons.draw(el, parent, info, cx, cy)` draws the file or folder icon of a format (put `picon` on the parent group); `addDefs` adds the gradient it needs |

This folder holds only what two or more pages use.

## Testing

`npm run test:ui` loads every page. Screenshots go to `test/shots/`.

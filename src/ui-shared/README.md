# UI shared

What the wheel, toast, settings and downloader pages have in common. The pages are classic scripts under a strict Content-Security-Policy (`'self'` only), and files in this folder load with a plain `<link>` or `<script src="../ui-shared/...">`.

| File | Role |
|---|---|
| `tokens.css` | Accent, text, ok and error colours, the divider line, the font stack, the surface colours (`--bg`, `--chrome`, `--side`, `--card`, `--raise`), the muted, hover and off tints, `--ok-bg`, `--lift`, `--ease`, and their dark-mode values. Load it before the page's own CSS; a page that needs another value sets it in its own `:root` |
| `controls.css` | The reset, `small`, `.muted`, `kbd`, the focus ring, the `.i` icon size, the title bar (`.titlebar`, `.brand`, `.search`, `.controls`) and `.btn` with its `primary` and `danger` variants. Load it after `tokens.css` and before the page's own CSS |
| `dom.js` | `window.pomeloUi.el(tag, cls, text)` makes an element |
| `icons.js` | `window.pomeloUi.icon(name)` returns the markup of a line icon (`sliders`, `palette`, `cpu`, `refresh`, `activity`, `info`, `external`, `copy`, `file`, `help`), drawn at the `.i` size. Load it after `dom.js` |
| `wheel-shapes.js` | `window.pomeloWheelShapes`: the wheel's size and radii, `segmentPath(mid, step)`, `pt` and `svg(tag, attrs, parent)` for SVG elements |
| `wheel-look.css` | How segments, the plate and the centre disc look, with the wheel's light and dark colours |
| `wheel-glyphs.js` | `window.pomeloGlyphs`: the small white picture of every format Pomelo reads |
| `wheel-icons.js`, `wheel-icons.css` | `window.pomeloIcons.draw(el, parent, info, cx, cy)` draws the file or folder icon of a format (put `picon` on the parent group); `addDefs` adds the gradient it needs |

This folder holds only what two or more pages use.

## Testing

`npm run test:ui` loads every page. Screenshots go to `test/shots/`.

# UI shared

What the wheel, toast, settings, downloader and guide pages have in common. The pages are classic scripts under a strict Content-Security-Policy (`'self'` only), and files in this folder load with a plain `<link>` or `<script src="../ui-shared/...">`.

| File | Role |
|---|---|
| `tokens.css` | Accent, text, ok and error colours, the divider line, the font stack, and the dark-mode values of the text and line colours. Load it before the page's own CSS; a page that needs another value sets it in its own `:root` |
| `dom.js` | `window.pomeloUi.el(tag, cls, text)` makes an element |
| `wheel-shapes.js` | `window.pomeloWheelShapes`: the wheel's size and radii, `segmentPath(mid, step)`, `pt` and `svg(tag, attrs, parent)` for SVG elements |
| `wheel-look.css` | How segments, the plate and the centre disc look, with the wheel's light and dark colours |
| `wheel-glyphs.js` | `window.pomeloGlyphs`: the small white picture of every format Pomelo reads |
| `wheel-icons.js`, `wheel-icons.css` | `window.pomeloIcons.draw(el, parent, info, cx, cy)` draws the file or folder icon of a format (put `picon` on the parent group); `addDefs` adds the gradient it needs |

This folder holds only what two or more pages use.

## Testing

`npm run test:ui` loads every page. Screenshots go to `test/shots/`.

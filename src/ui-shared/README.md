# UI shared

What the wheel, toast and settings pages have in common. The pages are classic scripts under a strict Content-Security-Policy (`'self'` only), and files in this folder load with a plain `<link>` or `<script src="../ui-shared/...">`.

| File | Role |
|---|---|
| `tokens.css` | Accent, text, ok and error colours, the divider line, the font stack, and the dark-mode values of the text and line colours. Load it before the page's own CSS; a page that needs another value sets it in its own `:root` |
| `dom.js` | `window.pomeloUi.el(tag, cls, text)` makes an element |

A page that needs the wheel's SVG helper keeps its own; this folder holds only what two or more pages use.

## Testing

`npm run test:ui` loads all three pages. Screenshots go to `test/shots/`.

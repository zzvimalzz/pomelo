// SPDX-License-Identifier: AGPL-3.0-or-later
// Building and converting HTML for the converters that go through it: a printable page, and HTML to DOCX, Markdown or text.
const path = require('path');
const { escapeHtml: esc } = require('#shared/core/text');

// The page margin has to be here: a CSS @page rule beats the margins passed to printToPDF, and with `margin: 0` the
// text used to run to the very edge of the sheet.
const BASE_CSS = `
  @page { margin: 17.8mm 20.3mm }
  body { font: 11pt/1.5 Calibri, "Segoe UI", Arial, sans-serif; color: #111; margin: 0 }
  h1 { font-size: 22pt; margin: 18pt 0 8pt } h2 { font-size: 16pt; margin: 14pt 0 6pt } h3 { font-size: 13pt }
  p { margin: 0 0 8pt } img { max-width: 100% } pre, code { font-family: Consolas, monospace; font-size: 10pt }
  pre { background: #f5f5f5; padding: 8pt; white-space: pre-wrap }
  table { border-collapse: collapse; margin: 6pt 0 } td, th { border: 1px solid #bbb; padding: 3pt 6pt; vertical-align: top }
  blockquote { margin: 8pt 0 8pt 12pt; padding-left: 10pt; border-left: 3px solid #ccc; color: #444 }`;

// base: file:// URL of the source's folder, so images next to a .md/.html file resolve
const wrapHtml = (body, title, css = '', base = '') =>
  `<!doctype html><html><head><meta charset="utf-8">${base ? `<base href="${esc(base)}">` : ''}<title>${esc(title)}</title><style>${BASE_CSS}${css}</style></head><body>${body}</body></html>`;

const baseHrefOf = (file) => require('url').pathToFileURL(path.dirname(file) + path.sep).href;

// Add a <base> to a complete HTML document (unless it has one already).
function withBase(html, href) {
  if (/<base\b/i.test(html)) return html;
  const tag = `<base href="${esc(href)}">`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + tag) : tag + html;
}

async function htmlToDocx(html) {
  const HTMLtoDOCX = require('html-to-docx');
  html = html.replace(/<img\b[^>]*\bsrc\s*=\s*["']https?:[^>]*>/gi, '');     // html-to-docx would download remote images
  const out = await HTMLtoDOCX(html, null, { table: { row: { cantSplit: true } }, footer: false, pageNumber: false });
  return Buffer.from(out);
}

function htmlToMd(html) {
  const TurndownService = require('turndown');
  const { gfm } = require('turndown-plugin-gfm');
  const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' });
  td.use(gfm);
  return td.turndown(html).trim() + '\n';
}

function htmlToTxt(html) {
  return require('html-to-text').convert(html, { wordwrap: false, selectors: [{ selector: 'img', format: 'skip' }] }).trim() + '\n';
}

const txtToHtml = (text, title) => wrapHtml(
  text.replace(/\r\n?/g, '\n').split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join(''), title);

module.exports = { wrapHtml, baseHrefOf, withBase, htmlToDocx, htmlToMd, htmlToTxt, txtToHtml };

// SPDX-License-Identifier: AGPL-3.0-or-later
// Text blocks read from a PDF or a legacy .doc ({ type: 'h1' | 'h2' | 'li' | 'p', text }, grouped by page) written out as
// HTML, Markdown, plain text or DOCX.
const fs = require('fs');
const { wrapHtml } = require('./html');
const { escapeHtml: esc } = require('../../../shared/core/text');

const flat = (pages) => pages.flat();

function blocksToHtml(pages, title) {
  let html = '', inList = false;
  for (const b of flat(pages)) {
    if (b.type !== 'li' && inList) { html += '</ul>'; inList = false; }
    if (b.type === 'li') { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${esc(b.text)}</li>`; }
    else html += `<${b.type}>${esc(b.text)}</${b.type}>`;
  }
  return wrapHtml(html + (inList ? '</ul>' : ''), title);
}

const blocksToMd = (pages) => flat(pages).map((b) => (b.type === 'h1' ? '# ' : b.type === 'h2' ? '## ' : b.type === 'li' ? '- ' : '') + b.text)
  .join('\n').replace(/^(- .*)\n(?=[^-])/gm, '$1\n\n').replace(/\n(?=#)/g, '\n\n') + '\n';

const blocksToTxt = (pages) => pages.map((p) => p.map((b) => (b.type === 'li' ? '• ' : '') + b.text).join('\n\n')).join('\n\n') + '\n';

async function blocksToDocx(pages) {
  const { Document, Packer, Paragraph, HeadingLevel } = require('docx');
  const kids = flat(pages).map((b) => new Paragraph(
    b.type === 'h1' ? { text: b.text, heading: HeadingLevel.HEADING_1 }
      : b.type === 'h2' ? { text: b.text, heading: HeadingLevel.HEADING_2 }
        : b.type === 'li' ? { text: b.text, bullet: { level: 0 } }
          : { text: b.text, spacing: { after: 140 } }));
  return Packer.toBuffer(new Document({ sections: [{ children: kids }] }));
}

// Writes the blocks to `out` as to = 'txt' | 'md' | 'html' | 'docx'; any other target is left to the caller.
async function writeBlocks(pages, to, out, title) {
  if (to === 'txt') fs.writeFileSync(out, blocksToTxt(pages), 'utf8');
  else if (to === 'md') fs.writeFileSync(out, blocksToMd(pages), 'utf8');
  else if (to === 'html') fs.writeFileSync(out, blocksToHtml(pages, title), 'utf8');
  else if (to === 'docx') fs.writeFileSync(out, await blocksToDocx(pages));
}

module.exports = { blocksToHtml, writeBlocks };

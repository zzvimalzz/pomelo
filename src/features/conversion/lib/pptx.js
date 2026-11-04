// SPDX-License-Identifier: AGPL-3.0-or-later
// A PowerPoint deck whose slides are all one size, in inches: the size of the PDF pages it is made from.

function newDeck(width, height, title) {
  const PptxGenJS = require('pptxgenjs');
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'PDF', width, height });
  pptx.layout = 'PDF';
  if (title) pptx.title = title;
  return pptx;
}

module.exports = { newDeck };

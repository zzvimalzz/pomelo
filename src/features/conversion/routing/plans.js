// SPDX-License-Identifier: AGPL-3.0-or-later
// Routing: for a (from, to) pair, which engines can do it and in which order to try them, including the pairs that need an
// intermediate format. Pure given the engines map, so it can be tested under any combination of installed engines.
const { extsInGroup, OFFICE } = require('../catalog/formats');
const { getEngines, libreoffice, pandoc, pdfPython, heicPython, ffmpeg, archive, subtitle, builtin } = require('../engines/registry');

// Targets where look and layout matter prefer LibreOffice; text-like targets prefer Pandoc, then the built-in code.
const FIDELITY = new Set(['pdf', ...Object.values(OFFICE).flat()]);
const DOCS = extsInGroup('doc');

// Pairs with no direct engine go through an intermediate format: first.run(from -> via), then second.run(via -> to).
const CHAINS = [
  { from: ['doc', 'rtf', 'odt'], to: ['txt', 'md', 'html', 'epub'], via: 'docx', first: [libreoffice], second: [pandoc, builtin] },
  { from: ['txt', 'md', 'html', 'epub'], to: ['rtf', 'odt', 'doc'], via: 'docx', first: [pandoc, builtin], second: [libreoffice] },
  { from: ['pptx', 'ppt'], to: ['png', 'jpg'], via: 'pdf', first: [libreoffice], second: [builtin] },
  { from: DOCS, to: ['png', 'jpg'], via: 'pdf', first: [libreoffice, builtin], second: [builtin] },          // pages as images
  { from: ['pdf'], to: ['doc', 'odt', 'rtf'], via: 'docx', first: [pdfPython, builtin], second: [libreoffice] },
];

function plansFor(from, to, available = getEngines()) {
  // pdf -> docx/md/xlsx: the Python engines keep fonts, colours, tables and structure; the built-in extractor is the fallback
  const order = from === 'pdf' ? [pdfPython, libreoffice, builtin]
    : FIDELITY.has(to) ? [libreoffice, pandoc, builtin] : [pandoc, builtin, libreoffice];
  const direct = [ffmpeg, heicPython, subtitle, archive, ...order];
  const plans = direct.filter((e) => e.supports(from, to, available)).map((e) => [{ engine: e, from, to }]);
  for (const c of CHAINS) {
    if (!c.from.includes(from) || !c.to.includes(to)) continue;
    for (const a of c.first) {
      for (const b of c.second) {
        if (a.supports(from, c.via, available) && b.supports(c.via, to, available)) plans.push([{ engine: a, from, to: c.via }, { engine: b, from: c.via, to }]);
      }
    }
  }
  // High-fidelity PDF routes (including chains that start with them) beat the built-in extractor.
  if (from === 'pdf') plans.sort((a, b) => (b[0].engine === pdfPython) - (a[0].engine === pdfPython));
  // The built-in .doc reader only extracts text, so it is the last resort for that format.
  if (from === 'doc') plans.sort((a, b) => (a[0].engine === builtin && a.length === 1) - (b[0].engine === builtin && b.length === 1));
  return plans;
}

const canConvert = (from, to) => plansFor(from, to).length > 0;

module.exports = { plansFor, canConvert };

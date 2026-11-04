// SPDX-License-Identifier: AGPL-3.0-or-later
// Legacy .doc without Office: pull out the text only (no styling) and reuse the text-block writers.
const { uniquePath } = require('../../engine-kit/outputs');
const { blocksToHtml, writeBlocks } = require('../../lib/text-blocks');
const { htmlToPdf } = require('../../lib/print-pdf');

async function run({ src, to, dir, base }) {
  const WordExtractor = require('word-extractor');
  const body = (await new WordExtractor().extract(src)).getBody();
  const paras = body.split(new RegExp('[' + String.fromCharCode(13, 10) + ']+')).map((t) => t.trim()).filter(Boolean).map((text) => ({ type: 'p', text }));
  if (!paras.length) throw new Error('No text found in this .doc file');
  const pages = [paras];
  const out = uniquePath(dir, base, to);
  if (to === 'pdf') await htmlToPdf(blocksToHtml(pages, base), out);
  else await writeBlocks(pages, to, out, base);
  return [out];
}

module.exports = { run };

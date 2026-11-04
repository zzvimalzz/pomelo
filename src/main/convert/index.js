// SPDX-License-Identifier: AGPL-3.0-or-later
// Conversion orchestrator: picks the engine(s) for a (from -> to) pair and runs them.
const fs = require('fs');
const path = require('path');
const { extOf, baseOf, targetsForFiles, labelOf, extsInGroup, OFFICE } = require('../formats');
const { withContext, removeOutputs, CancelledError } = require('./util');
const { withTempDir } = require('../../shared/node/fs');
const { soffice, pandoc } = require('../engines/external');
const pure = require('../engines/pure');
const pdfhifi = require('../engines/pdfhifi');
const ffmpeg = require('../engines/ffmpeg');
const heic = require('../engines/heic');
const subtitle = require('../engines/subtitle');
const archive = require('../engines/archive');
const { findExe } = require('../../shared/node/which');

let engines = { soffice: null, pandoc: null, pdf: null, ocr: null, heic: null, ffmpeg: null, sevenZip: null };

function detectEngines() {
  engines = {
    soffice: findExe('soffice.exe', ['LibreOffice/program', 'libreoffice/program']),
    pandoc: findExe('pandoc.exe', ['Pandoc', 'pandoc', '']),
    pdf: pdfhifi.detect(),
    ocr: pdfhifi.detectOcr(),
    heic: pdfhifi.detectHeic(),
    ffmpeg: ffmpeg.detect(),
    sevenZip: archive.detect(),
  };
  return engines;
}

// Targets where look and layout matter prefer LibreOffice; text-like targets prefer Pandoc, then the built-in code.
const FIDELITY = new Set(['pdf', ...Object.values(OFFICE).flat()]);
const DOCS = extsInGroup('doc');

// Pairs with no direct engine go through an intermediate format: first.run(from -> via), then second.run(via -> to).
const CHAINS = [
  { from: ['doc', 'rtf', 'odt'], to: ['txt', 'md', 'html', 'epub'], via: 'docx', first: [soffice], second: [pandoc, pure] },
  { from: ['txt', 'md', 'html', 'epub'], to: ['rtf', 'odt', 'doc'], via: 'docx', first: [pandoc, pure], second: [soffice] },
  { from: ['pptx', 'ppt'], to: ['png', 'jpg'], via: 'pdf', first: [soffice], second: [pure] },
  { from: DOCS, to: ['png', 'jpg'], via: 'pdf', first: [soffice, pure], second: [pure] },          // pages as images
  { from: ['pdf'], to: ['doc', 'odt', 'rtf'], via: 'docx', first: [pdfhifi, pure], second: [soffice] },
];

function plansFor(from, to, available = engines) {
  // pdf -> docx/md/xlsx: the Python engines keep fonts, colours, tables and structure; the built-in extractor is the fallback
  const order = from === 'pdf' ? [pdfhifi, soffice, pure]
    : FIDELITY.has(to) ? [soffice, pandoc, pure] : [pandoc, pure, soffice];
  const direct = [ffmpeg, heic, subtitle, archive, ...order];
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
  if (from === 'pdf') plans.sort((a, b) => (b[0].engine === pdfhifi) - (a[0].engine === pdfhifi));
  // The built-in .doc reader only extracts text, so it is the last resort for that format.
  if (from === 'doc') plans.sort((a, b) => (a[0].engine === pure && a.length === 1) - (b[0].engine === pure && b.length === 1));
  return plans;
}

const canConvert = (from, to) => plansFor(from, to).length > 0;
const targetsFor = (files) => targetsForFiles(files, canConvert);

// onProgress(fraction 0..1) is forwarded by engines that can report it (video/audio); for a two-step chain it is split in half.
async function runPlan(plan, src, dir, base, onProgress) {
  if (plan.length === 1) return plan[0].engine.run({ src, from: plan[0].from, to: plan[0].to, dir, base, engines, onProgress });
  return withTempDir(async (tmp) => {
    const [first, second] = plan;
    const half = (offset) => onProgress && ((f) => onProgress(offset + f / 2));
    const [mid] = await first.engine.run({ src, from: first.from, to: first.to, dir: tmp, base, engines, onProgress: half(0) });
    return second.engine.run({ src: mid, from: second.from, to: second.to, dir, base, engines, onProgress: half(0.5) });
  });
}

// Convert one file next to the original. Resolves with the list of files written.
// signal (AbortSignal): cancel it to kill the helper programs and delete any partial output.
async function convertFile(src, to, { onProgress, signal } = {}) {
  const from = extOf(src);
  const dir = path.dirname(src);
  const base = baseOf(src);
  const plans = plansFor(from, to);
  if (!plans.length) throw new Error(`No converter available for .${from} to ${labelOf(to)}`);
  if (from !== 'folder' && fs.statSync(src).size === 0) throw new Error('This file is empty');
  if (signal?.aborted) throw new CancelledError();

  const ctx = { signal, outputs: [] };
  return withContext(ctx, async () => {
    let firstErr;                                                                         // the best engine's reason: the fallbacks' are usually less to the point
    for (const plan of plans) {
      const mark = ctx.outputs.length;
      try {
        const outs = await runPlan(plan, src, dir, base, onProgress);
        if (signal?.aborted) { removeOutputs(ctx.outputs); throw new CancelledError(); }   // an engine that cannot be interrupted finished anyway
        return outs;
      } catch (e) {
        if (e instanceof CancelledError || signal?.aborted) { removeOutputs(ctx.outputs); throw new CancelledError(); }
        removeOutputs(ctx.outputs.splice(mark));                                          // leftovers of a failed attempt
        firstErr ||= e;
        console.warn(`[convert] ${plan.map((s) => s.engine.name).join('+')} failed: ${e.message}`);
      }
    }
    throw firstErr;
  });
}

const getEngines = () => engines;

module.exports = { detectEngines, getEngines, canConvert, targetsFor, convertFile, plansFor };

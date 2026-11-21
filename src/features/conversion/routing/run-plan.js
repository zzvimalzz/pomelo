// SPDX-License-Identifier: AGPL-3.0-or-later
// Running the plans for one file: the first plan that works wins, and a failed attempt cleans up after itself.
const fs = require('fs');
const path = require('path');
const { extOf, baseOf, labelOf } = require('../catalog/formats');
const { withContext, CancelledError } = require('../engine-kit/context');
const { removeOutputs } = require('../engine-kit/outputs');
const { unlock, unlocksToCopy } = require('../engine-kit/lock');
const { scaled } = require('../engine-kit/progress');
const { getEngines } = require('../engines/registry');
const { plansFor } = require('./plans');
const { withTempDir, withTempFile } = require('#shared/node/fs');

// onProgress(fraction 0..1) is forwarded by engines that can report it (video/audio); for a two-step chain it is split in half.
async function runPlan(plan, src, dir, base, onProgress) {
  const engines = getEngines();
  if (plan.length === 1) return plan[0].engine.run({ src, from: plan[0].from, to: plan[0].to, dir, base, engines, onProgress });
  return withTempDir(async (tmp) => {
    const [first, second] = plan;
    const [mid] = await first.engine.run({ src, from: first.from, to: first.to, dir: tmp, base, engines, onProgress: scaled(onProgress, 0, 0.5) });
    return second.engine.run({ src: mid, from: second.from, to: second.to, dir, base, engines, onProgress: scaled(onProgress, 0.5, 0.5) });
  });
}

// Convert one file next to the original, or into outDir. Resolves with the list of files written.
// signal (AbortSignal): cancel it to kill the helper programs and delete any partial output.
// password (a Buffer): the one a protected file needs. A PDF or Office file is unlocked into a temporary copy that the plans then read; an archive
// gets the password from the conversion's context.
async function convertFile(src, to, { onProgress, signal, outDir, password } = {}) {
  const from = extOf(src);
  const dir = outDir || path.dirname(src);
  const base = baseOf(src);
  const plans = plansFor(from, to);
  if (!plans.length) throw new Error(`No converter available for .${from} to ${labelOf(to)}`);
  if (from !== 'folder' && fs.statSync(src).size === 0) throw new Error('This file is empty');
  if (signal?.aborted) throw new CancelledError();

  const ctx = { signal, outputs: [], password };
  const attempt = async (file) => {
    let firstErr;                                                                         // the best engine's reason: the fallbacks' are usually less to the point
    for (const plan of plans) {
      const mark = ctx.outputs.length;
      try {
        const outs = await runPlan(plan, file, dir, base, onProgress);
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
  };
  return withContext(ctx, () => (password && unlocksToCopy(from)
    ? withTempFile(from, async (copy) => { await unlock(src, password, copy, getEngines()); return attempt(copy); })
    : attempt(src)));
}

module.exports = { convertFile };

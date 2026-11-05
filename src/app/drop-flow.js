// SPDX-License-Identifier: AGPL-3.0-or-later
// From the gesture to the jobs: the selection the user is dragging becomes a wheel of formats (or an explanation of why there is
// none), and files dropped on a segment become one job each.
const path = require('path');
const { middleEllipsis } = require('#shared/core/text');

// What the wheel shows in its centre for a selection: a name short enough to fit, the kind, and how many files.
function describeSelection(files, conversion) {
  const ext = conversion.extOf(files[0]);
  return { name: middleEllipsis(path.basename(files[0]), 15), ext, group: conversion.groupOf(ext), count: files.length };
}

// conversion: the conversion feature's public API. getWheel() / getJobs(): the wheel window and the job list, which are created
// after this. log(...)
function createDropFlow({ conversion, getWheel, getJobs, log }) {
  return {
    // The gesture, or the right-click menu (pick), opened on these files: offer the formats, or say why there are none.
    onOpen(files, pick = false) {
      const targets = conversion.targetsFor(files);
      if (targets.length) { getWheel().openWheel(describeSelection(files, conversion), targets, pick ? files : null); return; }
      log('nothing to offer for', files);
      getJobs().addInfo(conversion.explainNoTargets(files));
    },

    // Every file x target is its own job; jobs run in parallel and the toast shows them as a stack.
    onDrop(paths, to) {
      log('drop', to, paths);
      const jobs = getJobs();
      if (!conversion.targetsFor(paths).some((t) => t.id === to)) {
        jobs.addInfo({ title: `Can't convert to ${conversion.labelOf(to)}`, detail: 'That format is not available for this selection.' });
        return;
      }
      for (const p of paths) jobs.addConversion(p, to, conversion.labelOf(to));
    },
  };
}

module.exports = { createDropFlow };

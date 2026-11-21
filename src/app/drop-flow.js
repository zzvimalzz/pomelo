// SPDX-License-Identifier: AGPL-3.0-or-later
// From the gesture to the jobs: the selection the user is dragging becomes a wheel of formats (or an explanation of why there is
// none), and files dropped on a segment become one job each. The Open wheel, which Shift shows, has one target: PDFs dropped on it
// are opened in the PDF workspace.
const path = require('path');
const { middleEllipsis } = require('#shared/core/text');

// What the wheel shows in its centre for a selection: a name short enough to fit, the kind, and how many files.
function describeSelection(files, conversion) {
  const ext = conversion.extOf(files[0]);
  return { name: middleEllipsis(path.basename(files[0]), 15), ext, group: conversion.groupOf(ext), count: files.length };
}

const OPEN_TARGETS = [{ id: 'open', label: 'Open', icon: 'book' }];

// conversion: the conversion feature's public API. getWheel() / getJobs(): the wheel window and the job list, which are created
// after this. openPdfs(paths): show PDFs in the PDF workspace. keysSupported(): the input helper reports Shift, so the conversion wheel
// can name it. log(...)
function createDropFlow({ conversion, getWheel, getJobs, openPdfs, keysSupported, log }) {
  let selection = [];            // the files the wheel on show was opened for
  const isPdf = (file) => conversion.extOf(file) === 'pdf';
  const openView = (files) => ({ wheel: 'open', droppable: files.every(isPdf), switchable: true });

  return {
    // The gesture, or the right-click menu (pick), opened on these files: offer the formats (or, for Shift, the Open wheel), or say why
    // there are none.
    onOpen(files, pick = false, wheel = 'convert') {
      selection = files;
      const info = describeSelection(files, conversion);
      if (wheel === 'open') { getWheel().openWheel(info, OPEN_TARGETS, null, openView(files)); return; }
      const targets = conversion.targetsFor(files);
      if (targets.length) { getWheel().openWheel(info, targets, pick ? files : null, { wheel: 'convert', switchable: !pick && keysSupported() }); return; }
      log('nothing to offer for', files);
      getJobs().addInfo(conversion.explainNoTargets(files));
    },

    // The key of the other wheel was pressed: the wheel on show turns into it. It stays as it is when there is nothing to convert to.
    onSwitch(wheel) {
      if (wheel === 'open') { getWheel().switchWheel(OPEN_TARGETS, openView(selection)); return; }
      const targets = conversion.targetsFor(selection);
      if (targets.length) getWheel().switchWheel(targets, { wheel: 'convert', switchable: true });
      else getJobs().addInfo(conversion.explainNoTargets(selection));
    },

    // Every file x target is its own job; jobs run in parallel and the toast shows them as a stack.
    onDrop(paths, to) {
      log('drop', to, paths);
      if (to === OPEN_TARGETS[0].id) {
        const pdfs = paths.filter(isPdf);
        if (pdfs.length) openPdfs(pdfs);
        return;
      }
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

// SPDX-License-Identifier: AGPL-3.0-or-later
// From the gesture to the jobs: the selection the user is dragging becomes a wheel of formats (or an explanation of why there is
// none), and files dropped on a segment become one job each. The Open wheel, which Shift shows for PDFs only, has one target: PDFs dropped
// on it are opened in the PDF workspace. A file that needs a password is held back: the wheel asks for it, and the job starts once it opens.
const crypto = require('crypto');
const path = require('path');
const { middleEllipsis } = require('#shared/core/text');
const { passwordBuffer } = require('#shared/node/secrets');

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
  let session = null;            // the protected files of the last drop that are still waiting for a password: { to, files: Map(token -> { file, kind }) }
  const isPdf = (file) => conversion.extOf(file) === 'pdf';
  // Starts a job for each file that opens as it is and holds back the rest, which the card asks about. Resolves with the files held back.
  async function hold(paths, to) {
    const kinds = await Promise.all(paths.map((file) => conversion.probeLocked(file)));
    const held = new Map();
    paths.forEach((file, i) => {
      if (kinds[i]) held.set(crypto.randomBytes(16).toString('hex'), { file, kind: kinds[i] });
      else getJobs().addConversion(file, to, conversion.labelOf(to));
    });
    if (!held.size) return [];
    session = { to, files: held };
    return [...held].map(([token, { file, kind }]) => {
      const ext = conversion.extOf(file);
      return { token, kind, name: middleEllipsis(path.basename(file), 30), ext, group: conversion.groupOf(ext) };
    });
  }

  const allPdfs = (files) => files.every(isPdf);

  return {
    // The gesture, or the right-click menu (pick), opened on these files: offer the formats (or, for Shift on PDFs, the Open wheel), or
    // say why there are none. Shift on anything else shows the conversion wheel, as Ctrl does.
    async onOpen(files, pick = false, wheel = 'convert') {
      selection = files;
      const info = describeSelection(files, conversion);
      if (wheel === 'open' && allPdfs(files)) { getWheel().openWheel(info, OPEN_TARGETS, null, { wheel: 'open', switchable: true }); return; }
      const targets = conversion.targetsFor(files);
      if (targets.length) { getWheel().openWheel(info, targets, pick ? files : null, { wheel: 'convert', switchable: !pick && keysSupported() && allPdfs(files) }); return; }
      log('nothing to offer for', files);
      getJobs().addInfo(conversion.explainNoTargets(files));
    },

    // The key of the other wheel was pressed: the wheel on show turns into it. It stays as it is when there is nothing to convert to,
    // and Shift does nothing when the files are not all PDFs.
    onSwitch(wheel) {
      if (wheel === 'open') { if (allPdfs(selection)) getWheel().switchWheel(OPEN_TARGETS, { wheel: 'open', switchable: true }); return; }
      const targets = conversion.targetsFor(selection);
      if (targets.length) getWheel().switchWheel(targets, { wheel: 'convert', switchable: true });
      else getJobs().addInfo(conversion.explainNoTargets(selection));
    },

    // Every file x target is its own job; jobs run in parallel and the toast shows them as a stack. Resolves with the files that need a
    // password ([{ token, kind, name, ext, group }]), which the wheel asks about; the others are converting already.
    async onDrop(paths, to) {
      log('drop', to, paths);
      session = null;
      if (to === OPEN_TARGETS[0].id) {
        const pdfs = paths.filter(isPdf);
        if (pdfs.length) openPdfs(pdfs);
        return [];
      }
      const jobs = getJobs();
      if (!conversion.targetsFor(paths).some((t) => t.id === to)) {
        jobs.addInfo({ title: `Can't convert to ${conversion.labelOf(to)}`, detail: 'That format is not available for this selection.' });
        return [];
      }
      return hold(paths, to);
    },

    // The card has been left alone for too long and is closing: say so, and what was left.
    onExpire() {
      const left = [...(session?.files.values() || [])];
      if (!left.length) return;
      const what = left.length === 1 ? path.basename(left[0].file) : `${left.length} files`;
      getJobs().addInfo({ title: 'Password prompt closed', detail: `${what} was left alone.` });
    },

    // The card sent a password for one waiting file (and, with `all`, for the others that it fits). Resolves with what happened:
    // { state: 'ok', done: [tokens], mismatch } when the file opened (its job has started), { state: 'wrong', message? } when it did not
    // fit, { state: 'cannot', token, message } when the file cannot be opened at all, { state: 'closed' } when the card was closed meanwhile.
    async onUnlock({ token, password, all }) {
      const mine = session;
      const entry = mine?.files.get(token);
      if (!entry || entry.kind !== 'needed') return { state: 'closed' };
      let secret;
      try { secret = passwordBuffer(password); } catch { return { state: 'wrong' }; }
      const open = (key, file) => {
        mine.files.delete(key);
        getJobs().addConversion(file, mine.to, conversion.labelOf(mine.to), Buffer.from(secret));
      };
      try {
        let right;
        try { right = await conversion.checkPassword(entry.file, secret); } catch (e) {
          if (session !== mine) return { state: 'closed' };
          if (e.kind === 'ascii') return { state: 'wrong', message: e.message };
          mine.files.delete(token);
          return { state: 'cannot', token, message: e.message };
        }
        if (session !== mine) return { state: 'closed' };
        if (!right) return { state: 'wrong' };
        open(token, entry.file);
        const done = [token];
        if (all) {
          for (const [other, { file, kind }] of [...mine.files]) {
            if (kind !== 'needed' || !(await conversion.checkPassword(file, secret).catch(() => false)) || session !== mine) continue;
            open(other, file);
            done.push(other);
          }
        }
        return { state: 'ok', done, mismatch: !!all && [...mine.files.values()].some((e) => e.kind === 'needed') };
      } finally { secret.fill(0); }
    },

    // The card was closed (or the wheel with it): nothing is waiting for a password any more.
    onUnlockEnd() { session = null; },
  };
}

module.exports = { createDropFlow };

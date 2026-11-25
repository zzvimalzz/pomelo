// SPDX-License-Identifier: AGPL-3.0-or-later
// The versions of one open document, oldest first, with the one on show. A revision is { file, handle, size, owned, refs }: a file read
// through a handle held open, which Pomelo deletes when it lets go of it only if it made the file (owned). No Electron in here.
const fs = require('fs');

const MAX_REVISIONS = 30;

function createRevisions(first) {
  let list = [first];
  let at = 0;
  let saved = first;

  const close = (rev) => rev.handle.close().catch(() => {}).then(() => { if (rev.owned) return fs.promises.rm(rev.file, { force: true }).catch(() => {}); });

  // A revision is let go of when nothing is reading it, so eviction never pulls a file from under a read in flight.
  function retire(rev) {
    rev.retired = true;
    return rev.refs ? Promise.resolve() : close(rev);
  }

  const acquire = (rev) => { rev.refs++; };
  const release = (rev) => { if (--rev.refs === 0 && rev.retired) close(rev); };

  const current = () => list[at];
  // A revision made from another by changes to the document information or to the pages alone holds the same document again once that
  // is back as it was: `base` is the revision it was made from, `meta` its information as text (a revision that only moved pages has
  // none of its own and takes it from `metaFrom`) and `layout` where its pages are (all set by documents.js).
  const information = (r) => { while (r && !r.meta) r = r.metaFrom; return r?.meta; };
  const arrangement = (r) => (r.layout ? JSON.stringify(r.layout.pages) : '');
  const same = (a, b) => a === b || ((a.base ?? a) === (b.base ?? b) && information(a) === information(b) && arrangement(a) === arrangement(b));
  const dirty = () => !same(list[at], saved);

  const canUndo = () => at > 0;
  const canRedo = () => at < list.length - 1;
  function undo() { return canUndo() ? list[--at] : null; }
  function redo() { return canRedo() ? list[++at] : null; }

  // Adds the next revision after the one on show and lets go of what that leaves behind: the redo tail, then the oldest revisions
  // after the first until there are at most MAX_REVISIONS and they fit in `budget` bytes.
  async function push(rev, budget) {
    const dropped = list.splice(at + 1);
    list.push(rev);
    at = list.length - 1;
    const total = () => list.reduce((sum, r) => sum + (r.owned ? r.size : 0), 0);
    while (list.length > 2 && (list.length > MAX_REVISIONS || total() > budget)) dropped.push(list.splice(1, 1)[0]);
    at = list.length - 1;
    await Promise.all(dropped.map(retire));
  }

  function replaceFirst(rev) {
    const old = list[0];
    rev.meta ??= old.meta;
    list[0] = rev;
    if (saved === old) saved = rev;
    return retire(old);
  }

  const markSaved = () => { saved = list[at]; };
  const dispose = () => Promise.all(list.map(retire));

  return { current, dirty, canUndo, canRedo, undo, redo, push, replaceFirst, markSaved, acquire, release, dispose };
}

module.exports = { createRevisions, MAX_REVISIONS };

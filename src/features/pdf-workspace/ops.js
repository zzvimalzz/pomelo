// SPDX-License-Identifier: AGPL-3.0-or-later
// The changes the page may ask the PDF engine to make. A list is checked here, in the main process, before any file is written, and
// again by python/pdf_ops. Each operation has a kind that decides how its result is saved: a `direct` edit is appended to the file, a
// `rewrite` writes it whole. No Electron in here.
const MAX_OPS = 1000;
const MAX_PAGE = 1000000;

const isPages = (v) => Array.isArray(v) && v.length > 0 && v.length <= MAX_PAGE && v.every((p) => Number.isInteger(p) && p >= 1 && p <= MAX_PAGE) && new Set(v).size === v.length;

const isText = (v) => typeof v === 'string' && v.length <= 1000 && !v.includes('\0');

const OPS = {
  'meta.set': { kind: 'direct', keys: { title: isText, author: isText, subject: isText, keywords: isText } },
  'pages.rotate': { kind: 'direct', keys: { pages: isPages, by: (v) => v === 90 || v === 180 || v === 270 } },
  'pages.delete': { kind: 'rewrite', keys: { pages: isPages } },
  'pages.move': { kind: 'direct', keys: { pages: isPages, before: (v) => Number.isInteger(v) && v >= 1 && v <= MAX_PAGE + 1 } },
};

// Where every page is after a list of page changes: [the page it was when the document began, degrees turned], in the order they now
// have. `from` is the answer for the changes before, `count` the pages the document had before this list. Resolves undefined when
// that is the document as it began, so two versions that are the same pages in the same order and turn compare equal.
function arrange(from, count, list) {
  const began = from?.began ?? count;
  let now = from?.pages ?? Array.from({ length: count }, (_, i) => [i + 1, 0]);
  for (const op of list) {
    if (op.op === 'pages.rotate') {
      now = now.slice();
      for (const p of op.pages) now[p - 1] = [now[p - 1][0], (now[p - 1][1] + op.by) % 360];
    } else if (op.op === 'pages.delete') {
      const gone = new Set(op.pages);
      now = now.filter((_, i) => !gone.has(i + 1));
    } else {
      const moving = new Set(op.pages);
      const rest = now.filter((_, i) => !moving.has(i + 1));
      const at = op.before - 1 - op.pages.filter((p) => p < op.before).length;
      now = [...rest.slice(0, at), ...[...op.pages].sort((a, b) => a - b).map((p) => now[p - 1]), ...rest.slice(at)];
    }
  }
  return now.length === began && now.every(([page, turned], i) => page === i + 1 && turned === 0) ? undefined : { began, pages: now };
}

// Returns a copy of the list that holds only the keys each operation takes. Throws a sentence for anything else.
function check(list) {
  if (!Array.isArray(list) || !list.length || list.length > MAX_OPS) throw new Error('a list of changes has 1 to 1000 changes');
  return list.map((op) => {
    const schema = Object.hasOwn(OPS, op?.op) ? OPS[op.op] : null;
    if (!schema) throw new Error('unknown change');
    const keys = Object.keys(schema.keys);
    const extra = Object.keys(op).filter((key) => key !== 'op' && !keys.includes(key));
    if (extra.length || keys.some((key) => !schema.keys[key](op[key]))) throw new Error(`${op.op} takes ${keys.join(' and ')} and nothing else`);
    return { op: op.op, ...Object.fromEntries(keys.map((key) => [key, op[key]])) };
  });
}

module.exports = { check, arrange, OPS };

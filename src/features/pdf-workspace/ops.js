// SPDX-License-Identifier: AGPL-3.0-or-later
// The changes the page may ask the PDF engine to make. A list is checked here, in the main process, before any file is written, and
// again by python/pdf_ops. Each operation has a kind that decides how its result is saved: a `direct` edit is appended to the file, a
// `rewrite` writes it whole. No Electron in here.
const MAX_OPS = 1000;
const MAX_PAGE = 1000000;
const MAX_SOURCES = 50;
const MAX_PARTS = 100;
const PICTURE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'tif', 'tiff'];

const isPages = (v) => Array.isArray(v) && v.length > 0 && v.length <= MAX_PAGE && v.every((p) => Number.isInteger(p) && p >= 1 && p <= MAX_PAGE) && new Set(v).size === v.length;

const isBefore = (v) => Number.isInteger(v) && v >= 1 && v <= MAX_PAGE + 1;

const isSources = (v) => Array.isArray(v) && v.length > 0 && v.length <= MAX_SOURCES && v.every((id) => typeof id === 'string' && /^[0-9a-f]{32}$/.test(id)) && new Set(v).size === v.length;

const isText = (v) => typeof v === 'string' && v.length <= 1000 && !v.includes('\0');

const OPS = {
  'meta.set': { kind: 'direct', keys: { title: isText, author: isText, subject: isText, keywords: isText } },
  'pages.rotate': { kind: 'direct', keys: { pages: isPages, by: (v) => v === 90 || v === 180 || v === 270 } },
  'pages.delete': { kind: 'rewrite', keys: { pages: isPages } },
  'pages.move': { kind: 'direct', keys: { pages: isPages, before: isBefore } },
  'pages.insert': { kind: 'new', keys: { before: isBefore, sources: isSources } },
  'pages.blank': { kind: 'new', keys: { before: isBefore } },
  'pages.extract': { kind: 'output', keys: { pages: isPages } },
};

// Where every page is after a list of page changes: [the page it was when the document began, degrees turned], in the order they now
// have; a page that was added has 0 for the first. `from` is the answer for the changes before, `count` the pages the document had
// before this list, `added` how many pages each change of the list added. Resolves undefined when that is the document as it began,
// so two versions that are the same pages in the same order and turn compare equal.
function arrange(from, count, list, added = []) {
  const began = from?.began ?? count;
  let now = from?.pages ?? Array.from({ length: count }, (_, i) => [i + 1, 0]);
  list.forEach((op, i) => {
    if (op.op === 'pages.insert' || op.op === 'pages.blank') {
      now = [...now.slice(0, op.before - 1), ...Array.from({ length: added[i] ?? 0 }, () => [0, 0]), ...now.slice(op.before - 1)];
    } else if (op.op === 'pages.rotate') {
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
  });
  return now.length === began && now.every(([page, turned], i) => page === i + 1 && turned === 0) ? undefined : { began, pages: now };
}

// The pages as a person writes them: 1-3, 5, 8-9.
function pageRanges(pages) {
  const sorted = [...pages].sort((a, b) => a - b);
  const runs = [];
  for (const p of sorted) {
    if (runs.length && runs.at(-1)[1] === p - 1) runs.at(-1)[1] = p;
    else runs.push([p, p]);
  }
  return runs.map(([a, b]) => (a === b ? String(a) : `${a}-${b}`)).join(', ');
}

const RANGE = /^(\d+)\s*(?:(-)\s*(\d*))?$/;
const SPLIT_WORDS = { ranges: 'Use page numbers such as 1-3, 7', every: 'Use a number of pages such as 5' };
const TOO_MANY = { error: `That would make more than ${MAX_PARTS} files` };
const TOO_MUCH = { error: 'That is too much to split at once' };

// The files a split makes, each as the list of its pages, from what the Split dialog asks for in a document of `total` pages:
// { mode: 'ranges', text: '1-3, 7, 10-' } (one file for each), { mode: 'every', n } (a file for each n pages) or { mode: 'bookmarks', starts }
// (the pages where a file begins; the first file begins at page 1). Returns { parts } or { error } with a sentence for the dialog.
function splitParts(request, total) {
  const { mode, text, n, starts } = request ?? {};
  if (!Number.isInteger(total) || total < 1 || total > MAX_PAGE) return TOO_MUCH;
  const spans = [];
  if (mode === 'ranges' && typeof text === 'string' && text.length <= 1000) {
    for (const item of text.split(',')) {
      const m = RANGE.exec(item.trim());
      const from = m && Number(m[1]);
      const to = !m ? 0 : m[2] ? (m[3] === '' ? total : Number(m[3])) : from;
      if (m && from >= 1 && Math.max(from, to) > total) return { error: `This document has ${total} page${total === 1 ? '' : 's'}` };
      if (!m || from < 1 || to < from) return { error: SPLIT_WORDS.ranges };
      spans.push([from, to]);
    }
  } else if (mode === 'every' && Number.isInteger(n) && n >= 1 && n < total) {
    if (Math.ceil(total / n) > MAX_PARTS) return TOO_MANY;
    for (let from = 1; from <= total; from += n) spans.push([from, Math.min(from + n - 1, total)]);
  } else if (mode === 'bookmarks' && Array.isArray(starts) && starts.length <= MAX_PARTS && starts.every((s) => Number.isInteger(s) && s >= 1 && s <= total)) {
    const begins = [...new Set([1, ...starts])].sort((a, b) => a - b);
    begins.forEach((from, i) => spans.push([from, (begins[i + 1] ?? total + 1) - 1]));
  } else {
    return { error: SPLIT_WORDS[mode] ?? 'This change cannot be made' };
  }
  if (spans.length > MAX_PARTS) return TOO_MANY;
  if (spans.reduce((sum, [from, to]) => sum + to - from + 1, 0) > MAX_PAGE) return TOO_MUCH;
  return { parts: spans.map(([from, to]) => Array.from({ length: to - from + 1 }, (_, i) => from + i)) };
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

module.exports = { check, arrange, pageRanges, splitParts, OPS, PICTURE_EXTENSIONS };

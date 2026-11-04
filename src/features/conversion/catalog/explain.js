// SPDX-License-Identifier: AGPL-3.0-or-later
// Plain-language reason for "the wheel has nothing to offer for this selection".
const { extOf, groupOf } = require('./formats');

function explainNoTargets(files) {
  const exts = [...new Set(files.map(extOf))];
  if (exts.length > 1) return { title: 'These items are different kinds', detail: 'Select items of the same kind, for example all documents or all images.' };
  const ext = exts[0];
  if (ext === 'lnk') return { title: "Shortcuts can't be converted", detail: 'Drag the file the shortcut points to instead.' };
  const what = ext === 'folder' ? 'folders' : ext ? `.${ext} files` : 'these files';
  if (!groupOf(ext)) return { title: `Can't convert ${what}`, detail: "Pomelo doesn't support this format yet." };
  return { title: `No converter available for ${what}`, detail: 'Open Pomelo settings to see which engines to add.' };
}

module.exports = { explainNoTargets };

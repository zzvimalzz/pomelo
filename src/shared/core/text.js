// SPDX-License-Identifier: AGPL-3.0-or-later
// Small text helpers with no dependencies, shared by every part of the app.

// Shortens the middle of a long name so both its start and its end (the extension) stay readable: "Quarterly…final.docx".
function middleEllipsis(s, max) {
  if (s.length <= max) return s;
  const keep = max - 1, head = Math.ceil(keep * 0.6);
  return `${s.slice(0, head)}…${s.slice(s.length - (keep - head))}`;
}

const capitalize = (s) => s[0].toUpperCase() + s.slice(1);

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

module.exports = { middleEllipsis, capitalize, escapeHtml };

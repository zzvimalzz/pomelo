// SPDX-License-Identifier: AGPL-3.0-or-later
// The view settings the image editor remembers: which Adjust sections are open and whether the panel is shown. The page sends them and
// the settings file may have been edited by hand, so both are read through cleanView, which keeps only the fields that are valid.
const SECTIONS = ['light', 'colour', 'grading', 'curve', 'mixer', 'effects', 'detail'];

function cleanView(raw) {
  const clean = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return clean;
  if (Array.isArray(raw.sections) && raw.sections.every((s) => SECTIONS.includes(s))) clean.sections = [...new Set(raw.sections)];
  if (typeof raw.panel === 'boolean') clean.panel = raw.panel;
  return clean;
}

module.exports = { cleanView };

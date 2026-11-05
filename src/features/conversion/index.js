// SPDX-License-Identifier: AGPL-3.0-or-later
// File conversion: which formats Pomelo knows, which engines are installed, how a (from, to) pair is routed, and running it.
// The rest of the app uses only this file.
const { targetsForFiles, extOf, groupOf, labelOf, extsInGroup, OFFICE, TARGET_ORDER, ALIASES } = require('./catalog/formats');
const { explainNoTargets } = require('./catalog/explain');
const { detectEngines, getEngines } = require('./engines/registry');
const { plansFor, canConvert } = require('./routing/plans');
const { convertFile } = require('./routing/run-plan');

// Every extension Pomelo can read (spellings like .jpeg included), for the right-click menu. Folders are registered on their own.
const sourceExts = [...Object.keys(TARGET_ORDER).filter((e) => e !== 'folder'), ...Object.keys(ALIASES)];

const targetsFor = (files) => targetsForFiles(files, canConvert);

// What the jobs feature needs to time a conversion (it does not import this feature): the format of a file, and the groups of
// extensions that start slowly (LibreOffice) or are pictures.
const timingFormats = { extOf, kinds: { office: new Set(Object.values(OFFICE).flat()), picture: new Set(extsInGroup('image')) } };

module.exports = { detectEngines, getEngines, targetsFor, canConvert, convertFile, plansFor, explainNoTargets, extOf, groupOf, labelOf, timingFormats, sourceExts };

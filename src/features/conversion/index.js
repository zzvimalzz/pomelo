// SPDX-License-Identifier: AGPL-3.0-or-later
// File conversion: which formats Pomelo knows, which engines are installed, how a (from, to) pair is routed, and running it.
// The rest of the app uses only this file.
const { targetsForFiles, extOf, groupOf, labelOf, extsInGroup, OFFICE } = require('./catalog/formats');
const { explainNoTargets } = require('./catalog/explain');
const { detectEngines, getEngines } = require('./engines/registry');
const { plansFor, canConvert } = require('./routing/plans');
const { convertFile } = require('./routing/run-plan');

const targetsFor = (files) => targetsForFiles(files, canConvert);

// What the jobs feature needs to time a conversion (it does not import this feature): the format of a file, and the groups of
// extensions that start slowly (LibreOffice) or are pictures.
const timingFormats = { extOf, kinds: { office: new Set(Object.values(OFFICE).flat()), picture: new Set(extsInGroup('image')) } };

module.exports = { detectEngines, getEngines, targetsFor, canConvert, convertFile, plansFor, explainNoTargets, extOf, groupOf, labelOf, timingFormats };

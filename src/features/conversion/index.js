// SPDX-License-Identifier: AGPL-3.0-or-later
// File conversion: which formats Pomelo knows, which engines are installed, how a (from, to) pair is routed, and running it.
// The rest of the app uses only this file.
const { targetsForFiles } = require('./catalog/formats');
const { explainNoTargets } = require('./catalog/explain');
const { detectEngines, getEngines } = require('./engines/registry');
const { plansFor, canConvert } = require('./routing/plans');
const { convertFile } = require('./routing/run-plan');

const targetsFor = (files) => targetsForFiles(files, canConvert);

module.exports = { detectEngines, getEngines, targetsFor, canConvert, convertFile, plansFor, explainNoTargets };

// SPDX-License-Identifier: AGPL-3.0-or-later
// File conversion: which formats Pomelo knows, which engines are installed, how a (from, to) pair is routed, and running it.
// The rest of the app uses only this file.
const { targetsForFiles, extOf, groupOf, labelOf, extsInGroup, OFFICE, TARGET_ORDER, ALIASES } = require('./catalog/formats');
const { explainNoTargets } = require('./catalog/explain');
const { detectEngines, getEngines } = require('./engines/registry');
const { plansFor, canConvert } = require('./routing/plans');
const { convertFile } = require('./routing/run-plan');
const lock = require('./engine-kit/lock');
const { uniquePath } = require('./engine-kit/outputs');
const { withContext } = require('./engine-kit/context');
const { runHelper } = require('./engine-kit/python');
const { readImage } = require('./engines/builtin/images');

// Every extension Pomelo can read (spellings like .jpeg included), for the right-click menu. Folders are registered on their own.
const sourceExts = [...Object.keys(TARGET_ORDER).filter((e) => e !== 'folder'), ...Object.keys(ALIASES)];

const targetsFor = (files) => targetsForFiles(files, canConvert);

// Protected files: why a file cannot be read as it is ('needed' | 'unsupported' | 'engine', or null), and whether a password opens it.
const probeLocked = (file) => lock.probe(file, extOf(file), getEngines());
const checkPassword = (file, password) => lock.verify(file, extOf(file), password, getEngines());

// Runs python/<script> (pdf_edit.py, pdf_info.py) with the PDF engine for the PDF window, outside a conversion, and resolves with what it printed.
// `secrets` (a password) is written to its standard input as one line of JSON, never put in an argument or the environment. `signal` kills it
// and rejects with CancelledError.
function runPdfTool(script, args, { src, onProgress, signal, secrets } = {}) {
  const python = getEngines().pdf;
  if (!python) return Promise.reject(Object.assign(new Error('The PDF engine is not installed'), { code: 'NO_ENGINE' }));
  return withContext({ signal, outputs: [] }, () => runHelper(python, script, args, { src, onProgress, input: JSON.stringify(secrets || {}) + '\n' }));
}

// What the jobs feature needs to time a conversion (it does not import this feature): the format of a file, and the groups of
// extensions that start slowly (LibreOffice) or are pictures.
const timingFormats = { extOf, kinds: { office: new Set(Object.values(OFFICE).flat()), picture: new Set(extsInGroup('image')) } };

module.exports = { uniquePath, runPdfTool, readImage, detectEngines, getEngines, targetsFor, canConvert, convertFile, probeLocked, checkPassword, plansFor, explainNoTargets, extOf, groupOf, labelOf, timingFormats, sourceExts };

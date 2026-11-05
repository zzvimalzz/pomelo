// SPDX-License-Identifier: AGPL-3.0-or-later
// The engines, and the map of what is installed on this PC. Each engine that needs a program or a Python environment finds
// it with its own detect(), which answers with the keys it is responsible for.
const libreoffice = require('./libreoffice');
const pandoc = require('./pandoc');
const pdfPython = require('./pdf-python');
const heicPython = require('./heic-python');
const ffmpeg = require('./ffmpeg');
const archive = require('./archive');
const subtitle = require('./subtitle');
const builtin = require('./builtin');

// Keys of the engines map, in this order: soffice, pandoc, pdf, ocr, heic, ffmpeg, sevenZip. Each is a path, or null when not
// found. An engine's detect() always answers with all of its keys, so the map is complete without a list of keys here.
const DETECTED = [libreoffice, pandoc, pdfPython, heicPython, ffmpeg, archive];

let engines = {};                                  // until detectEngines() has run, every key reads as not found

function detectEngines(list = DETECTED) {
  engines = Object.assign({}, ...list.map((e) => e.detect()));
  return engines;
}

const getEngines = () => engines;

module.exports = { detectEngines, getEngines, libreoffice, pandoc, pdfPython, heicPython, ffmpeg, archive, subtitle, builtin };

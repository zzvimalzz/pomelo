// SPDX-License-Identifier: AGPL-3.0-or-later
// The built-in engine: converters that need no Office and no extra program. Documents, spreadsheets, PDFs and images.
const documents = require('./documents');
const pdf = require('./pdf');
const spreadsheets = require('./spreadsheets');
const images = require('./images');

const KINDS = [documents, pdf, spreadsheets, images];
const kindOf = (from) => KINDS.find((k) => k.reads(from));

module.exports = {
  name: 'pure',
  supports(from, to) {
    if (from === to) return false;
    return !!kindOf(from)?.writes(from).includes(to);
  },
  run: (job) => (kindOf(job.from) || documents).run(job),
};

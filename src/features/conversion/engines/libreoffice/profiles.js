// SPDX-License-Identifier: AGPL-3.0-or-later
// Private LibreOffice profiles. Starting LibreOffice with a brand-new profile costs 8 to 10 seconds every time (it builds its
// settings first). Pomelo keeps a few profiles of its own (never the user's) and lends one to each conversion: the first use of a
// profile is slow, the rest take a few seconds. A profile can only serve one LibreOffice at a time, so concurrent conversions
// each take a free one.
const path = require('path');
const { enginesRoot } = require('#shared/node/paths');

const PROFILES = 3;
const busy = new Set();
const waiting = [];

function acquireProfile() {
  for (let i = 1; i <= PROFILES; i++) if (!busy.has(i)) { busy.add(i); return Promise.resolve(i); }
  return new Promise((resolve) => waiting.push(resolve));
}

function releaseProfile(i) {
  const next = waiting.shift();
  if (next) next(i); else busy.delete(i);
}

const profileUrl = (i) => 'file:///' + path.join(enginesRoot(), `lo-profile-${i}`).split(path.sep).join('/');

module.exports = { acquireProfile, releaseProfile, profileUrl };

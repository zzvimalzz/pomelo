// SPDX-License-Identifier: AGPL-3.0-or-later
// Progress is reported as a fraction from 0 to 1. A step that is only part of the whole job reports into its share of it.

// -> a function that maps a step's 0..1 onto `share` of the whole job starting at `offset`; undefined when nobody listens.
const scaled = (onProgress, offset, share) => onProgress && ((f) => onProgress(offset + f * share));

module.exports = { scaled };

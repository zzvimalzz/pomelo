// SPDX-License-Identifier: AGPL-3.0-or-later
// A password received from a page: checked, and held as a Buffer so it can be overwritten when it is no longer needed.
const MAX_PASSWORD = 4096;

// Throws unless `value` is a one-line string of 1 to 4096 characters.
function passwordBuffer(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_PASSWORD || /[\r\n]/.test(value)) throw new Error('bad password');
  return Buffer.from(value, 'utf8');
}

module.exports = { passwordBuffer };

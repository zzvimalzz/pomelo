// SPDX-License-Identifier: AGPL-3.0-or-later
// Which addresses a PDF may ask Pomelo to open. A link in a document is hostile input: only a web page or a mail address is opened,
// and what is opened is the address as the URL parser reads it, which is also what the confirmation card shows.
const SCHEMES = new Set(['http:', 'https:', 'mailto:']);
const MAX_LENGTH = 8192;

// The address to show and open, or null when the link must do nothing.
function linkTarget(url) {
  if (typeof url !== 'string' || url.length > MAX_LENGTH) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return SCHEMES.has(parsed.protocol) ? parsed.href : null;
}

module.exports = { linkTarget };

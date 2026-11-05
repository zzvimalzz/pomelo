// SPDX-License-Identifier: AGPL-3.0-or-later
// Where an update may be downloaded from or opened at.

// Hosts a download may come from. `feedHost`: the host of a configured generic update feed, if any.
// `testing` (a local feed given by POMELO_UPDATE_FEED) additionally allows plain http to that same host.
function allowedUrl(url, { feedHost = null, testing = false } = {}) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' && !(testing && u.protocol === 'http:' && u.host === feedHost)) return false;
  if (u.host === 'github.com' || u.host.endsWith('.githubusercontent.com')) return true;
  return !!feedHost && u.host === feedHost;
}

module.exports = { allowedUrl };

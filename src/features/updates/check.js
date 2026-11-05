// SPDX-License-Identifier: AGPL-3.0-or-later
// "Check for updates": asks a release feed whether a newer version exists. Runs only when the user clicks.
//
// Configure in package.json:   "pomelo": { "updateRepo": "owner/name" }      (GitHub Releases, the normal case)
//                         or   "pomelo": { "updateFeed": "https://example.com/latest.json" }
// A generic feed is JSON like { "version": "1.2.0", "url": "https://...", "notes": "..." }.
// With neither set, the check reports "not configured" and makes no network request.
const pkg = require('../../../package.json');
const { allowedUrl } = require('./url-policy');

const CONFIG = pkg.pomelo || {};
const TIMEOUT_MS = 10000;

function feedUrl() {
  if (process.env.POMELO_UPDATE_FEED) return process.env.POMELO_UPDATE_FEED;       // for testing
  if (CONFIG.updateFeed) return CONFIG.updateFeed;
  if (CONFIG.updateRepo && /^[\w.-]+\/[\w.-]+$/.test(CONFIG.updateRepo)) return `https://api.github.com/repos/${CONFIG.updateRepo}/releases/latest`;
  return null;
}

// -1 / 0 / 1, numeric per dotted part; a leading "v" and any "-beta" suffix are ignored.
function compareVersions(a, b) {
  const parts = (v) => String(v).replace(/^v/i, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// Accepts a GitHub release object or the generic feed shape.
function parseRelease(json) {
  if (json && json.tag_name) {
    const assets = Array.isArray(json.assets) ? json.assets : [];
    const installer = assets.find((a) => /setup.*\.exe$/i.test(a.name)) || assets.find((a) => /\.(exe|msi)$/i.test(a.name));
    // GitHub publishes each asset's SHA-256 as "sha256:<hex>": that is what an in-app install is checked against
    const digest = installer && /^sha256:([0-9a-f]{64})$/i.exec(installer.digest || '');
    return { version: String(json.tag_name).replace(/^v/i, ''), url: (installer && installer.browser_download_url) || json.html_url, notes: json.body || '',
      sha256: digest ? digest[1].toLowerCase() : '', size: (installer && installer.size) || 0, installer: !!installer };
  }
  if (json && json.version) return { version: String(json.version).replace(/^v/i, ''), url: json.url || '', notes: json.notes || '', sha256: String(json.sha256 || '').toLowerCase(), size: Number(json.size) || 0, installer: /\.exe$/i.test(json.url || '') };
  throw new Error('The update feed has an unexpected format');
}

// current: the running version. fetchImpl: replaceable for tests.
// -> { state: 'unconfigured' | 'uptodate' | 'available' | 'error', current, latest?, url?, notes?, message? }
async function check({ current, feed = feedUrl(), fetchImpl = fetch }) {
  if (!feed) return { state: 'unconfigured', current };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(feed, { signal: ctl.signal, headers: { Accept: 'application/vnd.github+json, application/json', 'User-Agent': `Pomelo/${current}` } });
    if (res.status === 404) return { state: 'uptodate', current, note: 'No releases published yet' };
    if (!res.ok) throw new Error(`The update server answered ${res.status}`);
    let json;
    try { json = await res.json(); } catch { throw new Error('The update server returned an unexpected response'); }
    const rel = parseRelease(json);
    if (compareVersions(rel.version, current) > 0) return { state: 'available', current, latest: rel.version, url: rel.url, notes: rel.notes.slice(0, 600), sha256: rel.sha256, size: rel.size, installable: rel.installer && !!rel.sha256 };
    return { state: 'uptodate', current };
  } catch (e) {
    const message = e.name === 'AbortError' ? 'The update server did not answer in time'
      : e.message === 'fetch failed' ? "Couldn't reach the update server. Check your internet connection" : e.message;
    return { state: 'error', current, message };
  } finally { clearTimeout(timer); }
}

// Where a download may come from: https on GitHub, or the configured feed's own host.
function downloadRules() {
  let feedHost = null;
  try { feedHost = new URL(feedUrl() || 'http://none.invalid').host; } catch { /* none */ }
  return { feedHost, testing: !!process.env.POMELO_UPDATE_FEED };
}

// Opens the download page or file in the browser: the fallback when an update cannot be installed from inside Pomelo.
// openExternal(url) is Electron's shell.openExternal, handed in by the IPC layer.
async function openDownload(url, openExternal) {
  let u;
  try { u = new URL(url); } catch { return { ok: false, message: 'Not a valid link' }; }
  if (!allowedUrl(u.href, downloadRules())) return { ok: false, message: 'Refusing to open an unexpected link' };
  await openExternal(u.href);
  return { ok: true };
}

module.exports = { check, openDownload, compareVersions, downloadRules };

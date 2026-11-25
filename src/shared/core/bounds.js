// SPDX-License-Identifier: AGPL-3.0-or-later
// Where an app window opens: the place it was left in the last 24 hours, or the middle of the main screen at the default size
// when that place is older or is no longer on any screen. No Electron in here: the app hands in the screens' work areas.
const DEFAULT = { width: 1200, height: 800 };
const MIN = { width: 900, height: 600 };
const TITLE_ROW = 44;
const KEPT_MS = 24 * 60 * 60 * 1000;

const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);

// The title row is what the user drags, so it has to be on a screen: at least 100 px of it, over its full height.
const reachable = (r, area) => Math.min(r.x + r.width, area.x + area.width) - Math.max(r.x, area.x) >= 100 && r.y >= area.y && r.y + TITLE_ROW <= area.y + area.height;

// saved: { x, y, width, height, maximised, savedAt } or anything else; savedAt is when the window was last used, in milliseconds.
// areas: the work areas, the main screen's first. now: the clock, for tests. -> { x, y, width, height, maximised }
function startBounds(saved, areas, now = Date.now()) {
  if (saved && typeof saved === 'object' && ['x', 'y', 'width', 'height', 'savedAt'].every((k) => isNumber(saved[k])) && Math.abs(now - saved.savedAt) < KEPT_MS) {
    const rect = { x: Math.round(saved.x), y: Math.round(saved.y), width: Math.max(Math.round(saved.width), MIN.width), height: Math.max(Math.round(saved.height), MIN.height) };
    if (areas.some((area) => reachable(rect, area))) return { ...rect, maximised: saved.maximised === true };
  }
  const [main] = areas;
  const width = Math.min(DEFAULT.width, main.width);
  const height = Math.min(DEFAULT.height, main.height);
  return { x: main.x + Math.round((main.width - width) / 2), y: main.y + Math.round((main.height - height) / 2), width, height, maximised: false };
}

module.exports = { startBounds, MIN };

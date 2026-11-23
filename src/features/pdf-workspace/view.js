// SPDX-License-Identifier: AGPL-3.0-or-later
// The view settings the PDF window remembers: zoom, layout, the left panel and the page colours. The page sends them and the settings file
// may have been edited by hand, so both are read through cleanView, which keeps only the fields that are valid.
const ZOOMS = ['page-fit', 'page-width'];
const LAYOUTS = ['continuous', 'spread'];
const TABS = ['pages', 'outline'];
const PRESETS = ['original', 'sepia', 'dark'];
const SCALE = { min: 0.1, max: 10 };
const RAIL = { min: 214, max: 320 };
const COLOUR = /^#[0-9a-f]{6}$/i;

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function zoom(v) {
  if (ZOOMS.includes(v)) return v;
  return typeof v === 'number' && v >= SCALE.min && v <= SCALE.max ? v : undefined;
}

function sidebar(v) {
  if (!isObject(v) || typeof v.open !== 'boolean' || !TABS.includes(v.tab) || !Number.isInteger(v.width) || v.width < RAIL.min || v.width > RAIL.max) return undefined;
  return { open: v.open, tab: v.tab, width: v.width };
}

function pageColours(v) {
  if (PRESETS.includes(v)) return v;
  if (!isObject(v) || typeof v.page !== 'string' || typeof v.text !== 'string' || !COLOUR.test(v.page) || !COLOUR.test(v.text)) return undefined;
  return { page: v.page.toLowerCase(), text: v.text.toLowerCase() };
}

function cleanView(raw) {
  const clean = {};
  if (!isObject(raw)) return clean;
  const found = { zoom: zoom(raw.zoom), layout: LAYOUTS.includes(raw.layout) ? raw.layout : undefined, sidebar: sidebar(raw.sidebar), pageColours: pageColours(raw.pageColours) };
  for (const [key, value] of Object.entries(found)) if (value !== undefined) clean[key] = value;
  return clean;
}

module.exports = { cleanView };

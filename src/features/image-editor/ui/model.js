// SPDX-License-Identifier: AGPL-3.0-or-later
// The edits of one picture and their history. An edit is a plain object whose neutral value leaves the picture as it is; the history is
// a list of snapshots with the one on show. Nothing here touches the page. A classic script that adds window.editorModel.
(() => {
  const MAX_ENTRIES = 100;
  // Each adjustment is [lowest, highest, step]. All of them are neutral at 0.
  const RANGES = {
    exposure: [-4, 4, 0.01],
    contrast: [-100, 100, 1], highlights: [-100, 100, 1], shadows: [-100, 100, 1], whites: [-100, 100, 1], blacks: [-100, 100, 1],
    temperature: [-100, 100, 1], tint: [-100, 100, 1], vibrance: [-100, 100, 1], saturation: [-100, 100, 1],
  };
  const neutral = () => ({ ...Object.fromEntries(Object.keys(RANGES).map((key) => [key, 0])), geometry: window.editorGeometry.neutral() });
  const clamp = (v, low, high) => Math.min(Math.max(v, low), high);
  const toLinear = (s) => (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4);

  // The Light values that Auto sets, from the luminance (0 to 1) of every pixel of the picture as it is shown: the darkest and lightest
  // half percent go to the black and white points, the middle goes to a mid grey, and a flat picture gets a little contrast.
  function autoLight(lumas) {
    const sorted = Float32Array.from(lumas).sort();
    const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    const whole = (value, key) => clamp(Math.round(value), RANGES[key][0], RANGES[key][1]);
    return {
      blacks: whole(-(at(0.005) - 0.02) / 0.15 * 100, 'blacks'),
      whites: whole((0.98 - at(0.995)) / 0.15 * 100, 'whites'),
      exposure: Math.round(clamp(Math.log2(toLinear(0.46) / Math.max(1e-4, toLinear(at(0.5)))), -2, 2) * 100) / 100,
      contrast: at(0.75) - at(0.25) < 0.25 ? 10 : 0,
    };
  }

  // Undo steps through results, not through every move. A change made with the same control as the last one folds into the last
  // entry, and arriving back at an earlier snapshot (four quarter turns) drops the entries in between.
  function createHistory() {
    let entries = [{ json: JSON.stringify(neutral()), key: null }];
    let at = 0;
    let saved = entries[0].json;
    let shown = neutral();

    const show = (i) => { at = i; shown = JSON.parse(entries[i].json); };

    function commit(edit, key = null) {
      const json = JSON.stringify(edit);
      if (json === entries[at].json) return;
      entries = entries.slice(0, at + 1);
      const back = entries.findLastIndex((entry) => entry.json === json);
      if (back >= 0) entries.length = back + 1;
      else if (key && at > 0 && entries[at].key === key) entries[at] = { json, key };
      else entries.push({ json, key });
      if (entries.length > MAX_ENTRIES) entries.shift();
      show(entries.length - 1);
    }

    const step = (by) => { if (at + by >= 0 && at + by < entries.length) show(at + by); };

    return {
      current: () => shown,
      commit,
      undo: () => step(-1),
      redo: () => step(1),
      canUndo: () => at > 0,
      canRedo: () => at < entries.length - 1,
      isNeutral: () => entries[at].json === JSON.stringify(neutral()),
      dirty: () => entries[at].json !== saved,
      markSaved: () => { saved = entries[at].json; },
    };
  }

  window.editorModel = { RANGES, neutral, autoLight, createHistory };
})();

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
  const BANDS = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'];
  const REGIONS = ['shadows', 'midtones', 'highlights'];
  const CHANNELS = ['rgb', 'r', 'g', 'b'];
  const each = (names, value) => Object.fromEntries(names.map((name) => [name, value()]));
  const neutral = () => ({
    ...each(Object.keys(RANGES), () => 0),
    grading: { ...each(REGIONS, () => ({ hue: 0, amount: 0 })), balance: 0 },
    curve: each(CHANNELS, () => [[0, 0], [1, 1]]),
    mixer: each(BANDS, () => ({ hue: 0, sat: 0, lum: 0 })),
    geometry: window.editorGeometry.neutral(),
  });
  const NEUTRAL = JSON.stringify({ ...neutral(), geometry: 0 });
  // Whether anything but the geometry is off its neutral value.
  const adjusted = (edit) => JSON.stringify({ ...edit, geometry: 0 }) !== NEUTRAL;

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

  window.editorModel = { RANGES, BANDS, REGIONS, CHANNELS, neutral, adjusted, createHistory };
})();

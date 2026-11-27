// SPDX-License-Identifier: AGPL-3.0-or-later
// The Adjust tool: the histogram, then the sections (Light with its Auto button, Colour, Colour grading, Curve, Colour mixer), each of
// which opens and closes and shows a reset arrow while it differs from neutral. The values live in the picture's edit, so the page shows, saves and undoes them like
// any other change. While a slider moves, `live` shows the value without a history step; the step is made when the change ends. A
// classic script that adds window.editorAdjust.
(() => {
  const { el, icon } = window.pomeloUi;
  const { RANGES, neutral, autoLight } = window.editorModel;
  const HISTOGRAM_MS = 80;
  const SAMPLE = 256;
  const RAILS = {
    temperature: 'linear-gradient(90deg, #3b7dd8, #cfd3d8 50%, #e8a93a)',
    tint: 'linear-gradient(90deg, #3fae5a, #cfd3d8 50%, #c64fc0)',
    colour: 'linear-gradient(90deg, #8e8e93, #c9c9cc 50%, #ff5a5f 78%, #ffb33a)',
  };
  // A section is rows of sliders, or a tool that builds its own controls with `build`. `keys` are the parts of the edit it changes.
  const SECTIONS = [
    { id: 'light', title: 'Light', auto: true, rows: [['exposure', 'Exposure'], ['contrast', 'Contrast'], ['highlights', 'Highlights'], ['shadows', 'Shadows'], ['whites', 'Whites'], ['blacks', 'Blacks']] },
    { id: 'colour', title: 'Colour', rows: [['temperature', 'Temperature', RAILS.temperature], ['tint', 'Tint', RAILS.tint], ['vibrance', 'Vibrance', RAILS.colour], ['saturation', 'Saturation', RAILS.colour]] },
    { id: 'grading', title: 'Colour grading', keys: ['grading'], build: window.editorGrading.create },
    { id: 'curve', title: 'Curve', keys: ['curve'], build: window.editorCurveEditor.create },
    { id: 'mixer', title: 'Colour mixer', keys: ['mixer'], build: window.editorMixer.create },
  ];

  // tab(): the tab on show. live(patch): shows a change to the tab's edit without a history step. commit(edit, key): makes it a step.
  // sample(edit, longest): a small copy of the picture as `edit` shows it, or null. open: the names of the sections that are open, a
  // Set this tool keeps up to date. remember(names): called with those names whenever the user opens or closes a section.
  function create({ tab, live, commit, sample, open, remember }) {
    const root = document.getElementById('view-adjust');
    const canvas = el('canvas', 'hist');
    const histogram = window.editorHistogram.create(canvas);
    const sliders = [];
    const sections = [];
    const tools = [];
    const blank = neutral();
    let timer = 0;

    // A slider that changes the part of the edit that `set(edit, value)` answers with, and reads it with `get(edit)`. `key` names the
    // control in the history, or is a function that does.
    function slider({ label, key, min, max, step, rail, decimals = 0, get, set }) {
      const made = window.editorSliders.create({
        label, min, max, step, rail, decimals,
        get: () => (tab() ? get(tab().edit) : 0),
        set: (value) => { if (tab()) live(set(tab().edit, value)); },
        done: () => { if (tab()) commit(tab().edit, typeof key === 'function' ? key() : key); },
      });
      sliders.push(made);
      return made;
    }

    function refreshHistogram() {
      timer = 0;
      const t = tab();
      const rgba = t && !root.hidden ? sample(t.edit, SAMPLE)?.rgba ?? null : null;
      histogram.show(rgba);
      for (const tool of tools) tool.backdrop?.(rgba);
    }
    // The histogram follows the edit 80 ms after the last change, so a drag is not slowed down by it.
    function edited() {
      clearTimeout(timer);
      if (!root.hidden) timer = setTimeout(refreshHistogram, HISTOGRAM_MS);
    }

    function auto() {
      const t = tab();
      const small = t && sample({ ...neutral(), geometry: t.edit.geometry }, SAMPLE);
      if (!small) return;
      const lumas = [];
      for (let i = 0; i < small.rgba.length; i += 4) if (small.rgba[i + 3] >= 128) lumas.push((0.2126 * small.rgba[i] + 0.7152 * small.rgba[i + 1] + 0.0722 * small.rgba[i + 2]) / 255);
      if (lumas.length) commit({ ...t.edit, ...autoLight(lumas) }, 'auto');
    }

    root.append(canvas);
    for (const section of SECTIONS) {
      const keys = section.keys ?? section.rows.map(([key]) => key);
      const block = el('div', 'sec');
      const head = el('div', 'sechead');
      const toggle = el('button', 'tog');
      toggle.type = 'button';
      toggle.innerHTML = `${icon('right')}<span>${section.title}</span>`;
      toggle.firstChild.classList.add('chev');
      head.append(toggle);
      if (section.auto) {
        const button = el('button', 'auto', 'Auto');
        button.type = 'button';
        button.title = 'Auto';
        button.onclick = auto;
        head.append(button);
      }
      const reset = el('button', 'rs');
      reset.type = 'button';
      reset.title = 'Reset';
      reset.setAttribute('aria-label', `Reset ${section.title}`);
      reset.innerHTML = icon('rotl');
      reset.onclick = () => { const t = tab(); if (t) commit({ ...t.edit, ...Object.fromEntries(keys.map((key) => [key, blank[key]])) }, null); };
      head.append(reset);

      const body = el('div', 'secbody');
      const clip = el('div');
      const inner = el('div', 'secin');
      for (const [key, label, rail] of section.rows ?? []) {
        const [min, max, step] = RANGES[key];
        inner.append(slider({ label, key: label, min, max, step, rail, decimals: key === 'exposure' ? 2 : 0, get: (edit) => edit[key], set: (edit, value) => ({ [key]: value }) }).el);
      }
      if (section.build) {
        const tool = section.build({ tab, live, commit, slider });
        tools.push(tool);
        inner.append(tool.el);
      }
      clip.append(inner);
      body.append(clip);
      block.append(head, body);
      root.append(block);

      const shut = (on) => {
        block.classList.toggle('open', on);
        toggle.setAttribute('aria-expanded', String(on));
        body.inert = !on;
      };
      toggle.onclick = () => {
        const on = !block.classList.contains('open');
        shut(on);
        if (on) open.add(section.id); else open.delete(section.id);
        remember([...open]);
      };
      shut(open.has(section.id));
      sections.push({ block, keys });
    }

    return {
      // Shows the values of the tab on show again, after it changed or another tab came.
      paint() {
        const t = tab();
        for (const made of sliders) made.paint();
        for (const tool of tools) tool.paint();
        for (const { block, keys } of sections) block.classList.toggle('changed', !!t && keys.some((key) => JSON.stringify(t.edit[key]) !== JSON.stringify(blank[key])));
        edited();
      },
      edited,
      // Ends a change a key press started, before something else changes the picture or the tab.
      settle() { for (const made of sliders) made.flush(); },
    };
  }

  window.editorAdjust = { create };
})();

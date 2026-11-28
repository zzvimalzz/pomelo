// SPDX-License-Identifier: AGPL-3.0-or-later
// The Colour mixer section: a row of eight colours and, for the one chosen, the Hue, Saturation and Luminance sliders that move only the
// pixels of about that colour. A classic script that adds window.editorMixer.
(() => {
  const { el } = window.pomeloUi;
  const { BANDS } = window.editorModel;
  const NAMES = ['Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta'];
  const SWATCHES = ['#e5483d', '#f08a24', '#f2c916', '#3fb950', '#22b8cf', '#3b82f6', '#8b5cf6', '#e64bb3'];
  const CENTRES = [0, 30, 60, 120, 180, 240, 270, 300];
  const ROWS = [['hue', 'Hue'], ['sat', 'Saturation'], ['lum', 'Luminance']];

  // slider(options): makes a slider that the Adjust tool keeps up to date.
  function create({ slider }) {
    let band = 0;
    const row = el('div', 'swatches');
    const swatches = SWATCHES.map((colour, i) => {
      const button = el('button', 'sw');
      button.type = 'button';
      button.style.background = colour;
      button.title = NAMES[i];
      button.setAttribute('aria-label', NAMES[i]);
      button.onclick = () => { band = i; rails(); paint(); };
      row.append(button);
      return button;
    });

    const rail = {
      hue: () => `linear-gradient(90deg, hsl(${CENTRES[band] - 30} 80% 55%), hsl(${CENTRES[band]} 80% 55%), hsl(${CENTRES[band] + 30} 80% 55%))`,
      sat: () => `linear-gradient(90deg, #8e8e93, ${SWATCHES[band]})`,
      lum: () => `linear-gradient(90deg, #1c1c1e, ${SWATCHES[band]}, #fafafa)`,
    };
    const body = el('div');
    body.append(row);
    const sliders = ROWS.map(([part, label]) => {
      const made = slider({
        label, key: () => `mixer-${BANDS[band]}-${part}`, min: -100, max: 100, step: 1, rail: rail[part](),
        get: (edit) => edit.mixer[BANDS[band]][part],
        set: (edit, value) => ({ mixer: { ...edit.mixer, [BANDS[band]]: { ...edit.mixer[BANDS[band]], [part]: value } } }),
      });
      body.append(made.el);
      return [part, made];
    });
    const rails = () => { for (const [part, made] of sliders) made.setRail(rail[part]()); };

    function paint() {
      swatches.forEach((button, i) => button.classList.toggle('on', i === band));
      for (const [, made] of sliders) made.paint();
    }
    paint();

    return { el: body, paint };
  }

  window.editorMixer = { create };
})();

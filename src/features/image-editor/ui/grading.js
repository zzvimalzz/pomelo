// SPDX-License-Identifier: AGPL-3.0-or-later
// The Colour grading section: three colour wheels, one each for the shadows, the midtones and the highlights, and the Balance slider. On
// a wheel the angle of the puck is the hue and its distance from the middle is the amount. A classic script that adds window.editorGrading.
(() => {
  const { el } = window.pomeloUi;
  const { REGIONS } = window.editorModel;
  const NAMES = { shadows: 'Shadows', midtones: 'Midtones', highlights: 'Highlights' };
  const RADIUS = 38;

  // tab(), live(patch), commit(edit, key): as in the Adjust tool. slider(options): makes a slider the tool keeps up to date.
  function create({ tab, live, commit, slider }) {
    const row = el('div', 'wheels');
    const wheels = [];
    const set = (region, value) => live({ grading: { ...tab().edit.grading, [region]: value } });

    for (const region of REGIONS) {
      const box = el('div', 'gw');
      const disc = el('div', 'disc');
      const puck = el('i', 'puck');
      disc.title = NAMES[region];
      disc.setAttribute('aria-label', NAMES[region]);
      disc.append(puck);
      box.append(disc, el('span', '', NAMES[region]));
      row.append(box);

      const from = (e) => {
        const at = disc.getBoundingClientRect(), dx = e.clientX - at.left - RADIUS, dy = e.clientY - at.top - RADIUS;
        set(region, { hue: Math.round(((Math.atan2(dy, dx) * 180 / Math.PI) + 360) % 360), amount: Math.round(Math.min(Math.hypot(dx, dy) / RADIUS, 1) * 100) });
      };
      disc.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || !tab()) return;
        disc.setPointerCapture(e.pointerId);
        from(e);
        const move = (m) => from(m);
        const up = () => {
          disc.removeEventListener('pointermove', move);
          disc.removeEventListener('pointerup', up);
          disc.removeEventListener('pointercancel', up);
          commit(tab().edit, `grading-${region}`);
        };
        disc.addEventListener('pointermove', move);
        disc.addEventListener('pointerup', up);
        disc.addEventListener('pointercancel', up);
      });
      disc.addEventListener('dblclick', () => {
        if (!tab()) return;
        set(region, { hue: 0, amount: 0 });
        commit(tab().edit, `grading-${region}`);
      });
      wheels.push({ region, box, puck });
    }

    const balance = slider({
      label: 'Balance', key: 'Balance', min: -100, max: 100, step: 1,
      get: (edit) => edit.grading.balance,
      set: (edit, value) => ({ grading: { ...edit.grading, balance: value } }),
    });
    const body = el('div');
    body.append(row, balance.el);

    return {
      el: body,
      paint() {
        const t = tab();
        for (const { region, box, puck } of wheels) {
          const { hue, amount } = t ? t.edit.grading[region] : { hue: 0, amount: 0 };
          const reach = RADIUS * amount / 100, angle = hue * Math.PI / 180;
          puck.style.left = `${RADIUS + Math.cos(angle) * reach}px`;
          puck.style.top = `${RADIUS + Math.sin(angle) * reach}px`;
          box.classList.toggle('moved', amount > 0);
        }
      },
    };
  }

  window.editorGrading = { create };
})();

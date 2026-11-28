// SPDX-License-Identifier: AGPL-3.0-or-later
// The Curve section: four chips (RGB, Red, Green, Blue) and a box that draws all four curves, with the picture's luminance faint behind.
// Only the chosen curve's points can be touched: a click adds one, a drag moves it, dragging it out of the box or a double click removes
// it, and the two ends move up and down only. A classic script that adds window.editorCurveEditor.
(() => {
  const { el } = window.pomeloUi;
  const { CHANNELS } = window.editorModel;
  const { through } = window.editorCurves;
  const W = 288, H = 220, MAX_POINTS = 8, GAP = 0.01, OUT = 0.12;
  const NAMES = { rgb: 'RGB', r: 'Red', g: 'Green', b: 'Blue' };
  const clamp = (v, low, high) => Math.min(Math.max(v, low), high);

  // tab(), live(patch), commit(edit, key): as in the Adjust tool.
  function create({ tab, live, commit }) {
    let channel = 'rgb';
    let leaving = -1;
    let backdrop = '';
    const box = el('div');
    const chips = el('div', 'chips curvechips');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'curve');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('aria-label', 'Curve');
    const buttons = CHANNELS.map((c) => {
      const button = el('button', 'chip', NAMES[c]);
      button.type = 'button';
      button.dataset.c = c;
      button.onclick = () => { channel = c; paint(); };
      chips.append(button);
      return button;
    });
    box.append(chips, svg);

    const points = () => tab().edit.curve[channel];
    const set = (list) => live({ curve: { ...tab().edit.curve, [channel]: list } });
    const at = (e) => { const r = svg.getBoundingClientRect(); return [clamp((e.clientX - r.left) / r.width, 0, 1), (e.clientY - r.top) / r.height]; };

    svg.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !tab()) return;
      const list = points().map((p) => [...p]);
      let i = e.target.dataset?.i !== undefined ? +e.target.dataset.i : -1;
      if (i < 0) {
        if (list.length >= MAX_POINTS) return;
        const [x] = at(e);
        const y = clamp(through(list)(x), 0, 1);
        if (list.some((p) => Math.abs(p[0] - x) < GAP)) return;
        list.push([x, y]);
        list.sort((a, b) => a[0] - b[0]);
        i = list.findIndex((p) => p[0] === x);
        set(list.map((p) => [...p]));
      }
      svg.setPointerCapture(e.pointerId);
      const move = (m) => {
        const [x, y] = at(m), end = i === 0 || i === list.length - 1;
        leaving = !end && (y < -OUT || y > 1 + OUT) ? i : -1;
        list[i] = [end ? list[i][0] : clamp(x, list[i - 1][0] + GAP, list[i + 1][0] - GAP), clamp(1 - y, 0, 1)];
        set(list.map((p) => [...p]));
      };
      const up = () => {
        svg.removeEventListener('pointermove', move);
        svg.removeEventListener('pointerup', up);
        svg.removeEventListener('pointercancel', up);
        if (leaving >= 0) list.splice(leaving, 1);
        leaving = -1;
        set(list);
        commit(tab().edit, `curve-${channel}`);
      };
      svg.addEventListener('pointermove', move);
      svg.addEventListener('pointerup', up);
      svg.addEventListener('pointercancel', up);
    });
    svg.addEventListener('dblclick', (e) => {
      const i = e.target.dataset?.i;
      if (!tab() || i === undefined || +i === 0 || +i === points().length - 1) return;
      set(points().filter((_, n) => n !== +i));
      commit(tab().edit, `curve-${channel}`);
    });

    const line = (c, curve) => {
      const f = through(curve[c]);
      let d = '';
      for (let n = 0; n <= 96; n++) d += `${n ? 'L' : 'M'}${(n / 96 * W).toFixed(1)} ${((1 - clamp(f(n / 96), 0, 1)) * H).toFixed(1)} `;
      return `<path class="${c === channel ? 'ln' : 'ln dim'} c-${c}" d="${d}"/>`;
    };

    // The pixels of a small copy of the picture: how many have each luminance is drawn as a faint shape behind the curves.
    function setBackdrop(rgba) {
      backdrop = '';
      if (rgba) {
        const bins = new Array(256).fill(0);
        for (let i = 0; i < rgba.length; i += 4) if (rgba[i + 3] >= 128) bins[Math.round(0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2])]++;
        const smooth = window.editorHistogram.smoothed(bins), top = Math.max(...smooth.slice(2, 254)) || 1;
        backdrop = `M0 ${H} ${smooth.map((v, i) => `L${(i / 255 * W).toFixed(1)} ${(H - Math.sqrt(Math.min(1, v / top)) * (H - 20)).toFixed(1)}`).join(' ')} L${W} ${H}Z`;
      }
      paint();
    }

    function paint() {
      buttons.forEach((button) => button.classList.toggle('on', button.dataset.c === channel));
      const t = tab();
      const curve = t?.edit.curve ?? window.editorModel.neutral().curve;
      let grid = '';
      for (let k = 1; k < 4; k++) grid += `<line class="gl" x1="${k * W / 4}" y1="0" x2="${k * W / 4}" y2="${H}"/><line class="gl" x1="0" y1="${k * H / 4}" x2="${W}" y2="${k * H / 4}"/>`;
      const lines = CHANNELS.filter((c) => c !== channel).map((c) => line(c, curve)).join('') + line(channel, curve);
      const dots = curve[channel].map((p, i) => `<circle data-i="${i}" class="c-${channel}${i === leaving ? ' gone' : ''}" cx="${p[0] * W}" cy="${(1 - p[1]) * H}" r="5"/>`).join('');
      svg.innerHTML = `<path class="hl" d="${backdrop}"/>${grid}<line class="diag" x1="0" y1="${H}" x2="${W}" y2="0"/>${lines}${dots}`;
    }
    paint();

    return { el: box, paint, backdrop: setBackdrop };
  }

  window.editorCurveEditor = { create };
})();

// SPDX-License-Identifier: AGPL-3.0-or-later
// The slider row every tool of the panel uses: a label, a value that can be typed, and a track with a thumb. A change is made with `set`
// as the thumb moves, and `done` runs when it ends (the pointer lets go, a key has not been pressed for 400 ms, a value is typed), so one
// drag is one step of the history. A classic script that adds window.editorSliders.
(() => {
  const { el } = window.pomeloUi;
  const KEY_PAUSE_MS = 400;
  // The thumb stays this far inside the track at either end, so its ring and its growth on hover are not cut off by the section.
  const INSET = 9;
  const clamp = (v, low, high) => Math.min(Math.max(v, low), high);

  // A number with a plus or the true minus sign, and zero as 0 however many decimals are shown.
  function signed(v, decimals = 0, unit = '') {
    const text = Math.abs(v).toFixed(decimals);
    return Number(text) === 0 ? `${text}${unit}` : `${v > 0 ? '+' : '−'}${text}${unit}`;
  }
  const along = (share) => `calc(${share} * (100% - ${2 * INSET}px) + ${INSET}px)`;

  // label, min, max, step, neutral: what it controls. get(): the value now. set(v): show a new value. done(): the change is over.
  // rail: a CSS gradient for the track instead of the accent fill. ticks: { count, major } draws a ruler of count steps with a longer mark
  // at every major one, and the value above it, in place of the label and the fill. decimals: digits shown after the point. unit: written after the value.
  // Returns { el, paint, flush, setRail }: paint() shows get() again, flush() ends a change a key press has started and `done` has not run
  // for, setRail(gradient) changes the gradient of a track that has one.
  function create({ label, min, max, step, neutral = 0, rail, ticks, decimals = 0, unit = '', get, set, done }) {
    const row = el('div', 'srow');
    const text = el('label', '', label);
    const value = el('span', 'val');
    const track = el('div', rail ? 'track grad' : 'track');
    const fill = el('i', 'fill');
    const notch = el('i', 'notch');
    const knob = el('i', 'knob');
    if (rail) track.style.setProperty('--track-rail', rail);
    track.append(fill, notch, knob);
    if (ticks) {
      const marks = el('div', 'marks');
      for (let n = 0; n <= ticks.count; n++) {
        const mark = el('i', n % ticks.major ? 'mark' : 'mark major');
        mark.style.left = along(n / ticks.count);
        marks.append(mark);
      }
      track.prepend(marks);
      row.classList.add('ticks');
    }
    track.tabIndex = 0;
    track.setAttribute('role', 'slider');
    track.setAttribute('aria-label', label);
    track.setAttribute('aria-valuemin', String(min));
    track.setAttribute('aria-valuemax', String(max));
    row.append(text, value, track);
    let pause = 0;

    const show = (v) => signed(v, decimals, unit);
    function paint() {
      const v = get(), span = max - min, at = (v - min) / span, zero = (neutral - min) / span;
      knob.style.left = along(at);
      notch.style.left = along(zero);
      fill.style.left = along(Math.min(at, zero));
      fill.style.width = `calc(${Math.abs(at - zero)} * (100% - ${2 * INSET}px))`;
      value.textContent = show(v);
      row.classList.toggle('moved', v !== neutral);
      track.setAttribute('aria-valuenow', String(v));
      track.setAttribute('aria-valuetext', show(v));
    }

    function change(v) {
      const next = Math.round(clamp(v, min, max) / step) * step;
      if (next !== get()) { set(+next.toFixed(4)); paint(); }
    }
    function flush() {
      if (!pause) return;
      clearTimeout(pause);
      pause = 0;
      done();
    }

    const fromX = (x) => { const box = track.getBoundingClientRect(); return min + clamp((x - box.left - INSET) / (box.width - 2 * INSET), 0, 1) * (max - min); };
    track.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      flush();
      track.setPointerCapture(e.pointerId);
      track.classList.add('drag');
      track.focus({ preventScroll: true });
      change(fromX(e.clientX));
      const move = (m) => change(fromX(m.clientX));
      const up = () => {
        track.classList.remove('drag');
        track.removeEventListener('pointermove', move);
        track.removeEventListener('pointerup', up);
        track.removeEventListener('pointercancel', up);
        done();
      };
      track.addEventListener('pointermove', move);
      track.addEventListener('pointerup', up);
      track.addEventListener('pointercancel', up);
    });

    track.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const by = e.shiftKey ? step * 10 : step;
      const to = { ArrowRight: get() + by, ArrowUp: get() + by, ArrowLeft: get() - by, ArrowDown: get() - by, PageUp: get() + step * 10, PageDown: get() - step * 10, Home: neutral }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      change(to);
      clearTimeout(pause);
      pause = setTimeout(() => { pause = 0; done(); }, KEY_PAUSE_MS);
    });

    row.addEventListener('dblclick', (e) => {
      if (e.target.closest('.val')) return;
      flush();
      change(neutral);
      done();
    });

    value.addEventListener('click', () => {
      flush();
      const input = el('input', 'val');
      input.value = String(get());
      input.setAttribute('aria-label', label);
      value.replaceWith(input);
      input.select();
      let open = true;
      const finish = (apply) => {
        if (!open) return;
        open = false;
        const typed = parseFloat(input.value.replace('−', '-'));
        input.replaceWith(value);
        if (apply && !Number.isNaN(typed)) { change(typed); done(); }
        paint();
      };
      // Keys typed in the field are the field's own: Ctrl+Z is for the text, not for the picture.
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      });
      input.addEventListener('blur', () => finish(true));
    });

    paint();
    return { el: row, paint, flush, setRail: (gradient) => track.style.setProperty('--track-rail', gradient) };
  }

  window.editorSliders = { create };
})();

// SPDX-License-Identifier: AGPL-3.0-or-later
// The Crop tool: the frame over the picture (drag it, drag its handles), the aspect ratio chips, the Straighten ruler. The frame is
// kept in the picture's edit as fractions of the turned picture, so the page shows, saves and undoes it like any other change. While
// a drag or a glide runs, the frame is changed with `live`, which is not in the history; the change is committed when it ends. A
// classic script that adds window.editorCrop.
(() => {
  const geo = window.editorGeometry;
  const { el, icon } = window.pomeloUi;
  const ASPECTS = [['free', 'Free'], ['original', 'Original'], ['1:1', 'Square'], ['4:5', '4:5'], ['3:2', '3:2'], ['16:9', '16:9']];
  const PX_PER_DEGREE = 8;
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  // tab(): the tab on show. live(geometry): shows a geometry for the tab without a history step. commit(geometry, key): makes it a step.
  function create({ tab, live, commit }) {
    const frame = document.getElementById('frame');
    let layout = { on: false };
    let session = 0;
    let entry = null;
    let gliding = null;
    let glideFrame = 0;

    const sizes = (t) => geo.turnedSize(t.edit.geometry, t.width, t.height);
    // A key per visit to the tool, so the steps of one visit never fold into those of an earlier one.
    const keyed = (name) => `${name}${session}`;

    const orient = el('button', 'orient');
    orient.type = 'button';
    orient.title = 'Portrait or landscape';
    orient.setAttribute('aria-label', 'Portrait or landscape');
    const aspectLabel = el('div', 'glabel', 'Aspect ratio');
    aspectLabel.append(orient);
    const chips = el('div', 'chips three');
    chips.setAttribute('role', 'radiogroup');
    chips.setAttribute('aria-label', 'Aspect ratio');
    for (const [id, name] of ASPECTS) {
      const chip = el('button', 'chip', name);
      chip.type = 'button';
      chip.setAttribute('role', 'radio');
      chip.dataset.aspect = id;
      chip.onclick = () => chooseAspect(id);
      chips.append(chip);
    }
    const angleText = el('span', '', '0.0°');
    const levelLabel = el('div', 'glabel', 'Straighten');
    levelLabel.append(angleText);
    const ruler = el('div', 'ruler');
    ruler.title = 'Straighten';
    ruler.setAttribute('role', 'slider');
    ruler.setAttribute('aria-label', 'Straighten');
    ruler.setAttribute('aria-valuemin', '-45');
    ruler.setAttribute('aria-valuemax', '45');
    const ticks = Array.from({ length: 91 }, (_, n) => {
      const degree = n - 45, x = 144 + n * PX_PER_DEGREE, long = degree % 5 === 0;
      return `<line class="${degree === 0 ? 'zero' : long ? 'long' : ''}" x1="${x}" x2="${x}" y1="${long ? 12 : 17}" y2="${long ? 32 : 27}"/>`;
    }).join('');
    ruler.innerHTML = `<svg width="${90 * PX_PER_DEGREE + 288}" height="44" viewBox="0 0 ${90 * PX_PER_DEGREE + 288} 44" aria-hidden="true">${ticks}</svg><i class="needle"></i>`;
    const scale = ruler.firstChild;

    function paint() {
      const t = tab();
      if (!t) return;
      const g = t.edit.geometry;
      for (const chip of chips.children) {
        const on = chip.dataset.aspect === g.aspect;
        chip.classList.toggle('on', on);
        chip.setAttribute('aria-checked', String(on));
      }
      orient.disabled = g.aspect === 'free' || g.aspect === '1:1';
      orient.innerHTML = icon(g.portrait ? 'portrait' : 'landscape');
      scale.style.transform = `translateX(${-(g.angle + 45) * PX_PER_DEGREE}px)`;
      const shown = `${g.angle > 0 ? '+' : g.angle < 0 ? '−' : ''}${Math.abs(g.angle).toFixed(1)}°`;
      angleText.textContent = shown;
      ruler.setAttribute('aria-valuenow', String(g.angle));
      ruler.setAttribute('aria-valuetext', shown);
    }

    window.editorView.onDraw((next) => {
      layout = next;
      frame.classList.toggle('on', next.on);
      const t = tab();
      if (!next.on || !t) return;
      const c = t.edit.geometry.crop, [boxW, boxH] = next.box;
      Object.assign(frame.style, { left: `${next.x + c.x * boxW * next.zoom}px`, top: `${next.y + c.y * boxH * next.zoom}px`, width: `${c.w * boxW * next.zoom}px`, height: `${c.h * boxH * next.zoom}px` });
    });

    // Ends a running glide where it was going. A glide whose picture is no longer on show is dropped.
    function settleGlide() {
      if (!gliding) return;
      cancelAnimationFrame(glideFrame);
      const { picture, next } = gliding;
      gliding = null;
      if (tab() === picture) commit(next, keyed('crop'));
    }

    // The frame eases to the geometry `next` in 240 ms, and the change is committed when it arrives.
    function glideTo(next) {
      settleGlide();
      const from = tab().edit.geometry.crop;
      if (reduced()) { commit(next, keyed('crop')); return; }
      gliding = { picture: tab(), next };
      const started = performance.now();
      const step = (now) => {
        const t = Math.min(1, (now - started) / 240);
        if (t === 1) { settleGlide(); return; }
        live({ ...next, crop: geo.between(from, next.crop, 1 - (1 - t) ** 3) });
        glideFrame = requestAnimationFrame(step);
      };
      glideFrame = requestAnimationFrame(step);
    }

    function chooseAspect(aspect, portrait) {
      const t = tab();
      if (!t) return;
      settleGlide();
      const g = t.edit.geometry, [w, h] = sizes(t);
      const turned = portrait ?? (aspect === '4:5' || (aspect === 'original' && h > w));
      const next = { ...g, aspect, portrait: turned };
      const base = aspect === 'original' ? geo.shrinkInside({ x: 0, y: 0, w: 1, h: 1 }, g.angle, w, h) : g.crop;
      glideTo({ ...next, crop: aspect === 'free' ? g.crop : geo.fitRatio(base, geo.ratioOf(next, w, h), g.angle, w, h) });
    }
    orient.onclick = () => { const g = tab()?.edit.geometry; if (g) chooseAspect(g.aspect, !g.portrait); };

    frame.addEventListener('pointerdown', (e) => {
      const t = tab();
      if (!layout.on || !t || e.button !== 0) return;
      e.preventDefault();
      settleGlide();
      const handle = e.target.dataset.h ?? 'move';
      const g = t.edit.geometry, [w, h] = sizes(t), start = g.crop;
      const ratio = geo.ratioOf(g, w, h) ?? (e.shiftKey ? (start.w * w) / (start.h * h) : null);
      const perPixel = 1 / layout.zoom;
      frame.setPointerCapture(e.pointerId);
      frame.classList.add('dragging');
      const move = (m) => {
        const dx = (m.clientX - e.clientX) * perPixel, dy = (m.clientY - e.clientY) * perPixel;
        const next = handle === 'move' ? geo.moveFrame(start, dx / w, dy / h) : geo.resizeFrame(start, handle, dx, dy, ratio, w, h);
        live({ ...g, crop: geo.limit(tab().edit.geometry.crop, next, g.angle, w, h) });
      };
      const up = () => {
        frame.classList.remove('dragging');
        frame.removeEventListener('pointermove', move);
        frame.removeEventListener('pointerup', up);
        frame.removeEventListener('pointercancel', up);
        commit(tab().edit.geometry, keyed('crop'));
      };
      frame.addEventListener('pointermove', move);
      frame.addEventListener('pointerup', up);
      frame.addEventListener('pointercancel', up);
    });

    // Levelling keeps the frame inside the turned picture, shrinking the frame from where it was when the drag began, so dragging back
    // gives the frame back.
    function level(angle, base) {
      const t = tab(), g = t.edit.geometry, [w, h] = sizes(t);
      live({ ...g, angle, crop: geo.fitRatio(geo.shrinkInside(base, angle, w, h), geo.ratioOf(g, w, h), angle, w, h) });
    }

    ruler.addEventListener('pointerdown', (e) => {
      const t = tab();
      if (!t || e.button !== 0) return;
      settleGlide();
      const from = t.edit.geometry.angle, base = t.edit.geometry.crop;
      ruler.setPointerCapture(e.pointerId);
      frame.classList.add('leveling');
      const move = (m) => level(Math.round(Math.min(45, Math.max(-45, from - (m.clientX - e.clientX) / PX_PER_DEGREE)) * 10) / 10, base);
      const up = () => {
        frame.classList.remove('leveling');
        ruler.removeEventListener('pointermove', move);
        ruler.removeEventListener('pointerup', up);
        ruler.removeEventListener('pointercancel', up);
        commit(tab().edit.geometry, keyed('angle'));
      };
      ruler.addEventListener('pointermove', move);
      ruler.addEventListener('pointerup', up);
      ruler.addEventListener('pointercancel', up);
    });
    ruler.addEventListener('dblclick', () => {
      const t = tab();
      if (!t) return;
      level(0, t.edit.geometry.crop);
      commit(t.edit.geometry, keyed('angle'));
    });

    return {
      controls: [aspectLabel, chips, levelLabel, ruler],
      paint,
      settle: settleGlide,
      begin() { session++; entry = tab()?.edit.geometry ?? null; },
      cancel() { settleGlide(); if (entry && tab()) commit(entry, null); },
      // Leaving the tool with the whole picture kept and no level drops the aspect, so choosing one alone is not a change.
      apply() {
        settleGlide();
        const g = tab()?.edit.geometry;
        if (g && geo.isWhole(g.crop) && g.angle === 0 && (g.aspect !== 'free' || g.portrait)) commit({ ...g, aspect: 'free', portrait: false }, keyed('crop'));
      },
    };
  }

  window.editorCrop = { create };
})();

// SPDX-License-Identifier: AGPL-3.0-or-later
// The Crop tool: the frame in the middle of the well (drag its handles to resize it, drag anywhere else to move the picture under it,
// turn the wheel with Ctrl held to zoom it), and the dock under the picture: the Straighten ruler, the aspect ratio strip that takes its
// place, and the aspect button. The frame is kept in the picture's edit as
// fractions of the turned picture, so the page shows, saves and undoes it like any other change. While a drag or a glide runs, the frame
// is changed with `live`, which is not in the history; the change is committed when it ends. A classic script that adds
// window.editorCrop.
(() => {
  const geo = window.editorGeometry;
  const { el, icon } = window.pomeloUi;
  // id and portrait are what the edit keeps; the label is the ratio as it reads, width first. Free and Original show an icon, the rest a
  // rectangle of their shape.
  const TILES = [
    ['free', null, 'Free'], ['original', null, 'Original'], ['1:1', null, 'Square'],
    ['16:9', true, '9:16'], ['16:9', false, '16:9'], ['4:5', true, '4:5'], ['4:5', false, '5:4'], ['4:3', true, '3:4'], ['4:3', false, '4:3'],
    ['3:2', true, '2:3'], ['3:2', false, '3:2'], ['7:5', true, '5:7'], ['7:5', false, '7:5'], ['2:1', true, '1:2'], ['2:1', false, '2:1'],
  ];
  const isTile = (tile, g) => tile[0] === g.aspect && (tile[1] === null || tile[1] === g.portrait);
  function glyphOf([id, , label]) {
    const glyph = el('span', 'glyph');
    if (id === 'free' || id === 'original') { glyph.innerHTML = icon(id === 'free' ? 'cropfree' : 'image'); return glyph; }
    const [w, h] = id === '1:1' ? [1, 1] : label.split(':').map(Number), scale = 18 / Math.max(w, h);
    const shape = el('i', 'shape');
    shape.style.width = `${w * scale}px`;
    shape.style.height = `${h * scale}px`;
    glyph.append(shape);
    return glyph;
  }
  const WHEEL_MS = 160;
  // Starts at full speed, so a wheel that keeps turning does not stutter as each turn takes over from the last.
  const arrive = (t) => 1 - (1 - t) ** 3;
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  // tab(): the tab on show. live(geometry): shows a geometry for the tab without a history step. commit(geometry, key): makes it a step.
  function create({ tab, live, commit }) {
    const frame = document.getElementById('frame');
    const well = document.getElementById('well');
    let layout = { on: false };
    let session = 0;
    let entry = null;
    let gliding = null;
    let glideFrame = 0;
    let endDrag = null;

    const sizes = (t) => geo.turnedSize(t.edit.geometry, t.width, t.height);
    // A key per visit to the tool, so the steps of one visit never fold into those of an earlier one.
    const keyed = (name) => `${name}${session}`;

    const aspect = el('button', 'dockbtn');
    aspect.type = 'button';
    aspect.title = 'Aspect ratio';
    aspect.setAttribute('aria-expanded', 'false');

    const strip = el('div', 'aspects');
    strip.setAttribute('role', 'radiogroup');
    strip.setAttribute('aria-label', 'Aspect ratio');
    strip.hidden = true;
    for (const tile of TILES) {
      const button = el('button', 'tile');
      button.type = 'button';
      button.setAttribute('role', 'radio');
      button.append(glyphOf(tile), el('span', '', tile[2]));
      button.onclick = () => { chooseAspect(tile[0], tile[1] ?? undefined); showStrip(false); };
      strip.append(button);
    }
    function showStrip(on) {
      if (!on && strip.contains(document.activeElement)) aspect.focus({ preventScroll: true });
      strip.hidden = !on;
      slider.el.hidden = on;
      aspect.classList.toggle('on', on);
      aspect.setAttribute('aria-expanded', String(on));
      const chosen = strip.querySelector('.on');
      if (on && chosen) strip.scrollLeft = chosen.offsetLeft - (strip.clientWidth - chosen.offsetWidth) / 2;
      if (on) (chosen ?? strip.firstChild).focus({ preventScroll: true });
    }
    aspect.onclick = () => showStrip(strip.hidden);
    strip.addEventListener('keydown', (e) => {
      const by = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (!by) return;
      const tiles = [...strip.children];
      tiles[Math.min(Math.max(tiles.indexOf(document.activeElement) + by, 0), tiles.length - 1)].focus({ preventScroll: true });
      e.preventDefault();
    });
    window.editorKeys.bind('escape', () => {
      if (strip.hidden) return false;
      showStrip(false);
    });

    // Levelling keeps the frame inside the turned picture, shrinking the frame from where it was when the change began, so moving back
    // gives the frame back.
    let base = null;
    function level(angle) {
      const t = tab(), g = t.edit.geometry, [w, h] = sizes(t);
      base ??= g.crop;
      frame.classList.add('leveling');
      live({ ...g, angle, crop: geo.fitRatio(geo.shrinkInside(base, angle, w, h), geo.ratioOf(g, w, h), angle, w, h) });
    }
    const slider = window.editorSliders.create({
      label: 'Straighten', min: -45, max: 45, step: 0.1, decimals: 1, unit: '°', ticks: { count: 90, major: 5 },
      get: () => tab()?.edit.geometry.angle ?? 0,
      set: level,
      done: () => { base = null; frame.classList.remove('leveling'); if (tab()) commit(tab().edit.geometry, keyed('angle')); },
    });
    const main = el('div', 'dockmain');
    main.append(slider.el, strip);

    function paint() {
      const t = tab();
      if (!t) return;
      const g = t.edit.geometry;
      [...strip.children].forEach((button, n) => {
        const on = isTile(TILES[n], g);
        button.classList.toggle('on', on);
        button.setAttribute('aria-checked', String(on));
      });
      const current = TILES.find((tile) => isTile(tile, g));
      aspect.replaceChildren(glyphOf(current), el('span', '', current[2]));
      slider.paint();
    }

    window.editorView.onDraw((next) => {
      layout = next;
      frame.classList.toggle('on', next.on);
      if (next.on) Object.assign(frame.style, { left: `${next.x}px`, top: `${next.y}px`, width: `${next.w}px`, height: `${next.h}px` });
    });

    // Ends a running glide where it was going. A glide whose picture is no longer on show is dropped.
    function settleGlide() {
      if (!gliding) return;
      cancelAnimationFrame(glideFrame);
      const { picture, next } = gliding;
      gliding = null;
      if (tab() === picture) commit(next, keyed('crop'));
    }

    // Finishes whatever is under way, a drag, a glide or a slider moved with the keys, before something else changes the picture.
    function settle() {
      slider.flush();
      endDrag?.();
      settleGlide();
    }

    // Follows the pointer from the press `e` on `target`. `done` runs once, when the pointer lets go (or its capture is lost some other
    // way) or `settle` ends the drag first; it is told whether the same picture is still on show.
    function drag(target, e, move, done) {
      const picture = tab();
      const end = () => {
        endDrag = null;
        target.removeEventListener('pointermove', move);
        target.removeEventListener('lostpointercapture', end);
        done(tab() === picture);
      };
      target.setPointerCapture(e.pointerId);
      target.addEventListener('pointermove', move);
      target.addEventListener('lostpointercapture', end);
      endDrag = end;
    }

    // The frame goes to the geometry `next` in `ms` along `curve`, and the change is committed when it arrives.
    function glideTo(next, ms = window.editorView.glideMs, curve = window.editorView.ease) {
      const from = tab().edit.geometry.crop;
      if (reduced()) { commit(next, keyed('crop')); return; }
      gliding = { picture: tab(), next };
      const started = performance.now();
      const step = (now) => {
        const t = Math.min(1, Math.max(0, now - started) / ms);
        if (t === 1) { settleGlide(); return; }
        live({ ...next, crop: geo.between(from, next.crop, curve(t)) });
        glideFrame = requestAnimationFrame(step);
      };
      glideFrame = requestAnimationFrame(step);
    }

    function chooseAspect(aspect, portrait) {
      const t = tab();
      if (!t) return;
      settle();
      const g = t.edit.geometry, [w, h] = sizes(t);
      const turned = portrait ?? (aspect === 'original' && h > w);
      const next = { ...g, aspect, portrait: turned };
      const base = aspect === 'original' ? geo.shrinkInside({ x: 0, y: 0, w: 1, h: 1 }, g.angle, w, h) : g.crop;
      glideTo({ ...next, crop: aspect === 'free' ? g.crop : geo.fitRatio(base, geo.ratioOf(next, w, h), g.angle, w, h) });
    }

    well.addEventListener('pointerdown', (e) => {
      if (!layout.on || !tab() || e.button !== 0 || e.target.closest('.pill, .cropui, .veil, .gpu')) return;
      e.preventDefault();
      settle();
      const handle = e.target.dataset.h;
      const g = tab().edit.geometry, [w, h] = sizes(tab()), start = g.crop;
      const ratio = geo.ratioOf(g, w, h) ?? (e.shiftKey ? (start.w * w) / (start.h * h) : null);
      const perPixel = 1 / layout.zoom;
      if (handle) window.editorView.holdView();
      else well.classList.add('panning');
      frame.classList.add('dragging');
      drag(e.target, e, (m) => {
        const dx = (m.clientX - e.clientX) * perPixel, dy = (m.clientY - e.clientY) * perPixel;
        // The picture follows the pointer, so the frame goes the other way across it.
        const next = handle
          ? geo.limit(tab().edit.geometry.crop, geo.resizeFrame(start, handle, dx, dy, ratio, w, h), g.angle, w, h)
          : geo.moveFrame(start, -dx / w, -dy / h, g.angle, w, h);
        live({ ...g, crop: next });
      }, (same) => {
        well.classList.remove('panning');
        frame.classList.remove('dragging');
        if (same) commit(tab().edit.geometry, keyed('crop'));
        window.editorView.releaseView();
      });
    });

    // Zooming makes the frame smaller or larger about the point under the pointer, which the view, following the frame, shows as the
    // picture growing or shrinking around that point.
    well.addEventListener('wheel', (e) => {
      if (!e.ctrlKey || !layout.on || !tab()) return;
      endDrag?.();
      // A turn of the wheel during a glide builds on where that glide was going.
      const aim = gliding?.picture === tab() ? gliding.next : tab().edit.geometry;
      cancelAnimationFrame(glideFrame);
      gliding = null;
      const seen = tab().edit.geometry.crop, [w, h] = sizes(tab()), box = frame.getBoundingClientRect();
      const px = seen.x + seen.w * (e.clientX - box.left) / box.width, py = seen.y + seen.h * (e.clientY - box.top) / box.height;
      const next = geo.zoomFrame(aim.crop, 1 / window.editorView.wheelZoom(e), px, py, aim.angle, w, h, window.editorView.cropFloor());
      glideTo({ ...aim, crop: next }, WHEEL_MS, arrive);
    });

    return {
      main,
      aspect,
      paint,
      settle,
      begin() { session++; entry = tab()?.edit.geometry ?? null; },
      end() { showStrip(false); },
      cancel() { settle(); if (entry && tab()) commit(entry, null); },
      // Leaving the tool with the whole picture kept and no level drops the aspect, so choosing one alone is not a change.
      apply() {
        settle();
        const g = tab()?.edit.geometry;
        if (g && geo.isWhole(g.crop) && g.angle === 0 && (g.aspect !== 'free' || g.portrait)) commit({ ...g, aspect: 'free', portrait: false }, keyed('crop'));
      },
    };
  }

  window.editorCrop = { create };
})();

// SPDX-License-Identifier: AGPL-3.0-or-later
// The Crop tool: the frame in the middle of the well (drag its handles to resize it, drag anywhere else to move the picture under it,
// turn the wheel with Ctrl held to zoom it), the aspect ratio menu and the Straighten slider that open from the crop bar. The frame is kept in the picture's edit as
// fractions of the turned picture, so the page shows, saves and undoes it like any other change. While a drag or a glide runs, the frame
// is changed with `live`, which is not in the history; the change is committed when it ends. A classic script that adds
// window.editorCrop.
(() => {
  const geo = window.editorGeometry;
  const { el, icon } = window.pomeloUi;
  const ASPECTS = [['free', 'Free'], ['original', 'Original'], ['1:1', 'Square'], ['4:5', '4:5'], ['3:2', '3:2'], ['16:9', '16:9']];
  // CSS pixels the crop view keeps free at the bottom of the well: the bar, and the bar with the Straighten slider above it.
  const BAR_ROOM = 30;
  const LEVEL_ROOM = 102;
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

    const aspect = el('button', 'pillbtn aspectbtn');
    aspect.type = 'button';
    aspect.title = 'Aspect ratio';
    aspect.setAttribute('aria-haspopup', 'menu');
    aspect.setAttribute('aria-expanded', 'false');
    const aspectName = el('span');
    aspect.append(aspectName);
    aspect.insertAdjacentHTML('beforeend', icon('down'));
    const orient = el('button', 'ib orient');
    orient.type = 'button';
    orient.title = 'Portrait or landscape';
    orient.setAttribute('aria-label', 'Portrait or landscape');

    const menu = el('div', 'zmenu amenu');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Aspect ratio');
    menu.hidden = true;
    for (const [id, name] of ASPECTS) {
      const item = el('button', 'mi', name);
      item.type = 'button';
      item.setAttribute('role', 'menuitemradio');
      item.dataset.aspect = id;
      item.onclick = () => { closeMenu(); chooseAspect(id); };
      menu.append(item);
    }
    function closeMenu() {
      if (menu.contains(document.activeElement)) aspect.focus({ preventScroll: true });
      menu.hidden = true;
      aspect.setAttribute('aria-expanded', 'false');
    }
    aspect.onclick = () => {
      if (!menu.hidden) { closeMenu(); return; }
      const box = aspect.getBoundingClientRect(), room = well.getBoundingClientRect();
      menu.style.left = `${box.left + box.width / 2 - room.left}px`;
      menu.hidden = false;
      aspect.setAttribute('aria-expanded', 'true');
      (menu.querySelector('.on') ?? menu.firstChild).focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !e.target.closest('.amenu, .aspectbtn')) closeMenu(); });
    menu.addEventListener('keydown', (e) => {
      const by = { ArrowDown: 1, ArrowUp: -1 }[e.key];
      if (!by) return;
      const items = [...menu.children];
      items[(items.indexOf(document.activeElement) + by + items.length) % items.length].focus({ preventScroll: true });
      e.preventDefault();
    });
    window.editorKeys.bind('escape', () => {
      if (menu.hidden) return false;
      closeMenu();
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
      label: 'Straighten', min: -45, max: 45, step: 0.1, decimals: 1, unit: '°',
      get: () => tab()?.edit.geometry.angle ?? 0,
      set: level,
      done: () => { base = null; frame.classList.remove('leveling'); if (tab()) commit(tab().edit.geometry, keyed('angle')); },
    });
    const levelBar = el('div', 'zmenu straighten');
    levelBar.hidden = true;
    levelBar.append(slider.el);
    const straighten = el('button', 'pillbtn', 'Straighten');
    straighten.type = 'button';
    straighten.title = 'Straighten';
    straighten.setAttribute('aria-expanded', 'false');
    let levelOpen = false;
    function showLevel(on) {
      levelOpen = on;
      levelBar.hidden = !on;
      straighten.classList.toggle('on', on);
      straighten.setAttribute('aria-expanded', String(on));
      window.editorView.reserve(on ? LEVEL_ROOM : BAR_ROOM);
    }
    straighten.onclick = () => { closeMenu(); if (levelOpen) slider.flush(); showLevel(!levelOpen); };
    well.append(menu, levelBar);

    function paint() {
      const t = tab();
      if (!t) return;
      const g = t.edit.geometry;
      for (const item of menu.children) {
        const on = item.dataset.aspect === g.aspect;
        item.classList.toggle('on', on);
        item.setAttribute('aria-checked', String(on));
      }
      aspectName.textContent = ASPECTS.find(([id]) => id === g.aspect)[1];
      orient.disabled = g.aspect === 'free' || g.aspect === '1:1';
      orient.innerHTML = icon(g.portrait ? 'portrait' : 'landscape');
      straighten.classList.toggle('moved', g.angle !== 0);
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
      const turned = portrait ?? (aspect === '4:5' || (aspect === 'original' && h > w));
      const next = { ...g, aspect, portrait: turned };
      const base = aspect === 'original' ? geo.shrinkInside({ x: 0, y: 0, w: 1, h: 1 }, g.angle, w, h) : g.crop;
      glideTo({ ...next, crop: aspect === 'free' ? g.crop : geo.fitRatio(base, geo.ratioOf(next, w, h), g.angle, w, h) });
    }
    orient.onclick = () => { const g = tab()?.edit.geometry; if (g) chooseAspect(g.aspect, !g.portrait); };

    well.addEventListener('pointerdown', (e) => {
      if (!layout.on || !tab() || e.button !== 0 || e.target.closest('.pill, .zmenu, .veil, .gpu')) return;
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
      controls: { aspect, orient, straighten },
      paint,
      settle,
      begin() { session++; entry = tab()?.edit.geometry ?? null; window.editorView.reserve(levelOpen ? LEVEL_ROOM : BAR_ROOM); },
      end() { closeMenu(); levelBar.hidden = true; levelOpen = false; straighten.classList.remove('on'); straighten.setAttribute('aria-expanded', 'false'); },
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

// SPDX-License-Identifier: AGPL-3.0-or-later
// The well and what is round it: the picture's zoom and pan, the pill with the zoom buttons, the zoom menu, the panel that hides, and
// full screen. Zoom is canvas pixels for each picture pixel, so 100 % is one picture pixel for each screen pixel. In the crop view the
// crop frame is fitted in the middle of the well with the rest of the picture darkened round it, and the view glides between the two. A
// classic script that adds window.editorView; show(tab) takes a tab { width, height, alpha, pixels, edit, view } and keeps its texture
// while it is on show.
(() => {
  const { icon, el } = window.pomeloUi;
  const { label, bind } = window.editorKeys;
  const api = window.editorApi;
  const geometryOf = window.editorGeometry;
  const $ = (id) => document.getElementById(id);
  const well = $('well'), canvas = $('canvas'), snap = $('snap'), stage = $('stage'), checker = $('checker'), zmenu = $('zmenu'), zoomval = $('zoomval');
  const body = document.body, panel = $('panel'), panelButton = $('panelbtn'), pill = $('pill');

  const AIR = 32;
  const CROP_AIR = 48;
  const GLIDE_MS = 450;
  const MAX_ZOOM = 8;
  const STEPS = [0.125, 0.25, 1 / 3, 0.5, 2 / 3, 1, 1.5, 2, 3, 4, 6, 8];
  const PRESETS = [0.25, 0.5, 1, 2, 4, 8];
  const clamp = (v, low, high) => Math.min(Math.max(v, low), high);
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const dpr = () => window.devicePixelRatio || 1;

  let renderer = null;
  try { renderer = window.editorRender.create(canvas); } catch { renderer = null; }
  let lost = false;
  let shown = null;
  let frame = 0;
  let tween = 0;
  let comparing = false;
  let cropping = false;
  let cropK = 0;
  let cropGlide = 0;
  let held = null;
  let settling = null;
  let cropShown = null;
  const drawn = [];

  const geometry = (tab) => (comparing ? geometryOf.neutral() : tab.edit.geometry);
  const sizeOf = (tab) => geometryOf.outputSize(geometry(tab), tab.width, tab.height);
  const fitZoom = (tab) => { const [w, h] = sizeOf(tab); return Math.max(0.01, Math.min(1, (canvas.width - 2 * AIR * dpr()) / w, (canvas.height - 2 * AIR * dpr()) / h)); };
  const zoomOf = (tab) => (tab.view.fit ? fitZoom(tab) : tab.view.zoom);
  // The crop view fills its room with the frame, enlarging a small one.
  const cropRoom = () => [canvas.width - 2 * CROP_AIR * dpr(), canvas.height - 2 * CROP_AIR * dpr()];
  const cutSize = (tab) => geometryOf.cutSize(geometry(tab), tab.width, tab.height);
  const cropZoom = (tab) => { const [w, h] = cutSize(tab), [rw, rh] = cropRoom(); return Math.max(0.01, Math.min(MAX_ZOOM, rw / w, rh / h)); };
  const viewZoom = (tab) => (cropping ? cropZoom(tab) : zoomOf(tab));
  // The size, in picture pixels, of a frame that fills the room at the largest zoom.
  const cropFloor = () => cropRoom().map((side) => side / MAX_ZOOM);
  const wheelZoom = (e) => Math.exp(-e.deltaY * 0.0015);
  // Starts and ends at rest.
  const ease = (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (2 - 2 * t) ** 3 / 2);
  // The view a share `t` of the way from a to b. The zoom changes evenly and the point (x, y) of the picture crosses the screen in a
  // straight line; mixing the two centres instead makes a glide that zooms and moves at once swing off its path.
  function mix(a, b, t, x, y) {
    const zoom = a.zoom + (b.zoom - a.zoom) * t;
    const along = (p, from, to) => p - ((p - from) * a.zoom * (1 - t) + (p - to) * b.zoom * t) / zoom;
    return { zoom, cx: along(x, a.cx, b.cx), cy: along(y, a.cy, b.cy) };
  }

  // How far the picture may be pushed from the middle: until its edge is 32 px inside the well on the far side.
  const reach = (extent, space) => Math.max(0, (extent - space) / 2 + AIR * dpr());
  function clampPan(tab, zoom) {
    const [w, h] = sizeOf(tab);
    const mx = reach(w * zoom, canvas.width), my = reach(h * zoom, canvas.height);
    tab.view.panX = clamp(tab.view.panX, -mx, mx);
    tab.view.panY = clamp(tab.view.panY, -my, my);
    return mx > 0 || my > 0;
  }

  const want = () => { if (!frame) frame = requestAnimationFrame(draw); };

  function place(tab, x, y, w, h) {
    checker.hidden = !tab.alpha;
    Object.assign(checker.style, { left: `${x / dpr()}px`, top: `${y / dpr()}px`, width: `${w / dpr()}px`, height: `${h / dpr()}px` });
  }

  // The frame's place in the turned picture, in picture pixels: its middle and half its size.
  function frameOf(tab) {
    const g = geometry(tab), [boxW, boxH] = geometryOf.turnedSize(g, tab.width, tab.height), c = g.crop;
    return { left: c.x * boxW, top: c.y * boxH, cx: (c.x + c.w / 2) * boxW, cy: (c.y + c.h / 2) * boxH, halfW: c.w * boxW / 2, halfH: c.h * boxH / 2 };
  }

  // Where the crop view looks: at the frame, fitted. While a handle is held the view stays where it was, so the handle follows the
  // pointer, and gives way only as far as it must to keep a growing frame in sight.
  function framed(tab) {
    const f = frameOf(tab), fit = cropZoom(tab);
    if (!held) {
      const target = { zoom: fit, cx: f.cx, cy: f.cy };
      return settling ? mix(settling.from, target, ease(settling.t), f.cx, f.cy) : target;
    }
    const zoom = Math.min(held.zoom, fit), [rw, rh] = cropRoom();
    const reachW = rw / 2 / zoom, reachH = rh / 2 / zoom;
    return { zoom, cx: clamp(held.cx, f.cx + f.halfW - reachW, f.cx - f.halfW + reachW), cy: clamp(held.cy, f.cy + f.halfH - reachH, f.cy - f.halfH + reachH) };
  }

  // The crop view and the way to it: `e`, from 0 to 1, is how far the view has glided from the cropped picture at its own zoom and
  // place to the crop view, while the rest of the picture comes into sight round the frame.
  function drawCrop(tab) {
    const f = frameOf(tab), e = ease(cropK), zoom = zoomOf(tab), v = tab.view;
    clampPan(tab, zoom);
    cropShown = mix({ zoom, cx: f.cx - v.panX / zoom, cy: f.cy - v.panY / zoom }, framed(tab), e, f.cx, f.cy);
    // Left unrounded, unlike outside the crop view: snapping to whole pixels makes a glide shiver.
    const x = canvas.width / 2 + (f.left - cropShown.cx) * cropShown.zoom, y = canvas.height / 2 + (f.top - cropShown.cy) * cropShown.zoom;
    renderer.draw(tab, geometry(tab), cropShown.zoom, x, y, false, e);
    const [w, h] = cutSize(tab).map((side) => side * cropShown.zoom);
    place(tab, x, y, w, h);
    well.classList.toggle('pan', cropping);
    return { x: x / dpr(), y: y / dpr(), w: w / dpr(), h: h / dpr(), zoom: cropShown.zoom / dpr(), on: cropping && cropK === 1 };
  }

  function stopGlide() {
    cancelAnimationFrame(settling?.id);
    settling = null;
  }

  // Eases the crop view from `from` to the frame as it is now. A view already there, as after a drag of the picture, starts no glide:
  // one would hold the view back from a frame that moves again while it runs.
  function glideToFrame(from) {
    stopGlide();
    const to = from && shown && framed(shown);
    const there = to && Math.abs(from.zoom / to.zoom - 1) < 0.01 && Math.hypot(from.cx - to.cx, from.cy - to.cy) * to.zoom < 4;
    if (reduced() || !to || there) { want(); return; }
    const mine = (settling = { from, t: 0, id: 0 }), started = performance.now();
    const step = (now) => {
      mine.t = Math.min(1, (now - started) / GLIDE_MS);
      if (mine.t === 1) settling = null;
      draw();
      if (settling === mine) mine.id = requestAnimationFrame(step);
    };
    mine.id = requestAnimationFrame(step);
    draw();
  }

  function holdView() {
    if (!shown?.texture || !cropping) return;
    held = framed(shown);
    stopGlide();
  }

  function releaseView() {
    if (!held) return;
    held = null;
    glideToFrame(cropShown);
  }

  function draw() {
    frame = 0;
    const tab = shown;
    if (!renderer || lost || !tab?.texture) { checker.hidden = true; readout(); return; }
    let layout = { on: false };
    if (cropping || cropK > 0) layout = drawCrop(tab);
    else {
      const zoom = zoomOf(tab);
      well.classList.toggle('pan', clampPan(tab, zoom));
      const [shownWidth, shownHeight] = sizeOf(tab);
      const w = Math.round(shownWidth * zoom), h = Math.round(shownHeight * zoom);
      const x = Math.round((canvas.width - w) / 2 + tab.view.panX), y = Math.round((canvas.height - h) / 2 + tab.view.panY);
      renderer.draw(tab, geometry(tab), zoom, x, y);
      place(tab, x, y, w, h);
    }
    for (const listener of drawn) listener(layout);
    readout();
  }

  function resize() {
    const d = dpr();
    const width = Math.max(1, Math.round(well.clientWidth * d)), height = Math.max(1, Math.round(well.clientHeight * d));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    draw();
  }
  new ResizeObserver(resize).observe(well);

  function gpuState() {
    const off = !renderer || lost || !!shown?.gpu;
    well.classList.toggle('gpu-off', off);
    $('gpu').hidden = !off;
    panel.classList.toggle('off', off);
    pill.classList.toggle('away', off || cropping);
    panel.inert = off || !panelOpen();
  }
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; gpuState(); });

  // The texture lives only while its tab is on show; the pixels stay with the tab to make it again.
  function show(tab, how) {
    if (shown && shown !== tab && shown.texture) { renderer.drop(shown.texture); shown.texture = null; }
    shown = tab;
    comparing = false;
    stopGlide();
    held = null;
    if (tab && cropping) Object.assign(tab.view, { fit: true, panX: 0, panY: 0 });
    if (tab && !tab.texture && !tab.gpu) {
      if (renderer && !lost && renderer.fits(tab.width, tab.height)) tab.texture = renderer.upload(tab.width, tab.height, tab.pixels);
      else tab.gpu = true;
    }
    closeMenu();
    gpuState();
    draw();
    if (how === 'first') stage.classList.add('first');
    else if (how === 'switch' && !reduced()) stage.animate([{ opacity: 0, transform: 'scale(.98)' }, { opacity: 1, transform: 'none' }], { duration: 240, easing: 'cubic-bezier(.22, 1, .36, 1)' });
  }

  function dispose(tab) {
    if (tab.texture) renderer.drop(tab.texture);
    tab.texture = null;
    if (shown === tab) shown = null;
  }

  // Copies the frame on screen over the picture and fades it out, so the change made next appears to melt in. The frame is drawn again
  // first, because a canvas that has been shown may already be cleared.
  function crossfade(ms) {
    if (reduced() || !shown?.texture) return;
    draw();
    snap.width = canvas.width;
    snap.height = canvas.height;
    snap.getContext('2d').drawImage(canvas, 0, 0);
    snap.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing: 'linear' });
  }

  const compare = $('compare');
  function setCompare(on) {
    if (comparing === on || !shown?.texture || cropping) return;
    crossfade(120);
    comparing = on;
    compare.classList.toggle('held', on);
    draw();
  }
  compare.addEventListener('pointerdown', (e) => { if (e.button === 0) setCompare(true); });
  for (const type of ['pointerup', 'pointerleave', 'pointercancel']) compare.addEventListener(type, () => setCompare(false));
  window.addEventListener('blur', () => setCompare(false));

  // Runs `update`, which changes the edit of the tab on show, and shows the result. `how` says what the user did ({ turn: 1 or -1 }, or
  // { flip: 'h' or 'v' }) so the picture can move from where it was to where it is, and a zoomed picture keeps what was in view.
  function change(update, how) {
    if (!shown?.texture) { update(); return; }
    const before = viewZoom(shown), v = shown.view, from = cropShown;
    update();
    if (how?.turn) [v.panX, v.panY] = how.turn > 0 ? [-v.panY, v.panX] : [v.panY, -v.panX];
    if (how?.flip) v[how.flip === 'h' ? 'panX' : 'panY'] *= -1;
    cancelAnimationFrame(tween);
    if (cropping && !how && !held) glideToFrame(from);
    else {
      if (how) stopGlide();
      draw();
    }
    if (reduced() || !how) return;
    const first = how.turn ? { transform: `rotate(${-90 * how.turn}deg) scale(${before / viewZoom(shown)})` } : { transform: how.flip === 'h' ? 'scaleX(-1)' : 'scaleY(-1)' };
    stage.animate([first, { transform: 'none' }], how.turn ? { duration: 320, easing: 'cubic-bezier(.2, .9, .25, 1.12)' } : { duration: 300, easing: 'cubic-bezier(.22, 1, .36, 1)' });
  }

  // The view that shows `zoom` ('fit' or a number) with the point (px, py), measured from the middle of the well in canvas pixels, held still.
  function target(zoom, px = 0, py = 0) {
    const fit = fitZoom(shown);
    if (zoom === 'fit' || zoom <= fit * 1.001) return { fit: true, zoom: fit, x: 0, y: 0 };
    const next = clamp(zoom, fit, MAX_ZOOM), k = next / zoomOf(shown);
    return { fit: false, zoom: next, x: (shown.view.panX - px) * k + px, y: (shown.view.panY - py) * k + py };
  }

  function apply(to) {
    Object.assign(shown.view, { fit: to.fit, zoom: to.zoom, panX: to.x, panY: to.y });
    want();
  }

  // Zoom at once, for the mouse wheel, which follows the hand.
  function zoomNow(zoom, px, py) {
    cancelAnimationFrame(tween);
    apply(target(zoom, px, py));
  }

  // Zoom with a short glide, for the buttons, the keys and the double-click.
  function zoomTo(zoom, px, py) {
    if (!shown?.texture || cropping) return;
    cancelAnimationFrame(tween);
    const to = target(zoom, px, py);
    if (reduced()) { apply(to); return; }
    const v = shown.view, from = { zoom: zoomOf(shown), x: v.panX, y: v.panY }, started = performance.now();
    v.fit = false;
    const step = (now) => {
      const t = Math.min(1, (now - started) / 220), ease = 1 - (1 - t) ** 3;
      if (t === 1) { apply(to); draw(); return; }
      v.zoom = from.zoom * (to.zoom / from.zoom) ** ease;
      v.panX = from.x + (to.x - from.x) * ease;
      v.panY = from.y + (to.y - from.y) * ease;
      draw();
      tween = requestAnimationFrame(step);
    };
    tween = requestAnimationFrame(step);
  }

  const here = () => (shown ? zoomOf(shown) : 1);
  const zoomIn = () => zoomTo(STEPS.find((s) => s > here() * 1.01) ?? MAX_ZOOM);
  const zoomOut = () => zoomTo([...STEPS].reverse().find((s) => s < here() * 0.99) ?? 'fit');
  const aboutPointer = (e) => { const b = well.getBoundingClientRect(), d = dpr(); return [(e.clientX - b.left - b.width / 2) * d, (e.clientY - b.top - b.height / 2) * d]; };

  well.addEventListener('wheel', (e) => {
    if (!e.ctrlKey || !shown?.texture) return;
    e.preventDefault();
    if (cropping) return;
    zoomNow(here() * wheelZoom(e), ...aboutPointer(e));
  }, { passive: false });

  well.addEventListener('dblclick', (e) => {
    if (e.target.closest('.pill, .zmenu, .veil') || !shown?.texture || cropping) return;
    zoomTo(shown.view.fit ? 1 : 'fit', ...aboutPointer(e));
  });

  well.addEventListener('pointerdown', (e) => {
    if (!well.classList.contains('pan') || cropping || e.button !== 0 || e.target.closest('.pill, .zmenu, .veil')) return;
    cancelAnimationFrame(tween);
    well.setPointerCapture(e.pointerId);
    well.classList.add('panning');
    const d = dpr(), v = shown.view, from = { x: e.clientX * d - v.panX, y: e.clientY * d - v.panY };
    const move = (m) => { v.panX = m.clientX * d - from.x; v.panY = m.clientY * d - from.y; want(); };
    const up = () => { well.classList.remove('panning'); well.removeEventListener('pointermove', move); well.removeEventListener('pointerup', up); };
    well.addEventListener('pointermove', move);
    well.addEventListener('pointerup', up);
  });

  function fill(button, name, text, keyId) {
    button.innerHTML = icon(name);
    button.title = keyId ? `${text} (${label(keyId)})` : text;
    button.setAttribute('aria-label', text);
  }
  compare.innerHTML = icon('compare');
  compare.title = 'Compare (\\)';
  compare.setAttribute('aria-label', 'Compare');
  fill($('zoomout'), 'minus', 'Zoom out', 'zoomOut');
  fill($('zoomin'), 'plus', 'Zoom in', 'zoomIn');
  $('zoomout').onclick = zoomOut;
  $('zoomin').onclick = zoomIn;
  $('gpuicon').innerHTML = icon('image');

  function item(text, key, zoom, run) {
    const b = el('button', 'mi');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.dataset.zoom = zoom;
    b.append(el('span', '', text));
    if (key) b.append(el('kbd', '', key));
    b.onclick = () => { closeMenu(); run(); };
    return b;
  }
  zmenu.append(item('Fit', label('fit'), 'fit', () => zoomTo('fit')), ...PRESETS.map((z) => item(`${z * 100}%`, z === 1 ? label('actualSize') : '', z, () => zoomTo(z))));

  // A preset below Fit is greyed out, because the zoom never goes under Fit.
  function readout() {
    const fit = !shown || shown.view.fit, zoom = here();
    zoomval.textContent = fit ? 'Fit' : `${Math.round(zoom * 100)}%`;
    if (zmenu.hidden) return;
    const floor = shown ? fitZoom(shown) : 0;
    for (const b of zmenu.children) {
      const z = b.dataset.zoom === 'fit' ? null : Number(b.dataset.zoom);
      b.classList.toggle('on', z === null ? fit : !fit && Math.abs(zoom - z) < 0.005);
      b.disabled = z !== null && z < floor * 0.999;
    }
  }

  function closeMenu() {
    if (zmenu.contains(document.activeElement)) zoomval.focus({ preventScroll: true });
    zmenu.hidden = true;
    zoomval.classList.remove('on');
    zoomval.setAttribute('aria-expanded', 'false');
  }
  zoomval.onclick = () => {
    if (!zmenu.hidden) { closeMenu(); return; }
    zmenu.hidden = false;
    zoomval.classList.add('on');
    zoomval.setAttribute('aria-expanded', 'true');
    readout();
    (zmenu.querySelector('.on:not(:disabled)') ?? zmenu.querySelector('.mi:not(:disabled)'))?.focus({ preventScroll: true });
  };
  document.addEventListener('pointerdown', (e) => { if (!zmenu.hidden && !e.target.closest('#zmenu, #zoomval')) closeMenu(); });
  zmenu.addEventListener('keydown', (e) => {
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (!step) return;
    const items = [...zmenu.querySelectorAll('.mi:not(:disabled)')];
    items[(items.indexOf(document.activeElement) + step + items.length) % items.length]?.focus({ preventScroll: true });
    e.preventDefault();
  });

  const panelOpen = () => panel.classList.contains('open');
  function setPanel(on, { remember = true, still = false } = {}) {
    if (still) {
      panel.classList.add('still');
      well.classList.add('still');
      requestAnimationFrame(() => requestAnimationFrame(() => { panel.classList.remove('still'); well.classList.remove('still'); }));
    }
    panel.classList.toggle('open', on);
    body.classList.toggle('shut', !on);
    panel.inert = !on || panel.classList.contains('off');
    fill(panelButton, 'panel', on ? 'Hide panel' : 'Show panel', 'panel');
    if (remember) api.setView({ panel: on });
  }
  panelButton.onclick = () => setPanel(!panelOpen());
  bind('panel', () => setPanel(!panelOpen()));

  const isFull = () => body.classList.contains('full');
  function paintFullScreen(on) {
    body.classList.toggle('full', on);
    body.classList.remove('reveal-top');
    fill($('fullscreen'), on ? 'shrink' : 'expand', on ? 'Exit full screen' : 'Full screen', 'fullScreen');
  }
  $('fullscreen').onclick = () => api.fullScreen(!isFull());
  api.onFullScreen(paintFullScreen);
  paintFullScreen(false);
  document.addEventListener('pointermove', (e) => { if (isFull()) body.classList.toggle('reveal-top', e.clientY < 56 || !!e.target.closest('.titlerow')); });
  document.documentElement.addEventListener('mouseleave', () => body.classList.remove('reveal-top'));

  bind('fullScreen', () => api.fullScreen(!isFull()));
  bind('fit', () => zoomTo('fit'));
  bind('actualSize', () => zoomTo(1));
  bind('zoomIn', zoomIn);
  bind('zoomOut', zoomOut);
  bind('escape', () => {
    if (!zmenu.hidden) closeMenu();
    else if (cropping) return false;
    else if (isFull()) api.fullScreen(false);
    else return false;
    return true;
  });

  // Glides the view to the crop view (on) or back to the cropped picture; the zoom and the pill follow. The view of a zoomed picture is
  // let go when the crop view is reached, and stays at Fit afterwards.
  function setCropping(on) {
    if (cropping === on) return;
    cropping = on;
    cancelAnimationFrame(cropGlide);
    if (!on) held = null;
    pill.classList.toggle('away', on || !renderer || lost || !!shown?.gpu);
    const settle = () => {
      cropK = on ? 1 : 0;
      if (on && shown) Object.assign(shown.view, { fit: true, panX: 0, panY: 0 });
      draw();
    };
    if (reduced() || !shown?.texture) { settle(); return; }
    const first = cropK, started = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - started) / GLIDE_MS);
      if (t === 1) { settle(); return; }
      cropK = first + ((on ? 1 : 0) - first) * t;
      draw();
      cropGlide = requestAnimationFrame(step);
    };
    cropGlide = requestAnimationFrame(step);
  }

  window.editorView = { show, dispose, change, setCompare, setPanel, setCropping, holdView, releaseView, cropFloor, wheelZoom, ease, glideMs: GLIDE_MS, redraw: want, onDraw: (listener) => drawn.push(listener), showPanel: () => { if (!panelOpen()) setPanel(true); } };
})();

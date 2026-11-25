// SPDX-License-Identifier: AGPL-3.0-or-later
// The well and what is round it: the picture's zoom and pan, the pill with the zoom buttons, the zoom ruler, the panel that hides, and
// full screen. Zoom is canvas pixels for each picture pixel, so 100 % is one picture pixel for each screen pixel. A classic script that
// adds window.editorView; show(tab) takes a tab { width, height, alpha, pixels, view } and keeps its texture while it is on show.
(() => {
  const { icon } = window.pomeloUi;
  const { label, bind } = window.editorKeys;
  const api = window.editorApi;
  const $ = (id) => document.getElementById(id);
  const well = $('well'), canvas = $('canvas'), stage = $('stage'), checker = $('checker'), zpop = $('zpop'), zruler = $('zruler');
  const body = document.body, panel = $('panel'), panelButton = $('panelbtn'), pill = $('pill');

  const AIR = 32;
  const MAX_ZOOM = 8;
  const STEPS = [0.125, 0.25, 1 / 3, 0.5, 2 / 3, 1, 1.5, 2, 3, 4, 6, 8];
  const RULER_PX = 96;
  const RULER_MID = 144;
  const SNAP_PX = 6;
  const clamp = (v, low, high) => Math.min(Math.max(v, low), high);
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const dpr = () => window.devicePixelRatio || 1;

  let renderer = null;
  try { renderer = window.editorRender.create(canvas); } catch { renderer = null; }
  let lost = false;
  let shown = null;
  let frame = 0;
  let tween = 0;

  const fitZoom = (tab) => Math.max(0.01, Math.min((canvas.width - 2 * AIR * dpr()) / tab.width, (canvas.height - 2 * AIR * dpr()) / tab.height));
  const zoomOf = (tab) => (tab.view.fit ? fitZoom(tab) : tab.view.zoom);

  // How far the picture may be pushed from the middle: until its edge is 32 px inside the well on the far side.
  const reach = (extent, space) => Math.max(0, (extent - space) / 2 + AIR * dpr());
  function clampPan(tab, zoom) {
    const mx = reach(tab.width * zoom, canvas.width), my = reach(tab.height * zoom, canvas.height);
    tab.view.panX = clamp(tab.view.panX, -mx, mx);
    tab.view.panY = clamp(tab.view.panY, -my, my);
    return mx > 0 || my > 0;
  }

  const want = () => { if (!frame) frame = requestAnimationFrame(draw); };

  function draw() {
    frame = 0;
    const tab = shown;
    if (!renderer || lost || !tab?.texture) { checker.hidden = true; readout(); return; }
    const zoom = zoomOf(tab);
    well.classList.toggle('pan', clampPan(tab, zoom));
    const w = Math.round(tab.width * zoom), h = Math.round(tab.height * zoom);
    const x = Math.round((canvas.width - w) / 2 + tab.view.panX), y = Math.round((canvas.height - h) / 2 + tab.view.panY);
    renderer.draw(tab, zoom, x, y);
    checker.hidden = !tab.alpha;
    Object.assign(checker.style, { left: `${x / dpr()}px`, top: `${y / dpr()}px`, width: `${w / dpr()}px`, height: `${h / dpr()}px` });
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
    pill.classList.toggle('away', off);
    panel.inert = off || !panelOpen();
  }
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; gpuState(); });

  // The texture lives only while its tab is on show; the pixels stay with the tab to make it again.
  function show(tab, how) {
    if (shown && shown !== tab && shown.texture) { renderer.drop(shown.texture); shown.texture = null; }
    shown = tab;
    if (tab && !tab.texture && !tab.gpu) {
      if (renderer && !lost && renderer.fits(tab.width, tab.height)) tab.texture = renderer.upload(tab.width, tab.height, tab.pixels);
      else tab.gpu = true;
    }
    closeRuler();
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

  // Zoom at once, for the wheel and the ruler, which follow the hand.
  function zoomNow(zoom, px, py) {
    cancelAnimationFrame(tween);
    apply(target(zoom, px, py));
  }

  // Zoom with a short glide, for the buttons, the keys and the double-click.
  function zoomTo(zoom, px, py) {
    if (!shown?.texture) return;
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
    zoomNow(here() * Math.exp(-e.deltaY * 0.0015), ...aboutPointer(e));
  }, { passive: false });

  well.addEventListener('dblclick', (e) => {
    if (e.target.closest('.pill, .zpop') || !shown?.texture) return;
    zoomTo(shown.view.fit ? 1 : 'fit', ...aboutPointer(e));
  });

  well.addEventListener('pointerdown', (e) => {
    if (!well.classList.contains('pan') || e.button !== 0 || e.target.closest('.pill, .zpop')) return;
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
  const compare = $('compare');
  compare.innerHTML = icon('compare');
  compare.title = 'Compare (\\)';
  compare.setAttribute('aria-label', 'Compare');
  fill($('zoomout'), 'minus', 'Zoom out', 'zoomOut');
  fill($('zoomin'), 'plus', 'Zoom in', 'zoomIn');
  $('zoomout').onclick = zoomOut;
  $('zoomin').onclick = zoomIn;
  $('gpuicon').innerHTML = icon('image');

  // The zoom ruler: one doubling every 96 px from 3 % to 800 %, veiled below Fit, which the zoom never goes under. It snaps to Fit and to 100 %.
  const rulerX = (zoom) => (Math.log2(zoom) + 5) * RULER_PX;
  let ticks = '';
  for (let i = 0; i <= 64; i++) {
    const x = RULER_MID + i * 12, long = i % 8 === 0;
    ticks += `<line class="${long ? 'big' : ''}" x1="${x}" x2="${x}" y1="${long ? 8 : 14}" y2="${long ? 30 : 24}"/>`;
  }
  ['3%', '6%', '12.5%', '25%', '50%', '100%', '200%', '400%', '800%'].forEach((text, i) => { ticks += `<text x="${RULER_MID + i * RULER_PX}" y="45">${text}</text>`; });
  zruler.insertAdjacentHTML('afterbegin', `<svg width="1056" height="52" viewBox="0 0 1056 52">${ticks}<rect class="below" x="0" y="0" height="52"/><circle r="2.5" cy="36"/></svg>`);
  const scale = zruler.querySelector('svg'), veil = scale.querySelector('.below'), dot = scale.querySelector('circle');

  function readout() {
    const fit = !shown || shown.view.fit, zoom = here(), percent = `${Math.round(zoom * 100)}%`;
    $('zoomval').textContent = fit ? 'Fit' : percent;
    if (zpop.hidden) return;
    $('znum').textContent = percent;
    $('zfit').classList.toggle('on', fit);
    $('z100').classList.toggle('on', !fit && zoom === 1);
    scale.style.transform = `translateX(${-rulerX(zoom)}px)`;
    const fitX = RULER_MID + rulerX(shown ? fitZoom(shown) : 1);
    dot.setAttribute('cx', fitX);
    veil.setAttribute('width', fitX);
  }

  function closeRuler() {
    zpop.hidden = true;
    $('zoomval').classList.remove('on');
    $('zoomval').setAttribute('aria-expanded', 'false');
  }
  $('zoomval').onclick = () => {
    if (!zpop.hidden) { closeRuler(); return; }
    zpop.hidden = false;
    $('zoomval').classList.add('on');
    $('zoomval').setAttribute('aria-expanded', 'true');
    scale.style.transition = 'none';
    readout();
    scale.getBoundingClientRect();
    scale.style.transition = '';
  };
  $('zfit').onclick = () => zoomTo('fit');
  $('z100').onclick = () => zoomTo(1);
  document.addEventListener('pointerdown', (e) => { if (!zpop.hidden && !e.target.closest('#zpop, #zoomval')) closeRuler(); });
  zruler.addEventListener('dblclick', () => zoomTo('fit'));
  zruler.addEventListener('pointerdown', (e) => {
    if (!shown?.texture) return;
    zruler.setPointerCapture(e.pointerId);
    zruler.classList.add('drag');
    const started = e.clientX, start = Math.log2(here());
    const move = (m) => {
      const fit = fitZoom(shown);
      let zoom = 2 ** (start - (m.clientX - started) / RULER_PX);
      if (Math.abs(Math.log2(zoom)) * RULER_PX < SNAP_PX) zoom = 1;
      if (Math.log2(zoom / fit) * RULER_PX < SNAP_PX) zoom = fit;
      zoomNow(Math.min(zoom, MAX_ZOOM), 0, 0);
    };
    const up = () => { zruler.classList.remove('drag'); zruler.removeEventListener('pointermove', move); zruler.removeEventListener('pointerup', up); };
    zruler.addEventListener('pointermove', move);
    zruler.addEventListener('pointerup', up);
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
    if (!zpop.hidden) closeRuler();
    else if (isFull()) api.fullScreen(false);
    else return false;
    return true;
  });

  window.editorView = { show, dispose, setPanel, showPanel: () => { if (!panelOpen()) setPanel(true); } };
})();

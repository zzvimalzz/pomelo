// SPDX-License-Identifier: AGPL-3.0-or-later
// The dock: the page box with its arrows, the zoom buttons and the View menu. It slides away while the user reads downwards and comes
// back on the way up. A grip at its start end moves it (dock-place.js). A classic script that adds window.workspaceDock.
(() => {
  const { el, icon } = window.pomeloUi;
  const { label, bind } = window.workspaceKeys;
  const TUCK_FROM = 80;
  const TUCK_STEP = 6;
  const NEAR_EDGE = 110;
  const SETTLE = 400;
  const WHEEL_STEP = 100;
  const PRESETS = { 'page-fit': 'Fit page', 'page-width': 'Fit width' };

  let viewer = null;
  let menu = null;
  let zoomButton = null;
  let flash = null;
  let flashTimer = null;
  const focusReading = () => document.body.classList.contains('focus');
  const menuOpen = () => !!menu && !menu.hidden;
  const closeMenu = () => { if (menu) { menu.hidden = true; zoomButton.setAttribute('aria-expanded', 'false'); } };

  const well = () => document.querySelector('.well');
  // pdf.js measures where to keep still from the container's offset parent, which is the well.
  const inWell = (x, y) => { const r = well().getBoundingClientRect(); return [x - r.left, y - r.top]; };
  const middle = (container) => { const r = container.getBoundingClientRect(); return inWell(r.left + r.width / 2, r.top + r.height / 2); };

  function button(cls, name, text, id) {
    const b = el('button', cls);
    b.type = 'button';
    b.innerHTML = icon(name);
    b.title = id ? `${text} (${label(id)})` : text;
    b.setAttribute('aria-label', text);
    return b;
  }

  function item(text, id, run) {
    const b = el('button', 'mi', text);
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    if (id) b.append(el('kbd', '', label(id)));
    b.onclick = () => { closeMenu(); run(); };
    return b;
  }

  function buildMenu(layouts) {
    const m = el('div', 'menu');
    m.setAttribute('role', 'menu');
    m.hidden = true;
    m.append(
      el('div', 'cap', 'Zoom'),
      item('Fit width', 'fitWidth', () => { viewer.currentScaleValue = 'page-width'; }),
      item('Fit page', null, () => { viewer.currentScaleValue = 'page-fit'; }),
      item('Actual size', 'actualSize', () => { viewer.currentScaleValue = '1'; }),
      el('hr'),
      el('div', 'cap', 'Layout'),
      ...layouts.map(([text, mode]) => { const b = item(text, null, () => { viewer.spreadMode = mode; }); b.dataset.mode = String(mode); return b; }),
    );
    m.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const items = [...m.querySelectorAll('.mi')];
      items[(items.indexOf(document.activeElement) + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
      e.preventDefault();
    });
    return m;
  }

  function showPill(text) {
    flash.textContent = text;
    flash.classList.add('show');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => flash.classList.remove('show'), 900);
  }

  function watch(pdfViewer, eventBus, container) {
    viewer = pdfViewer;
    const dock = el('nav', 'dock');
    dock.hidden = true;
    const grip = el('button', 'grip');
    grip.type = 'button';
    grip.title = 'Drag to move';
    grip.setAttribute('aria-label', 'Drag to move');
    const previous = button('sm', 'left', 'Previous page', 'previousPage');
    const next = button('sm', 'right', 'Next page', 'nextPage');
    const page = el('input', 'pageno');
    page.setAttribute('aria-label', 'Page');
    page.inputMode = 'numeric';
    const count = el('span', 'pagecount');
    const box = el('span', 'pagebox');
    box.append(page, count);
    const out = button('sm', 'minus', 'Zoom out', 'zoomOut');
    const into = button('sm', 'plus', 'Zoom in', 'zoomIn');
    const zoom = el('button', 'zoom');
    zoomButton = zoom;
    zoom.type = 'button';
    zoom.title = 'View options';
    zoom.setAttribute('aria-haspopup', 'menu');
    zoom.setAttribute('aria-expanded', 'false');
    menu = buildMenu([['Continuous', 0], ['Two pages side by side', 1]]);
    const zoomGroup = el('div', 'zoomgroup');
    zoomGroup.append(out, zoom, menu, into);
    dock.append(grip, previous, box, next, el('span', 'sep'), zoomGroup);
    flash = el('div', 'flash');
    well().append(dock, flash);

    const zoomBy = (steps, at = middle(container)) => viewer.updateScale({ steps, origin: at });
    let settledAt = 0;
    const settle = () => { settledAt = Date.now(); };
    const turn = (n) => { settle(); viewer.currentPageNumber = Math.min(Math.max(n, 1), viewer.pagesCount); };
    previous.onclick = () => { settle(); viewer.previousPage(); };
    next.onclick = () => { settle(); viewer.nextPage(); };
    out.onclick = () => zoomBy(-1);
    into.onclick = () => zoomBy(1);
    zoom.onclick = () => {
      const open = menuOpen();
      closeMenu();
      if (open) return;
      for (const b of menu.querySelectorAll('.mi')) b.classList.toggle('on', b.dataset.mode === String(viewer.spreadMode));
      menu.hidden = false;
      zoom.setAttribute('aria-expanded', 'true');
    };
    const sync = () => { page.value = viewer.currentPageNumber; };
    page.onfocus = () => page.select();
    page.onblur = sync;
    page.onkeydown = (e) => {
      if (e.key === 'Enter') { const n = Number.parseInt(page.value, 10); if (Number.isFinite(n)) turn(n); container.focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); container.focus(); }
    };
    // Keys from here on act on the document, so a click on a button must not take the focus away from it.
    dock.addEventListener('mousedown', (e) => { if (e.target !== page) e.preventDefault(); });
    document.addEventListener('pointerdown', (e) => { if (menuOpen() && !e.target.closest('.zoomgroup')) closeMenu(); });

    eventBus.on('pagesinit', () => {
      count.textContent = `/ ${viewer.pagesCount}`;
      page.size = String(viewer.pagesCount).length + 1;
      sync();
      dock.hidden = false;
    });
    eventBus.on('pagechanging', ({ pageNumber }) => {
      if (document.activeElement !== page) page.value = pageNumber;
      if (focusReading() || dock.classList.contains('tuck')) showPill(`${pageNumber} / ${viewer.pagesCount}`);
    });
    eventBus.on('scalechanging', ({ scale, presetValue }) => {
      zoom.textContent = PRESETS[presetValue] ?? `${Math.round(scale * 100)}%`;
      settle();
    });

    // Zooming and jumping to a page move the scroll position too; only the user's own scrolling should tuck the dock.
    let last = 0;
    container.addEventListener('scroll', () => {
      const moved = container.scrollTop - last;
      last = container.scrollTop;
      if (menuOpen() || dock.matches(':hover') || Date.now() - settledAt < SETTLE) return;
      if (moved > TUCK_STEP && container.scrollTop > TUCK_FROM) dock.classList.add('tuck');
      else if (moved < -TUCK_STEP) dock.classList.remove('tuck');
    }, { passive: true });
    well().addEventListener('pointermove', (e) => {
      if (window.workspaceDockPlace.edgeDistance(e, well().getBoundingClientRect()) < NEAR_EDGE) dock.classList.remove('tuck');
    });

    // Ctrl and the wheel zoom wherever the pointer is. A mouse notch is 100 and one step; a trackpad pinch sends many small turns,
    // which add up to a step.
    let pulled = 0;
    window.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      if (Math.sign(e.deltaY) !== Math.sign(pulled)) pulled = 0;
      pulled += e.deltaMode === 0 ? e.deltaY : e.deltaY * 40;
      const steps = Math.max(-3, Math.min(3, Math.trunc(-pulled / WHEEL_STEP)));
      if (!steps) return;
      pulled += steps * WHEEL_STEP;
      const r = well().getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      zoomBy(steps, inside ? inWell(e.clientX, e.clientY) : middle(container));
    }, { passive: false });
    window.workspaceDockPlace.attach(dock, grip, () => { closeMenu(); dock.classList.remove('tuck'); });

    bind('zoomIn', () => zoomBy(1));
    bind('zoomOut', () => zoomBy(-1));
    bind('fitWidth', () => { viewer.currentScaleValue = 'page-width'; });
    bind('actualSize', () => { viewer.currentScaleValue = '1'; });
    // Outside focus reading these keys keep scrolling the page as the container does itself.
    const turning = (step) => (e) => {
      if (!focusReading() || e.target.closest('.dock')) return false;
      turn(viewer.currentPageNumber + step);
    };
    bind('nextPage', turning(1));
    bind('previousPage', turning(-1));
    container.focus();
  }

  bind('escape', () => (menuOpen() ? (closeMenu(), true) : false));

  window.workspaceDock = { watch };
})();

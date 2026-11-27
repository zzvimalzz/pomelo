// SPDX-License-Identifier: AGPL-3.0-or-later
// The dock: the page box with its arrows, a place for the tools (organise.js fills it), the More menu (workspace.js gives it its items), the zoom buttons and the View menu. A round button beside it slides it off the edge and, once
// it is folded, takes the middle of the place it stood and brings it back. A grip at its start end moves it (dock-place.js). A classic
// script that adds window.workspaceDock.
(() => {
  const { el, icon } = window.pomeloUi;
  const { label, bind } = window.workspaceKeys;
  const WHEEL_STEP = 100;
  const PRESETS = { 'page-fit': 'Fit page', 'page-width': 'Fit width' };
  const COLOURS = [['Original', 'original'], ['Sepia', 'sepia'], ['Dark', 'dark'], ['Custom colours…', 'custom']];

  let viewer = null;
  let menu = null;
  let zoomButton = null;
  let moreMenu = null;
  let moreButton = null;
  let moreItems = [];
  let flash = null;
  let flashTimer = null;
  let folded = false;
  let hide = () => {};
  let grid = () => {};
  let showPage = () => {};
  const focusReading = () => document.body.classList.contains('focus');
  const menuOpen = () => [menu, moreMenu].some((m) => m && !m.hidden);
  const closeMenu = () => {
    for (const [m, b] of [[menu, zoomButton], [moreMenu, moreButton]]) if (m) { m.hidden = true; b.setAttribute('aria-expanded', 'false'); }
  };

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

  function item(text, id, run, trail = id && label(id)) {
    const b = el('button', 'mi', text);
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    if (trail) b.append(el('kbd', '', trail));
    b.onclick = () => { closeMenu(); run(); };
    return b;
  }

  function menuOf(...parts) {
    const m = el('div', 'menu');
    m.setAttribute('role', 'menu');
    m.hidden = true;
    m.append(...parts);
    m.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const items = [...m.querySelectorAll('.mi')];
      items[(items.indexOf(document.activeElement) + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
      e.preventDefault();
    });
    return m;
  }

  const buildMenu = (layouts) => menuOf(
    el('div', 'cap', 'Zoom'),
    item('Fit width', 'fitWidth', () => { viewer.currentScaleValue = 'page-width'; }),
    item('Fit page', null, () => { viewer.currentScaleValue = 'page-fit'; }),
    item('Actual size', 'actualSize', () => { viewer.currentScaleValue = '1'; }),
    el('hr'),
    el('div', 'cap', 'Layout'),
    ...layouts.map(([text, mode]) => { const b = item(text, null, () => { viewer.spreadMode = mode; }); b.dataset.mode = String(mode); return b; }),
    el('hr'),
    el('div', 'cap', 'Page colour'),
    ...COLOURS.map(([text, name]) => {
      const b = item(text, null, () => (name === 'custom' ? window.workspaceColours.choose() : window.workspaceColours.set(name)));
      b.dataset.colour = name;
      return b;
    }),
  );

  function showPill(text) {
    flash.textContent = text;
    flash.classList.add('show');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => flash.classList.remove('show'), 900);
  }

  function watch(pdfViewer, eventBus, container) {
    viewer = pdfViewer;
    const dock = el('nav', 'dock');
    const grip = el('button', 'grip');
    grip.type = 'button';
    grip.title = 'Drag to move';
    grip.setAttribute('aria-label', 'Drag to move');
    const previous = button('sm step', 'left', 'Previous page', 'previousPage');
    const next = button('sm step', 'right', 'Next page', 'nextPage');
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
    const more = button('tool', 'more', 'More');
    moreButton = more;
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    moreMenu = menuOf();
    const moreGroup = el('span', 'moregroup');
    moreGroup.append(more, moreMenu);
    dock.append(grip, previous, box, next, el('span', 'sep'), el('span', 'tools'), moreGroup, el('span', 'sep'), zoomGroup);
    const fold = button('fold', 'right', 'Hide controls');
    const wrap = el('div', 'dockwrap');
    wrap.hidden = true;
    wrap.append(dock, fold);
    flash = el('div', 'flash');
    well().append(wrap, flash);

    const pages = window.workspaceOrganise;
    const zoomBy = (steps, at = middle(container)) => pages.zoom(steps) || viewer.updateScale({ steps, origin: at });
    const turn = (n) => { if (!pages.go(n)) viewer.currentPageNumber = Math.min(Math.max(n, 1), viewer.pagesCount); };
    previous.onclick = () => pages.step(-1) || viewer.previousPage();
    next.onclick = () => pages.step(1) || viewer.nextPage();

    const setFolded = (on) => {
      folded = on;
      closeMenu();
      dock.classList.toggle('folded', on);
      fold.classList.toggle('folded', on);
      dock.inert = on;
      const text = on ? 'Show controls' : 'Hide controls';
      fold.title = text;
      fold.setAttribute('aria-label', text);
    };
    fold.onclick = () => setFolded(!folded);
    out.onclick = () => zoomBy(-1);
    into.onclick = () => zoomBy(1);
    zoom.onclick = () => {
      const open = !menu.hidden;
      closeMenu();
      if (open) return;
      const colour = window.workspaceColours.current();
      for (const b of menu.querySelectorAll('.mi')) b.classList.toggle('on', b.dataset.mode === String(viewer.spreadMode) || b.dataset.colour === (typeof colour === 'object' ? 'custom' : colour));
      menu.hidden = false;
      zoom.setAttribute('aria-expanded', 'true');
    };
    more.onclick = () => {
      const open = !moreMenu.hidden;
      closeMenu();
      if (open) return;
      moreMenu.replaceChildren(...moreItems.map(({ text, key, arrow, run }) => item(text, key, run, arrow ? '›' : undefined)));
      moreMenu.hidden = false;
      more.setAttribute('aria-expanded', 'true');
    };
    // The box is as wide as its digits, so the number and the total sit in the middle between the arrows whatever the page.
    const fit = () => { page.style.width = `calc(${Math.max(page.value.length, 1)}ch + 10px)`; };
    let gridSize = null;
    let scale = '';
    const sync = () => { if (!gridSize) { page.value = viewer.currentPageNumber; fit(); } };
    showPage = (n) => { if (document.activeElement !== page) { page.value = n; fit(); } };
    // `size` is the grid's thumbnail size in words while it is up, and null once it is gone.
    grid = (size) => {
      gridSize = size;
      closeMenu();
      zoom.disabled = !!size;
      zoom.textContent = size ?? scale;
      sync();
    };
    page.oninput = fit;
    page.onfocus = () => page.select();
    page.onblur = sync;
    page.onkeydown = (e) => {
      if (e.key === 'Enter') { const n = Number.parseInt(page.value, 10); if (Number.isFinite(n)) turn(n); container.focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); container.focus(); }
    };
    // Keys from here on act on the document, so a click on a button must not take the focus away from it.
    for (const part of [dock, fold]) part.addEventListener('mousedown', (e) => { if (e.target !== page) e.preventDefault(); });
    document.addEventListener('pointerdown', (e) => { if (menuOpen() && !e.target.closest('.zoomgroup, .moregroup')) closeMenu(); });

    eventBus.on('pagesinit', () => {
      count.replaceChildren(el('span', 'of', '/ '), String(viewer.pagesCount));
      sync();
      wrap.hidden = false;
    });
    hide = () => { closeMenu(); wrap.hidden = true; };
    // The dock stays up while the pages of a document just changed are read again, so it does not drop out and come back each time.
    eventBus.on('pagesdestroy', () => { if (!window.workspaceOrganise.waiting()) hide(); });
    eventBus.on('pagechanging', ({ pageNumber }) => {
      if (gridSize) return;
      if (document.activeElement !== page) { page.value = pageNumber; fit(); }
      if (focusReading() || folded) showPill(`${pageNumber} / ${viewer.pagesCount}`);
    });
    eventBus.on('scalechanging', (e) => {
      scale = PRESETS[e.presetValue] ?? `${Math.round(e.scale * 100)}%`;
      if (!gridSize) zoom.textContent = scale;
    });

    // Ctrl and the wheel zoom wherever the pointer is. A mouse notch is 100 and one step; a trackpad pinch sends many small turns,
    // which add up to a step.
    let pulled = 0;
    window.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      if (window.workspaceDialogs.isOpen()) return;
      if (Math.sign(e.deltaY) !== Math.sign(pulled)) pulled = 0;
      pulled += e.deltaMode === 0 ? e.deltaY : e.deltaY * 40;
      const steps = Math.max(-3, Math.min(3, Math.trunc(-pulled / WHEEL_STEP)));
      if (!steps) return;
      pulled += steps * WHEEL_STEP;
      const r = well().getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      zoomBy(steps, inside ? inWell(e.clientX, e.clientY) : middle(container));
    }, { passive: false });
    window.workspaceDockPlace.attach(wrap, grip, closeMenu);

    bind('zoomIn', () => zoomBy(1));
    bind('zoomOut', () => zoomBy(-1));
    bind('fitWidth', () => { viewer.currentScaleValue = 'page-width'; });
    bind('actualSize', () => { viewer.currentScaleValue = '1'; });
    // Outside focus reading these keys keep scrolling the page as the container does itself.
    const turning = (step) => (e) => {
      if (!focusReading() || e.target.closest('.dock, .panel, .pgrid')) return false;
      turn(viewer.currentPageNumber + step);
    };
    bind('nextPage', turning(1));
    bind('previousPage', turning(-1));
    container.focus();
  }

  bind('escape', () => (menuOpen() ? (closeMenu(), true) : false));

  window.workspaceDock = { watch, hide: () => hide(), grid: (size) => grid(size), showPage: (n) => showPage(n), setMore: (items) => { moreItems = items; } };
})();

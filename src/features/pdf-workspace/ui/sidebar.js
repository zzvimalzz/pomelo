// SPDX-License-Identifier: AGPL-3.0-or-later
// The left panel: a switch between the pages (a thumbnail for every page, the page in view outlined, a click goes to it) and the outline.
// The title row's button slides it open and shut and a grip on its right edge sets its width; nothing is built or drawn until a tab is
// first shown. A classic script that adds window.workspaceSidebar.
(() => {
  const { el, icon } = window.pomeloUi;
  const SLIDE = 350;
  const MIN = 214;
  const MAX = 320;
  const STEP = 16;
  // The panel's width less the thumbnail's: the room round the sheet, which is 120 px at the narrowest.
  const ROOM = 94;
  const panel = document.getElementById('rail');
  const inner = document.getElementById('railinner');
  const list = document.getElementById('thumbs');
  const outlineList = document.getElementById('outline');
  const grip = document.getElementById('railgrip');
  const tabs = { pages: document.getElementById('tabpages'), outline: document.getElementById('taboutline') };
  const button = document.getElementById('pagesbtn');

  button.innerHTML = icon('sidebar');
  button.title = 'Pages and outline';
  button.setAttribute('aria-label', 'Pages and outline');
  grip.setAttribute('aria-valuemin', String(MIN));
  grip.setAttribute('aria-valuemax', String(MAX));
  grip.setAttribute('aria-valuenow', String(MIN));

  function watch(viewer, eventBus, container, linkService, saved) {
    let thumbs = null;
    let first = true;
    const items = [];
    const visible = new Set();
    let rail = MIN;
    let grab = 0;
    let open = false;
    let tab = 'pages';
    let outlined = false;
    let current = null;
    let closing = null;

    const paint = (n, { bitmap, ratio }) => {
      const { button: b, sheet } = items[n - 1];
      const canvas = el('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      b.style.setProperty('--r', String(ratio));
      sheet.replaceChildren(canvas);
    };

    const seen = new IntersectionObserver((changes) => {
      for (const { target, isIntersecting } of changes) {
        const n = Number(target.dataset.n);
        if (!items[n - 1]) continue;
        if (isIntersecting) {
          visible.add(n);
          thumbs.want(n, (image) => paint(n, image));
        } else {
          visible.delete(n);
          thumbs.drop(n);
          items[n - 1].sheet.replaceChildren();
        }
      }
    }, { root: list, rootMargin: '300px 0px' });

    function mark(n, block) {
      if (!items.length) return;
      if (current) {
        current.button.classList.remove('on');
        current.button.tabIndex = -1;
        current.button.removeAttribute('aria-current');
      }
      current = items[n - 1];
      current.button.classList.add('on');
      current.button.tabIndex = 0;
      current.button.setAttribute('aria-current', 'page');
      if (open) current.button.scrollIntoView({ block });
    }

    function build() {
      const grid = el('div', 'thumbs');
      for (let n = 1; n <= viewer.pagesCount; n++) {
        const b = el('button', 'thumb');
        b.type = 'button';
        b.tabIndex = -1;
        b.dataset.n = String(n);
        b.setAttribute('aria-label', `Page ${n}`);
        const item = { button: b, sheet: el('span', 'sheet') };
        const view = viewer.getPageView(n - 1).viewport;
        b.style.setProperty('--r', String(view.height / view.width));
        b.append(item.sheet, String(n));
        items.push(item);
        grid.append(b);
        seen.observe(b);
      }
      list.replaceChildren(grid);
      // The focus stays in the document: a click here must not take the keys away from it.
      grid.addEventListener('mousedown', (e) => e.preventDefault());
      grid.addEventListener('click', (e) => {
        const b = e.target.closest('.thumb');
        if (!b) return;
        viewer.currentPageNumber = Number(b.dataset.n);
        container.focus();
      });
    }

    const remember = () => window.workspaceViewer.remember({ sidebar: { open, tab, width: rail } });

    function show(name) {
      const order = Object.keys(tabs);
      if (open && name !== tab) panel.dataset.turn = order.indexOf(name) > order.indexOf(tab) ? 'next' : 'prev';
      else delete panel.dataset.turn;
      tab = name;
      for (const [id, b] of Object.entries(tabs)) b.setAttribute('aria-checked', String(id === name));
      list.hidden = name !== 'pages';
      outlineList.hidden = name !== 'outline';
      if (name === 'pages') {
        if (!items.length) build();
        mark(viewer.currentPageNumber, 'center');
      } else if (!outlined) {
        outlined = true;
        window.workspaceOutline.fill(outlineList, viewer.pdfDocument, linkService, container);
      }
      remember();
    }

    function setOpen(on) {
      open = on;
      clearTimeout(closing);
      if (on) {
        inner.hidden = false;
        show(tab);
      } else {
        closing = setTimeout(() => { inner.hidden = true; }, SLIDE);
        remember();
      }
      panel.classList.toggle('open', on);
      button.setAttribute('aria-pressed', String(on));
    }

    function setRail(px) {
      rail = Math.min(MAX, Math.max(MIN, Math.round(px)));
      panel.style.setProperty('--rail', `${rail}px`);
      panel.style.setProperty('--sheet', `${rail - ROOM}px`);
      grip.setAttribute('aria-valuenow', String(rail));
    }

    // The sheets follow the width as it is dragged; the pictures are drawn again once it is let go.
    function settle() {
      thumbs?.setWidth(rail - ROOM);
      for (const n of visible) thumbs.want(n, (image) => paint(n, image));
      mark(viewer.currentPageNumber, 'nearest');
      remember();
    }

    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      grip.setPointerCapture(e.pointerId);
      grab = panel.getBoundingClientRect().right - e.clientX;
      panel.classList.add('dragging');
      e.preventDefault();
    });
    grip.addEventListener('pointermove', (e) => {
      if (grip.hasPointerCapture(e.pointerId)) setRail(e.clientX + grab - panel.getBoundingClientRect().left);
    });
    const release = (e) => {
      if (!grip.hasPointerCapture(e.pointerId)) return;
      panel.classList.remove('dragging');
      settle();
    };
    grip.addEventListener('pointerup', release);
    grip.addEventListener('pointercancel', release);
    grip.addEventListener('keydown', (e) => {
      const step = { ArrowLeft: -STEP, ArrowRight: STEP }[e.key];
      if (!step) return;
      setRail(rail + step);
      settle();
      e.preventDefault();
    });

    button.onclick = () => setOpen(!open);
    for (const [name, b] of Object.entries(tabs)) b.onclick = () => show(name);
    button.addEventListener('mousedown', (e) => e.preventDefault());
    if (saved) {
      tab = saved.tab;
      setRail(saved.width);
    }
    eventBus.on('pagesinit', () => {
      thumbs = window.workspaceThumbs.create(viewer.pdfDocument, rail - ROOM);
      api.thumbs = thumbs;
      button.disabled = false;
      if (open) show(tab);
      else if (first && saved?.open) {
        // Reading the width makes the browser apply it before the slide is switched back on, so the panel starts open.
        panel.classList.add('still');
        setOpen(true);
        panel.getBoundingClientRect();
        panel.classList.remove('still');
      }
      first = false;
    });
    eventBus.on('pagesdestroy', () => {
      thumbs?.release();
      thumbs = null;
      api.thumbs = null;
      seen.disconnect();
      items.length = 0;
      visible.clear();
      current = null;
      outlined = false;
      list.replaceChildren();
      outlineList.replaceChildren();
      button.disabled = true;
    });
    eventBus.on('pagechanging', ({ pageNumber }) => mark(pageNumber, 'nearest'));
    window.workspaceViewer.restScrollbar(list);
    window.workspaceViewer.restScrollbar(outlineList);
  }

  const api = { watch, thumbs: null };
  window.workspaceSidebar = api;
})();

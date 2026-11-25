// SPDX-License-Identifier: AGPL-3.0-or-later
// The Pages tool: a button in the dock that swaps the reading view for a grid of every page, with selection by click, Ctrl, Shift, Ctrl+A, the
// keyboard and a rubber band. Without the PDF engine the button shows the engine card first. A classic script that adds window.workspaceOrganise.
(() => {
  const { el, icon } = window.pomeloUi;
  const { label, bind } = window.workspaceKeys;
  const WIDTH = 160;
  const EDGE = 28;
  const DRAG = 4;

  let escape = () => false;
  const span = (a, b) => Array.from({ length: Math.abs(a - b) + 1 }, (_, i) => Math.min(a, b) + i);

  function watch(viewer, eventBus, container) {
    const well = document.querySelector('.well');
    const list = el('div', 'pgrid scrolly');
    const cells = el('div', 'cells');
    const band = el('div', 'band');
    list.hidden = band.hidden = true;
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-multiselectable', 'true');
    list.setAttribute('aria-label', 'Pages');
    list.append(cells, band);
    const bar = el('div', 'optbar');
    bar.hidden = true;
    const count = el('span', 'count');
    count.setAttribute('role', 'status');
    bar.append(count);
    const button = el('button', 'tool');
    button.type = 'button';
    button.innerHTML = `${icon('pages')}<span class="lbl">Pages</span><i class="engdot" hidden></i>`;
    button.title = `Pages (${label('pages')})`;
    button.setAttribute('aria-label', 'Pages');
    button.setAttribute('aria-pressed', 'false');
    well.append(list);
    document.querySelector('.dockwrap').append(bar);
    document.querySelector('.dock .tools').append(button);
    button.addEventListener('mousedown', (e) => e.preventDefault());
    window.workspaceViewer.restScrollbar(list);

    let wanted = false;
    let thumbs = null;
    let selected = new Set();
    let anchor = null;
    let focused = null;
    const cell = (n) => cells.children[n - 1];
    const pageOf = (target) => { const c = target.closest('.cell'); return c ? Number(c.dataset.n) : null; };

    const seen = new IntersectionObserver((changes) => {
      for (const { target, isIntersecting } of changes) {
        const n = Number(target.dataset.n);
        const sheet = target.firstChild;
        if (!thumbs) continue;
        if (isIntersecting) {
          thumbs.want(n, (image) => { target.style.setProperty('--r', String(image.ratio)); sheet.replaceChildren(window.workspaceThumbs.picture(image)); });
        } else {
          thumbs.drop(n);
          sheet.replaceChildren();
        }
      }
    }, { root: list, rootMargin: '400px 0px' });

    function setSelection(next) {
      for (const n of selected) if (!next.has(n)) { cell(n).classList.remove('sel'); cell(n).setAttribute('aria-selected', 'false'); }
      for (const n of next) if (!selected.has(n)) { cell(n).classList.add('sel'); cell(n).setAttribute('aria-selected', 'true'); }
      selected = next;
      bar.hidden = !next.size;
      count.textContent = `${next.size} selected`;
    }

    function focusCell(n) {
      if (focused) cell(focused).tabIndex = -1;
      focused = n;
      cell(n).tabIndex = 0;
      cell(n).focus();
    }

    function pick(n, e) {
      if (e.shiftKey && anchor) setSelection(new Set(e.ctrlKey ? [...selected, ...span(anchor, n)] : span(anchor, n)));
      else if (e.ctrlKey) {
        const next = new Set(selected);
        if (!next.delete(n)) next.add(n);
        setSelection(next);
        anchor = n;
      } else {
        setSelection(new Set([n]));
        anchor = n;
      }
      focusCell(n);
    }

    const columns = () => {
      const top = cells.firstElementChild.offsetTop;
      let n = 0;
      for (const c of cells.children) { if (c.offsetTop !== top) break; n++; }
      return n;
    };

    list.addEventListener('click', (e) => { const n = pageOf(e.target); if (n) pick(n, e); });
    list.addEventListener('dblclick', (e) => { const n = pageOf(e.target); if (n) read(n); });
    list.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key.toLowerCase() === 'a') { setSelection(new Set(span(1, viewer.pagesCount))); e.preventDefault(); return; }
      const total = viewer.pagesCount;
      const across = columns();
      const to = { ArrowLeft: focused - 1, ArrowRight: focused + 1, ArrowUp: focused - across, ArrowDown: focused + across, Home: 1, End: total }[e.key];
      if (to !== undefined) {
        if (to >= 1 && to <= total) pick(to, { shiftKey: e.shiftKey, ctrlKey: false });
        e.preventDefault();
      } else if (e.key === ' ') {
        pick(focused, { shiftKey: false, ctrlKey: true });
        e.preventDefault();
      } else if (e.key === 'Enter') {
        read(focused);
        e.preventDefault();
      }
    });

    list.addEventListener('pointerdown', (e) => {
      const room = list.getBoundingClientRect();
      if (e.button !== 0 || pageOf(e.target) || e.clientX - room.left >= list.clientWidth || e.clientY - room.top >= list.clientHeight) return;
      e.preventDefault();
      const boxes = [...cells.children].map((c, i) => ({ n: i + 1, left: c.offsetLeft, top: c.offsetTop, right: c.offsetLeft + c.offsetWidth, bottom: c.offsetTop + c.offsetHeight }));
      const keep = e.ctrlKey || e.shiftKey ? selected : new Set();
      const start = { x: e.clientX - room.left + list.scrollLeft, y: e.clientY - room.top + list.scrollTop };
      let pointer = { x: e.clientX, y: e.clientY };
      let moved = false;
      list.setPointerCapture(e.pointerId);

      function update() {
        const x = pointer.x - room.left + list.scrollLeft;
        const y = pointer.y - room.top + list.scrollTop;
        const [left, right, top, bottom] = [Math.min(start.x, x), Math.max(start.x, x), Math.min(start.y, y), Math.max(start.y, y)];
        if (!moved && Math.hypot(x - start.x, y - start.y) < DRAG) return;
        moved = true;
        band.hidden = false;
        Object.assign(band.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
        setSelection(new Set([...keep, ...boxes.filter((b) => b.left < right && b.right > left && b.top < bottom && b.bottom > top).map((b) => b.n)]));
      }
      // Past the top or bottom edge the list scrolls on by itself, faster the further the pointer is out.
      const drift = setInterval(() => {
        const out = pointer.y < room.top + EDGE ? pointer.y - room.top - EDGE : pointer.y > room.bottom - EDGE ? pointer.y - room.bottom + EDGE : 0;
        if (out && moved) { list.scrollTop += out / 2; update(); }
      }, 30);
      const move = (ev) => { pointer = { x: ev.clientX, y: ev.clientY }; update(); };
      const end = () => {
        clearInterval(drift);
        list.removeEventListener('pointermove', move);
        list.removeEventListener('pointerup', end);
        list.removeEventListener('pointercancel', end);
        band.hidden = true;
        if (!moved && !keep.size) { setSelection(new Set()); anchor = null; }
        else if (moved) anchor = selected.size ? Math.min(...selected) : null;
      };
      list.addEventListener('pointermove', move);
      list.addEventListener('pointerup', end);
      list.addEventListener('pointercancel', end);
    });

    function build() {
      thumbs = window.workspaceThumbs.create(viewer.pdfDocument, WIDTH);
      for (let n = 1; n <= viewer.pagesCount; n++) {
        const c = el('div', 'cell');
        c.dataset.n = String(n);
        c.tabIndex = -1;
        c.setAttribute('role', 'option');
        c.setAttribute('aria-selected', 'false');
        c.setAttribute('aria-label', `Page ${n}`);
        const { width, height } = viewer.getPageView(n - 1).viewport;
        c.style.setProperty('--r', String(height / width));
        c.append(el('span', 'sheet'), el('span', 'num', String(n)));
        cells.append(c);
        seen.observe(c);
      }
    }

    function teardown() {
      seen.disconnect();
      thumbs?.release();
      thumbs = null;
      cells.replaceChildren();
      selected = new Set();
      anchor = focused = null;
      list.hidden = band.hidden = bar.hidden = true;
      well.classList.remove('organising');
    }

    function show() {
      build();
      list.hidden = false;
      well.classList.add('organising');
      focusCell(viewer.currentPageNumber);
      cell(focused).scrollIntoView({ block: 'center' });
    }

    function sync() {
      button.classList.toggle('on', wanted);
      button.setAttribute('aria-pressed', String(wanted));
      document.body.classList.toggle('tooling', wanted);
    }

    function leave() {
      wanted = false;
      teardown();
      sync();
      container.focus();
    }

    function read(n) {
      leave();
      viewer.currentPageNumber = n;
    }

    const dot = button.querySelector('.engdot');
    const installed = async () => {
      const yes = await window.workspaceApi.engine();
      dot.hidden = yes;
      return yes;
    };

    async function toggle() {
      if (wanted) { leave(); return; }
      if (!(await installed()) && !(await window.workspaceDialogs.engineCard())) return;
      dot.hidden = true;
      wanted = true;
      sync();
      if (viewer.pagesCount) show();
    }

    button.onclick = toggle;
    bind('pages', () => { if (!viewer.pagesCount) return false; toggle(); });
    escape = () => { if (!wanted || list.hidden) return false; leave(); };
    eventBus.on('pagesinit', () => { installed(); if (wanted) show(); });
    eventBus.on('pagesdestroy', teardown);
    api.leave = () => { if (wanted) leave(); };
  }

  bind('escape', () => escape());
  const api = { watch, leave: () => {} };
  window.workspaceOrganise = api;
})();

// SPDX-License-Identifier: AGPL-3.0-or-later
// The Pages tool: a button in the dock that swaps the reading view for a grid of every page, with selection by click, Ctrl, Shift, Ctrl+A, the
// keyboard and a rubber band, and an option bar that turns, deletes and moves the selected pages (by dragging) and undoes and redoes. Each change is a
// list of operations for the PDF engine, after which the pages are read again from the new version. Without the engine the button shows the engine
// card first. A classic script that adds window.workspaceOrganise.
(() => {
  const { el, icon } = window.pomeloUi;
  const { label, bind } = window.workspaceKeys;
  const WIDTH = 160;
  const EDGE = 28;
  const DRAG = 4;

  let escape = () => false;
  const noop = (moved, before) => moved.length === moved.at(-1) - moved[0] + 1 && before >= moved[0] && before <= moved.at(-1) + 1;
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
    const slot = el('div', 'slot');
    slot.hidden = true;
    list.append(slot);
    const action = (name, title, key, run) => {
      const b = el('button', 'sm');
      b.type = 'button';
      b.innerHTML = icon(name);
      b.title = key ? `${title} (${key})` : title;
      b.setAttribute('aria-label', title);
      b.onclick = run;
      return b;
    };
    const turnLeft = action('rotl', 'Rotate left', '', () => rotate(270));
    const turnRight = action('rotr', 'Rotate right', '', () => rotate(90));
    const trash = action('trash', 'Delete', label('deletePages'), () => remove());
    const undo = action('undo', 'Undo', label('undo'), () => step('undo'));
    const redo = action('redo', 'Redo', label('redo'), () => step('redo'));
    bar.append(turnLeft, turnRight, trash, count, el('span', 'sep'), undo, redo);
    bar.addEventListener('mousedown', (e) => e.preventDefault());
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
    let tab = null;
    let busy = false;
    let pending = null;
    let drag = null;
    let dropped = false;
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
      count.textContent = next.size ? `${next.size} selected` : '';
      enable();
    }

    function enable() {
      turnLeft.disabled = turnRight.disabled = trash.disabled = busy || !selected.size;
      undo.disabled = busy || !tab?.doc.canUndo;
      redo.disabled = busy || !tab?.doc.canRedo;
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

    list.addEventListener('click', (e) => { const n = pageOf(e.target); if (n && !dropped) pick(n, e); });
    list.addEventListener('dblclick', (e) => { const n = pageOf(e.target); if (n) read(n); });
    list.addEventListener('keydown', (e) => {
      if (busy) return;
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

    // Follows the pointer from a press to its release, calling update(pointer) as it moves. While `active()` is true and the pointer is past
    // the top or bottom edge the list scrolls on by itself, faster the further out. Returns the function that ends it.
    function track(e, room, { active, update, end }) {
      let pointer = { x: e.clientX, y: e.clientY };
      const drift = setInterval(() => {
        const out = pointer.y < room.top + EDGE ? pointer.y - room.top - EDGE : pointer.y > room.bottom - EDGE ? pointer.y - room.bottom + EDGE : 0;
        if (out && active()) { list.scrollTop += out / 2; update(pointer); }
      }, 30);
      const move = (ev) => { pointer = { x: ev.clientX, y: ev.clientY }; update(pointer); };
      const stop = () => {
        clearInterval(drift);
        list.removeEventListener('pointermove', move);
        list.removeEventListener('pointerup', stop);
        list.removeEventListener('pointercancel', stop);
        end();
      };
      list.addEventListener('pointermove', move);
      list.addEventListener('pointerup', stop);
      list.addEventListener('pointercancel', stop);
      return stop;
    }

    list.addEventListener('pointerdown', (e) => {
      const room = list.getBoundingClientRect();
      if (e.button !== 0 || pageOf(e.target) || e.clientX - room.left >= list.clientWidth || e.clientY - room.top >= list.clientHeight) return;
      e.preventDefault();
      const boxes = [...cells.children].map((c, i) => ({ n: i + 1, left: c.offsetLeft, top: c.offsetTop, right: c.offsetLeft + c.offsetWidth, bottom: c.offsetTop + c.offsetHeight }));
      const keep = e.ctrlKey || e.shiftKey ? selected : new Set();
      const start = { x: e.clientX - room.left + list.scrollLeft, y: e.clientY - room.top + list.scrollTop };
      let moved = false;
      list.setPointerCapture(e.pointerId);
      track(e, room, {
        active: () => moved,
        update(pointer) {
          const x = pointer.x - room.left + list.scrollLeft;
          const y = pointer.y - room.top + list.scrollTop;
          const [left, right, top, bottom] = [Math.min(start.x, x), Math.max(start.x, x), Math.min(start.y, y), Math.max(start.y, y)];
          if (!moved && Math.hypot(x - start.x, y - start.y) < DRAG) return;
          moved = true;
          band.hidden = false;
          Object.assign(band.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
          setSelection(new Set([...keep, ...boxes.filter((b) => b.left < right && b.right > left && b.top < bottom && b.bottom > top).map((b) => b.n)]));
        },
        end() {
          band.hidden = true;
          if (!moved && !keep.size) { setSelection(new Set()); anchor = null; }
          else if (moved) anchor = selected.size ? Math.min(...selected) : null;
        },
      });
    });

    // Pressing a page and pulling it takes the selected pages with it, or only this one when it is not selected. A line shows the gap they go
    // into: before the page the pointer is over, or after it when the pointer is in its right half.
    list.addEventListener('pointerdown', (e) => {
      const n = pageOf(e.target);
      if (!n || e.button !== 0 || e.ctrlKey || e.shiftKey || busy) return;
      const from = { x: e.clientX, y: e.clientY };
      let lifted = null;
      let before = null;
      const stop = track(e, list.getBoundingClientRect(), {
        active: () => !!lifted,
        update(pointer) {
          if (!lifted) {
            if (Math.hypot(pointer.x - from.x, pointer.y - from.y) < DRAG) return;
            if (!selected.has(n)) { setSelection(new Set([n])); anchor = n; }
            lifted = [...selected].sort((a, b) => a - b);
            for (const p of lifted) cell(p).classList.add('lifted');
            list.setPointerCapture(e.pointerId);
            list.classList.add('dragging');
          }
          const over = document.elementFromPoint(pointer.x, pointer.y)?.closest('.cell');
          if (over) {
            const box = over.getBoundingClientRect();
            before = Number(over.dataset.n) + (pointer.x < box.left + box.width / 2 ? 0 : 1);
          }
          const gap = before && !noop(lifted, before) ? (cell(before) ?? cells.lastElementChild) : null;
          slot.hidden = !gap;
          if (gap) Object.assign(slot.style, { left: `${gap.offsetLeft + (cell(before) ? -10 : gap.offsetWidth + 10)}px`, top: `${gap.offsetTop}px`, height: `${gap.offsetHeight}px` });
        },
        end() {
          drag = null;
          list.classList.remove('dragging');
          slot.hidden = true;
          if (!lifted) return;
          for (const p of lifted) cell(p)?.classList.remove('lifted');
          dropped = true;
          setTimeout(() => { dropped = false; });
          if (before && !noop(lifted, before) && !stop.cancelled) move(lifted, before);
        },
      });
      drag = stop;
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

    // After a change the grid is built again, with the pages the change left selected and the list where it was.
    function show() {
      const back = pending?.token === tab?.doc.token ? pending : null;
      pending = null;
      busy = false;
      list.classList.remove('busy');
      build();
      list.hidden = bar.hidden = false;
      well.classList.add('organising');
      if (back) {
        const total = viewer.pagesCount;
        const kept = back.select.filter((n) => n <= total);
        setSelection(new Set(kept));
        anchor = kept[0] ?? null;
        focusCell(Math.min(Math.max(back.focus, 1), total));
        list.scrollTop = back.top;
      } else {
        focusCell(viewer.currentPageNumber);
        cell(focused).scrollIntoView({ block: 'center' });
      }
      enable();
    }

    // Asks the main process for a change and waits for the pages to be read again, which show() ends. `after` says what to select and
    // focus then. A change that does not happen is explained and leaves the grid as it was.
    async function run(call, after) {
      if (busy || !tab) return;
      const { token, name } = tab.doc;
      busy = true;
      list.classList.add('busy');
      enable();
      pending = { token, top: list.scrollTop, ...after };
      const result = await call(token).catch(() => null);
      if (result?.info) return;
      pending = null;
      busy = false;
      list.classList.remove('busy');
      enable();
      if (result?.stop === 'no-engine') await window.workspaceDialogs.engineCard();
      else if (result?.stop === 'changed') {
        const answer = await window.workspaceDialogs.choose(`${name} was changed by another program.`, '', [{ label: 'Cancel', value: null }, { label: 'Reload', value: 'reload', primary: true }]);
        if (answer) await window.workspaceApi.reload(token);
      }
      if (focused && !list.hidden) focusCell(focused);
    }

    const chosen = () => [...selected].sort((a, b) => a - b);

    function rotate(by) {
      const pages = chosen();
      if (pages.length) run((token) => window.workspaceApi.apply(token, [{ op: 'pages.rotate', pages, by }]), { select: pages, focus: focused });
    }

    async function remove() {
      const pages = chosen();
      if (!pages.length || busy) return;
      const total = viewer.pagesCount;
      if (pages.length === total) {
        await window.workspaceDialogs.choose('A PDF needs at least one page', '', [{ label: 'OK', value: true, primary: true }]);
        focusCell(focused);
        return;
      }
      run((token) => window.workspaceApi.apply(token, [{ op: 'pages.delete', pages }]), { select: [], focus: Math.min(pages[0], total - pages.length) });
    }

    function move(pages, before) {
      const first = before - pages.filter((n) => n < before).length;
      run((token) => window.workspaceApi.apply(token, [{ op: 'pages.move', pages, before }]), { select: pages.map((_, i) => first + i), focus: first });
    }

    function step(way) {
      if (tab?.doc[way === 'undo' ? 'canUndo' : 'canRedo']) run((token) => window.workspaceApi[way](token), { select: [], focus: focused });
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
    const open = () => wanted && !list.hidden;
    bind('undo', () => { if (!open()) return false; step('undo'); });
    bind('redo', () => { if (!open()) return false; step('redo'); });
    bind('deletePages', () => { if (!open() || !selected.size) return false; remove(); });
    escape = () => {
      if (drag) { drag.cancelled = true; drag(); return; }
      if (!open()) return false;
      leave();
    };
    eventBus.on('pagesinit', () => { installed(); if (wanted) show(); });
    eventBus.on('pagesdestroy', teardown);
    api.leave = () => { if (wanted) leave(); };
    api.use = (next) => { tab = next; enable(); };
  }

  bind('escape', () => escape());
  const api = { watch, leave: () => {}, use: () => {} };
  window.workspaceOrganise = api;
})();

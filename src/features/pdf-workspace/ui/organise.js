// SPDX-License-Identifier: AGPL-3.0-or-later
// The Pages tool: a button in the dock that swaps the reading view for a grid of every page, with selection by click, Ctrl, Shift, Ctrl+A, the
// keyboard and a rubber band, and an option bar that adds pages (files through the Add files card or dropped on the grid, or a blank page), turns,
// deletes, extracts and moves the selected pages (by dragging), opens the Split card, and undoes and redoes. Each change is a list of operations for the PDF engine. The grid shows the result at once and keeps its pages while they are read again from the new version,
// so nothing is drawn twice. Without the engine the button shows the engine card first. A classic script that adds window.workspaceOrganise.
(() => {
  const { el, icon } = window.pomeloUi;
  const { label, bind } = window.workspaceKeys;
  const SIZES = [120, 160, 200, 240];
  const EDGE = 28;
  const DRAG = 4;
  const QUEUE = 20;
  const GLIDE = { duration: 260, easing: 'cubic-bezier(.2, .8, .2, 1)' };
  const WIGGLE = [{ transform: 'none' }, { transform: 'translateX(-3px) rotate(-.7deg)' }, { transform: 'translateX(3px) rotate(.7deg)' }, { transform: 'translateX(-2px) rotate(-.4deg)' }, { transform: 'translateX(2px) rotate(.4deg)' }, { transform: 'none' }];

  let escape = () => false;
  const still = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
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
    const hole = el('div', 'cell hole');
    hole.append(el('span', 'sheet', 'Drop here'), el('span', 'num', ' '));
    const action = (name, title, key, run) => {
      const b = el('button', 'sm');
      b.type = 'button';
      b.innerHTML = icon(name);
      b.title = key ? `${title} (${key})` : title;
      b.setAttribute('aria-label', title);
      b.onclick = run;
      return b;
    };
    const labelled = (name, title, run) => {
      const b = el('button', 'opt');
      b.type = 'button';
      b.innerHTML = icon(name);
      b.append(title);
      b.title = title;
      b.onclick = run;
      return b;
    };
    const addButton = labelled('plus', 'Add', (e) => toggleMenu(e.detail === 0));
    addButton.insertAdjacentHTML('beforeend', icon('down'));
    addButton.setAttribute('aria-haspopup', 'menu');
    addButton.setAttribute('aria-expanded', 'false');
    const menu = el('div', 'menu');
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    for (const [title, run] of [['Files…', (keyboard) => addFiles([], keyboard)], ['Blank page', () => blank()]]) {
      const item = el('button', 'mi', title);
      item.type = 'button';
      item.setAttribute('role', 'menuitem');
      item.onclick = (e) => { closeMenu(); run(e.detail === 0); };
      menu.append(item);
    }
    menu.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const items = [...menu.querySelectorAll('.mi')];
      items[(items.indexOf(document.activeElement) + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
      e.preventDefault();
    });
    const addGroup = el('div', 'addgroup');
    addGroup.append(addButton, menu);
    const splitButton = labelled('split', 'Split…', () => away(() => window.workspaceSplit.open(tab.doc.token, viewer)));
    // The selection's actions are there only while pages are selected, beside a chip that names the selection and clears it.
    const hint = el('span', 'hint', 'Select pages to turn, delete or extract');
    const count = el('span', 'count');
    const chip = el('button', 'selchip');
    chip.type = 'button';
    chip.title = 'Clear the selection';
    chip.innerHTML = icon('close');
    chip.prepend(count);
    chip.onclick = () => { setSelection(new Set()); anchor = null; if (focused) focusCell(focused); };
    const turnLeft = action('rotl', 'Rotate left', '', () => rotate(270));
    const turnRight = action('rotr', 'Rotate right', '', () => rotate(90));
    const extractButton = action('extract', 'Extract', '', () => extract());
    const trash = action('trash', 'Delete', label('deletePages'), () => remove());
    const forSelection = el('span', 'selgroup');
    forSelection.append(chip, turnLeft, turnRight, extractButton, trash);
    const picked = el('span', 'picked');
    picked.setAttribute('role', 'status');
    picked.append(hint, forSelection);
    const undo = action('undo', 'Undo', label('undo'), () => step('undo'));
    const redo = action('redo', 'Redo', label('redo'), () => step('redo'));
    bar.append(addGroup, splitButton, el('span', 'sep'), picked, el('span', 'sep'), undo, redo);
    bar.addEventListener('mousedown', (e) => e.preventDefault());
    const button = el('button', 'tool');
    button.type = 'button';
    button.innerHTML = `${icon('pages')}<span class="lbl">Pages</span><i class="engdot" hidden></i>`;
    button.title = `Pages (${label('pages')})`;
    button.setAttribute('aria-label', 'Pages');
    button.setAttribute('aria-pressed', 'false');
    well.append(list, bar);
    document.querySelector('.dock .tools').append(button);
    button.addEventListener('mousedown', (e) => e.preventDefault());
    window.workspaceViewer.restScrollbar(list);

    let wanted = false;
    let size = 160;
    let thumbs = null;
    let selected = new Set();
    let anchor = null;
    let focused = null;
    let tab = null;
    let busy = false;
    let adding = false;
    let pending = null;
    let drag = null;
    let dropped = false;
    let nodes = [];
    const queued = [];
    const visible = new Set();
    const cell = (n) => nodes[n - 1];
    const pageOf = (target) => { const c = target.closest('.cell'); return c ? Number(c.dataset.n) : null; };

    // The pictures follow their pages while a change is being made, so a page that is not on show keeps its picture until the new
    // version has been read and the cells are painted again from it.
    const seen = new IntersectionObserver((changes) => {
      for (const { target, isIntersecting } of changes) {
        if (isIntersecting) visible.add(target);
        else visible.delete(target);
        if (!thumbs || pending) continue;
        if (isIntersecting) paint(target);
        else if (!target.classList.contains('lifted')) {
          thumbs.drop(Number(target.dataset.n));
          target.firstChild.replaceChildren();
        }
      }
    }, { root: list, rootMargin: '400px 0px' });

    function paint(c) {
      thumbs.want(Number(c.dataset.n), (image) => {
        if (!c.isConnected) return;
        const draw = () => {
          c.style.setProperty('--r', String(image.ratio));
          c.firstChild.replaceChildren(window.workspaceThumbs.picture(image));
          c.spin?.cancel();
          c.spin = null;
        };
        if (Math.abs(image.ratio - Number(c.style.getPropertyValue('--r'))) > 0.001) flip(draw);
        else draw();
      });
    }

    // Cells far out of view are not animated, so a file of thousands of pages does not start thousands of animations.
    function flip(change, { shake = false } = {}) {
      const first = new Map();
      if (!still()) for (const c of cells.children) if (c.offsetParent) first.set(c, [c.offsetLeft, c.offsetTop]);
      change();
      const [low, high] = [list.scrollTop - 300, list.scrollTop + list.clientHeight + 300];
      for (const [c, [x, y]] of first) {
        const [dx, dy] = [x - c.offsetLeft, y - c.offsetTop];
        if (!c.offsetParent || (!dx && !dy) || (y < low && c.offsetTop < low) || (y > high && c.offsetTop > high)) continue;
        c.animate([{ translate: `${dx}px ${dy}px` }, { translate: '0 0' }], GLIDE);
        if (shake && c.firstChild) c.firstChild.animate(WIGGLE, { duration: 380, easing: 'ease-in-out' });
      }
    }

    function setSelection(next) {
      for (const n of selected) if (!next.has(n)) { cell(n).classList.remove('sel'); cell(n).setAttribute('aria-selected', 'false'); }
      for (const n of next) if (!selected.has(n)) { cell(n).classList.add('sel'); cell(n).setAttribute('aria-selected', 'true'); }
      selected = next;
      enable();
    }

    function enable() {
      count.replaceChildren(String(selected.size), el('span', 'word', selected.size === 1 ? ' page' : ' pages'));
      chip.setAttribute('aria-label', `Clear the selection of ${count.textContent}`);
      picked.classList.toggle('some', selected.size > 0);
      list.classList.toggle('busy', busy);
      addButton.classList.toggle('adding', adding);
      list.setAttribute('aria-busy', String(busy));
      undo.disabled = !tab?.doc.canUndo;
      redo.disabled = !tab?.doc.canRedo;
    }

    function unfocus() {
      if (focused) cell(focused).tabIndex = -1;
      focused = null;
    }

    function focusCell(n) {
      unfocus();
      focused = n;
      cell(n).tabIndex = 0;
      cell(n).focus();
      window.workspaceDock.showPage(n);
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
      const top = nodes[0].offsetTop;
      let n = 0;
      for (const c of nodes) { if (c.offsetTop !== top) break; n++; }
      return n;
    };

    list.addEventListener('click', (e) => { const n = pageOf(e.target); if (n && !dropped) pick(n, e); });
    list.addEventListener('dblclick', (e) => { const n = pageOf(e.target); if (n) read(n); });
    list.addEventListener('keydown', (e) => {
      if (busy) return;
      if (e.ctrlKey && e.key.toLowerCase() === 'a') { setSelection(new Set(span(1, viewer.pagesCount))); e.preventDefault(); return; }
      if (e.ctrlKey && e.shiftKey && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { nudge(e.key); e.preventDefault(); return; }
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
      const boxes = nodes.map((c, i) => ({ n: i + 1, left: c.offsetLeft, top: c.offsetTop, right: c.offsetLeft + c.offsetWidth, bottom: c.offsetTop + c.offsetHeight }));
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

    // The picture on the copy is a copy of the one the cell holds, so nothing has to be drawn for it.
    function pickUp(pages, pressed, rect) {
      const ghost = el('div', 'ghost');
      Object.assign(ghost.style, { width: `${rect.width}px`, height: `${rect.height}px` });
      const stack = [pressed, ...pages.filter((p) => p !== pressed)].slice(0, 3).reverse();
      stack.forEach((p, i) => {
        const sheet = el('span', 'gsheet');
        const behind = stack.length - 1 - i;
        sheet.style.transform = `translate(${behind * 7}px, ${behind * 7}px) rotate(${behind * 2}deg)`;
        const source = p === pressed ? cell(p).querySelector('canvas') : null;
        if (source) {
          const copy = document.createElement('canvas');
          copy.width = source.width;
          copy.height = source.height;
          copy.getContext('2d').drawImage(source, 0, 0);
          sheet.append(copy);
        }
        ghost.append(sheet);
      });
      if (pages.length > 1) ghost.append(el('span', 'badge', String(pages.length)));
      hole.style.setProperty('--r', cell(pressed).style.getPropertyValue('--r'));
      list.append(ghost);
      return ghost;
    }

    // The hole stands before the first page from `before` on that is staying, which is where pages moved there end up.
    function gap(pages, before, lift = false) {
      const fresh = !hole.isConnected;
      flip(() => {
        if (lift) for (const p of pages) cell(p).classList.add('lifted');
        cells.insertBefore(hole, nodes.slice(before - 1).find((c) => !c.classList.contains('lifted')) ?? null);
      }, { shake: true });
      if (fresh && !still()) hole.animate([{ opacity: 0, scale: '.92' }, { opacity: 1, scale: '1' }], { duration: 200, easing: 'ease-out' });
    }

    function putDown(ghost) {
      if (still()) { ghost.remove(); return; }
      ghost.animate([{ opacity: 1 }, { opacity: 0, scale: '.92' }], { duration: 150, fill: 'forwards' }).onfinish = () => ghost.remove();
    }

    // The hole goes before the page the pointer is over, or after it when the pointer is in its right half. The pages being pulled stay
    // in the grid, hidden and keeping their numbers, until the drop, so a cancelled pull only shows them again.
    list.addEventListener('pointerdown', (e) => {
      const n = pageOf(e.target);
      if (!n || e.button !== 0 || e.ctrlKey || e.shiftKey || busy) return;
      const room = list.getBoundingClientRect();
      const from = { x: e.clientX, y: e.clientY };
      const grab = cell(n).firstChild.getBoundingClientRect();
      let lifted = null;
      let ghost = null;
      let before = null;
      const stop = track(e, room, {
        active: () => !!lifted,
        update(pointer) {
          if (!lifted) {
            if (Math.hypot(pointer.x - from.x, pointer.y - from.y) < DRAG) return;
            if (!selected.has(n)) { setSelection(new Set([n])); anchor = n; }
            lifted = chosen();
            ghost = pickUp(lifted, n, grab);
            before = n;
            list.setPointerCapture(e.pointerId);
            list.classList.add('dragging');
            gap(lifted, before, true);
          }
          const [x, y] = [pointer.x - room.left + list.scrollLeft - (from.x - grab.left), pointer.y - room.top + list.scrollTop - (from.y - grab.top)];
          ghost.style.transform = `translate(${x}px, ${y}px) rotate(2deg)`;
          const over = document.elementFromPoint(pointer.x, pointer.y)?.closest('.cell');
          if (!over || over === hole || over.classList.contains('lifted')) return;
          const box = over.getBoundingClientRect();
          const next = Number(over.dataset.n) + (pointer.x < box.left + box.width / 2 ? 0 : 1);
          if (next !== before) { before = next; gap(lifted, before); }
        },
        end() {
          drag = null;
          list.classList.remove('dragging');
          if (!lifted) return;
          putDown(ghost);
          dropped = true;
          setTimeout(() => { dropped = false; });
          if (before && !noop(lifted, before) && !stop.cancelled) drop(lifted, before);
          else flip(() => { for (const p of lifted) cell(p)?.classList.remove('lifted'); hole.remove(); }, { shake: true });
        },
      });
      drag = stop;
    });

    const named = (c) => c.setAttribute('aria-label', `Page ${c.dataset.n}${c.classList.contains('added') ? ', added' : ''}`);

    // The pages that were not in the file when it was opened wear a tag, whatever has been done to the cells since.
    function markAdded() {
      const fresh = new Set(tab?.doc.added);
      nodes.forEach((c, i) => {
        c.classList.toggle('added', fresh.has(i + 1));
        named(c);
      });
    }

    function makeCell(n) {
      const c = el('div', 'cell');
      c.dataset.n = String(n);
      c.tabIndex = -1;
      c.setAttribute('role', 'option');
      c.setAttribute('aria-selected', 'false');
      named(c);
      const { width, height } = viewer.getPageView(n - 1).viewport;
      c.style.setProperty('--r', String(height / width));
      c.append(el('span', 'sheet'), el('span', 'num', String(n)));
      nodes.push(c);
      cells.append(c);
      seen.observe(c);
    }

    function renumber() {
      nodes.forEach((c, i) => {
        const n = String(i + 1);
        if (c.dataset.n === n) return;
        c.dataset.n = n;
        named(c);
        c.lastChild.textContent = n;
      });
    }

    function fill() {
      seen.disconnect();
      visible.clear();
      cells.replaceChildren();
      nodes = [];
      for (let n = 1; n <= viewer.pagesCount; n++) makeCell(n);
      markAdded();
    }

    function build() {
      thumbs = window.workspaceThumbs.create(viewer.pdfDocument, size);
      fill();
    }

    function teardown() {
      seen.disconnect();
      visible.clear();
      thumbs?.release();
      thumbs = null;
      cells.replaceChildren();
      nodes = [];
      selected = new Set();
      anchor = focused = null;
      pending = null;
      busy = false;
      queued.length = 0;
      list.hidden = band.hidden = bar.hidden = true;
      closeMenu();
      well.classList.remove('organising');
    }

    // The new version has been read: the cells the grid already has are kept and drawn again from it, each picture staying until its
    // replacement is ready.
    function reconcile() {
      thumbs = window.workspaceThumbs.create(viewer.pdfDocument, size);
      const total = viewer.pagesCount;
      while (nodes.length > total) { const c = nodes.pop(); seen.unobserve(c); visible.delete(c); c.remove(); }
      while (nodes.length < total) makeCell(nodes.length + 1);
      renumber();
      markAdded();
      nodes.forEach((c, i) => {
        if (visible.has(c)) { paint(c); return; }
        c.firstChild.replaceChildren();
        c.spin?.cancel();
        c.spin = null;
        const { width, height } = viewer.getPageView(i).viewport;
        c.style.setProperty('--r', String(height / width));
      });
    }

    function retain({ select, focus }) {
      const total = nodes.length;
      const kept = select.filter((n) => n <= total);
      setSelection(new Set(kept));
      anchor = kept[0] ?? null;
      focusCell(Math.min(Math.max(focus, 1), total));
    }

    function show() {
      const back = pending?.token === tab?.doc.token ? pending : null;
      const kept = !!back && nodes.length > 0;
      pending = null;
      busy = false;
      if (kept) reconcile();
      else build();
      list.hidden = bar.hidden = false;
      well.classList.add('organising');
      if (back) {
        if (back.grow) {
          const added = viewer.pagesCount - back.was;
          back.select = added > 0 ? span(back.grow, back.grow + added - 1) : [];
        }
        retain(back);
        if (!kept) list.scrollTop = back.top;
      } else {
        focusCell(viewer.currentPageNumber);
        cell(focused).scrollIntoView({ block: 'center' });
      }
      enable();
      while (queued.length && !busy) step(queued.shift());
    }

    function rebuild({ select, focus }) {
      const top = list.scrollTop;
      selected = new Set();
      anchor = focused = null;
      fill();
      retain({ select, focus });
      list.scrollTop = top;
    }

    // Asks the main process for a change. `apply` shows the result in the grid at once; the pages are read again from the new version
    // in the background, which show() ends. A change that does not happen is explained and leaves the grid as it was. `after` says what
    // to select and focus.
    async function run(call, after, apply) {
      if (busy || !tab) return;
      const { token, name } = tab.doc;
      const before = { select: chosen(), focus: focused ?? 1 };
      busy = true;
      enable();
      pending = { token, top: list.scrollTop, ...after };
      if (apply) {
        setSelection(new Set());
        unfocus();
        apply();
        retain(after);
      }
      const result = await call(token).catch(() => null);
      if (result?.info) return;
      pending = null;
      busy = false;
      queued.length = 0;
      if (apply) rebuild(before);
      enable();
      if (result?.stop === 'no-engine') await window.workspaceDialogs.engineCard();
      else if (result?.stop === 'changed') {
        const answer = await window.workspaceDialogs.choose(`${name} was changed by another program.`, '', [{ label: 'Cancel', value: null }, { label: 'Reload', value: 'reload', primary: true }]);
        if (answer) await window.workspaceApi.reload(token);
      }
      if (focused && !list.hidden) focusCell(focused);
    }

    const chosen = () => [...selected].sort((a, b) => a - b);

    // Each page turns on the spot, shrunk so that it still fits its cell, until the picture of it turned is drawn.
    function spin(pages, by) {
      if (still()) return;
      for (const p of pages) {
        const c = cell(p);
        if (!visible.has(c)) continue;
        const sheet = c.firstChild;
        const fit = by === 180 ? 1 : Math.min(sheet.offsetWidth / sheet.offsetHeight, sheet.offsetHeight / sheet.offsetWidth);
        c.spin?.cancel();
        c.spin = sheet.animate([{ transform: 'none' }, { transform: `rotate(${by === 270 ? -90 : by}deg) scale(${fit})` }], { ...GLIDE, fill: 'forwards' });
      }
    }

    function rotate(by) {
      const pages = chosen();
      if (pages.length) run((token) => window.workspaceApi.apply(token, [{ op: 'pages.rotate', pages, by }]), { select: pages, focus: focused ?? pages[0] }, () => spin(pages, by));
    }

    function vanish(pages) {
      const gone = new Set(pages);
      flip(() => {
        for (const p of pages) {
          const c = cell(p);
          seen.unobserve(c);
          if (!visible.delete(c) || still()) { c.remove(); continue; }
          const { offsetLeft: left, offsetTop: top, offsetWidth: width, offsetHeight: height } = c;
          c.classList.add('leaving');
          Object.assign(c.style, { position: 'absolute', left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
          c.animate([{ opacity: 1, scale: '1' }, { opacity: 0, scale: '.85' }], { duration: 200, fill: 'forwards' }).onfinish = () => c.remove();
        }
        nodes = nodes.filter((_, i) => !gone.has(i + 1));
        renumber();
      });
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
      run((token) => window.workspaceApi.apply(token, [{ op: 'pages.delete', pages }]), { select: [], focus: Math.min(pages[0], total - pages.length) }, () => vanish(pages));
    }

    function drop(pages, before) {
      const first = before - pages.filter((n) => n < before).length;
      const moved = pages.map(cell);
      run((token) => window.workspaceApi.apply(token, [{ op: 'pages.move', pages, before }]), { select: pages.map((_, i) => first + i), focus: first }, () => {
        flip(() => {
          for (const c of moved) { c.classList.remove('lifted'); cells.insertBefore(c, hole); }
          hole.remove();
          nodes = [...cells.children].filter((c) => c.dataset.n && !c.classList.contains('leaving'));
          renumber();
        }, { shake: true });
      });
    }

    function nudge(key) {
      const pages = selected.size ? chosen() : [focused];
      const total = viewer.pagesCount;
      const before = { ArrowLeft: pages[0] - 1, ArrowRight: pages.at(-1) + 2, Home: 1, End: total + 1 }[key];
      if (before < 1 || before > total + 1 || noop(pages, before)) return;
      if (!selected.size) setSelection(new Set(pages));
      gap(pages, before, true);
      drop(pages, before);
    }

    function resize(steps) {
      const next = SIZES[Math.min(Math.max(SIZES.indexOf(size) + Math.sign(steps), 0), SIZES.length - 1)];
      if (next === size) return;
      size = next;
      cells.style.setProperty('--size', `${size}px`);
      if (thumbs) {
        thumbs.setWidth(size);
        for (const c of visible) paint(c);
      }
      if (focused) cell(focused).scrollIntoView({ block: 'nearest' });
      sync();
    }

    const menuOpen = () => !menu.hidden;
    function closeMenu() {
      menu.hidden = true;
      addButton.setAttribute('aria-expanded', 'false');
    }

    // A press on the bar leaves the focus in the grid, where the keyboard put it, and a focus moved by script would take on its ring;
    // only a menu opened from the keyboard shows where the focus went.
    function toggleMenu(keyboard) {
      if (menuOpen()) { closeMenu(); return; }
      menu.hidden = false;
      addButton.setAttribute('aria-expanded', 'true');
      menu.querySelector('.mi').focus({ focusVisible: keyboard });
    }

    document.addEventListener('pointerdown', (e) => { if (menuOpen() && !e.target.closest('.addgroup')) closeMenu(); });

    function blank() {
      const before = selected.size ? Math.max(...selected) + 1 : viewer.pagesCount + 1;
      run((token) => window.workspaceApi.apply(token, [{ op: 'pages.blank', before }]), { select: [before], focus: before });
    }

    // `found` is what the main process made of the files dropped: { id, kind, locked, needs } for each. They are put in front of page
    // `before`; a document that needs LibreOffice first opens the Add files card, which offers to install it.
    async function insertSources(found, before) {
      if (!found?.length || busy || !tab || !open()) return;
      if (found.some((s) => s.needs)) { addFiles(found); return; }
      for (const source of found) if (source.locked && !(await window.workspaceDialogs.askSource(source))) return;
      await run((token) => window.workspaceApi.apply(token, [{ op: 'pages.insert', before, sources: found.map((s) => s.id) }]), { grow: before, was: viewer.pagesCount, select: [], focus: before });
    }

    // The files listed before the document go in front of its first page and the ones after it at its end, in one change, so one Undo
    // takes them all away. The inserts are made from the end so the first does not move the place of the second.
    async function addFiles(found = [], keyboard = false) {
      if (busy || !tab) return;
      const total = viewer.pagesCount;
      await window.workspaceAddFiles.open(tab.doc.name, total, found, keyboard, async ({ before, after }) => {
        if (busy || !tab || !open()) return;
        const ops = [...(after.length ? [{ op: 'pages.insert', before: total + 1, sources: after }] : []), ...(before.length ? [{ op: 'pages.insert', before: 1, sources: before }] : [])];
        if (!ops.length) return;
        const grow = before.length && after.length ? null : before.length ? 1 : total + 1;
        await run((token) => window.workspaceApi.apply(token, ops), grow ? { grow, was: total, select: [], focus: grow } : { select: [], focus: 1 });
      });
      if (focused && !list.hidden) focusCell(focused);
    }

    // Makes new files from the document, which is not changed: `make` resolves what the main process answered.
    async function away(make) {
      if (busy || !tab) return;
      busy = true;
      enable();
      const result = await make().catch(() => null);
      busy = false;
      enable();
      if (result?.stop === 'no-engine') await window.workspaceDialogs.engineCard();
      if (focused && !list.hidden) focusCell(focused);
    }

    function extract() {
      const pages = chosen();
      if (pages.length && tab) away(() => window.workspaceApi.extract(tab.doc.token, pages));
    }

    // Files dropped on the grid go in front of the page the pointer is over, or after it in its right half; elsewhere in the grid, at the end.
    let droppedAt = null;
    list.addEventListener('drop', (e) => {
      if (!e.isTrusted || !e.dataTransfer?.types.includes('Files')) return;
      adding = true;
      enable();
      const n = pageOf(e.target);
      droppedAt = n ? n + (e.clientX < cell(n).getBoundingClientRect().left + cell(n).getBoundingClientRect().width / 2 ? 0 : 1) : viewer.pagesCount + 1;
    });
    window.workspaceApi.onFilesDropped((found, into) => {
      if (into !== 'grid') return;
      const before = droppedAt ?? viewer.pagesCount + 1;
      droppedAt = null;
      insertSources(found, before).finally(() => { adding = false; enable(); });
    });

    // A press while the last change is still being read back waits its turn, so a run of presses on Undo goes back one step for
    // each, and the buttons stay as they are meanwhile.
    function step(way) {
      if (busy) { if (queued.length < QUEUE) queued.push(way); return; }
      if (tab?.doc[way === 'undo' ? 'canUndo' : 'canRedo']) run((token) => window.workspaceApi[way](token), { select: [], focus: focused ?? 1 });
    }

    function sync() {
      button.classList.toggle('on', wanted);
      button.setAttribute('aria-pressed', String(wanted));
      document.body.classList.toggle('tooling', wanted);
      window.workspaceDock.grid(wanted ? `${Math.round(size / 1.6)}%` : null);
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
      if (menuOpen()) { closeMenu(); addButton.focus(); return; }
      if (!open()) return false;
      leave();
    };
    eventBus.on('pagesinit', () => { installed(); if (wanted) show(); });
    eventBus.on('pagesdestroy', () => { if (pending) { thumbs?.release(); thumbs = null; } else teardown(); });
    api.leave = () => { if (wanted) leave(); };
    api.use = (next) => { tab = next; markAdded(); enable(); };
    api.waiting = () => !!pending;
    // While the grid is up the dock's zoom buttons size the pages and its page buttons move through them.
    api.zoom = (steps) => { if (!open()) return false; resize(steps); return true; };
    api.go = (n) => {
      if (!open()) return false;
      if (!busy) pick(Math.min(Math.max(n, 1), nodes.length), {});
      return true;
    };
    api.step = (by) => api.go((focused ?? 1) + by);
  }

  bind('escape', () => escape());
  const api = { watch, leave: () => {}, use: () => {}, waiting: () => false, zoom: () => false, go: () => false, step: () => false };
  window.workspaceOrganise = api;
})();

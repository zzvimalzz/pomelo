// SPDX-License-Identifier: AGPL-3.0-or-later
// The Add files card: PDFs, pictures and documents to put in the document, listed in the order they will have round it. A classic
// script that adds window.workspaceAddFiles.
(() => {
  const { el, icon } = window.pomeloUi;
  const { svg } = window.pomeloWheelShapes;
  const MAX_ADDED = 50;
  const EASE = 'cubic-bezier(.22, 1, .36, 1)';
  const pagesIn = (n) => `${n} ${n === 1 ? 'page' : 'pages'}`;
  const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  // `name` and `pages` describe the open document; `found` are files already given, as the main process answers for them. `keyboard`
  // says the card was opened from the keyboard, so the focus shows. `add({ before, after })` is given the ids of the files that go before
  // the document's first page and after its last, and the card waits for it. Resolves when the card is closed.
  function open(name, pages, found, keyboard, add) {
    const { box, close } = window.pomeloCard.frame(document.querySelector('.well'));
    const defs = svg('svg', { class: 'defs', width: 0, height: 0, 'aria-hidden': 'true' });
    window.pomeloIcons.addDefs(svg, defs);
    const badge = el('i', 'badge');
    badge.innerHTML = icon('plus');
    const title = el('h3', '', 'Add files');
    title.id = 'dialog-title';
    const head = el('div', 'uhead');
    head.append(badge, title);
    const list = el('ul', 'files');
    const choose = el('button', 'addfiles', 'Drop PDFs, pictures or documents, or choose files');
    choose.type = 'button';
    const note = el('p', 'cnote');
    note.setAttribute('role', 'status');
    const cancel = el('button', 'btn', 'Cancel');
    const go = el('button', 'btn primary', 'Add to document');
    const row = el('div', 'row');
    row.append(cancel, go);
    const over = el('div', 'dropover', 'Drop here');
    box.dataset.drops = '';
    box.append(defs, head, list, choose, note, row, over);

    let files = [{ name, ext: 'pdf', group: 'pdf', pages, current: true }];
    let dropped = 0;
    let installing = false;
    let reading = 0;
    let working = false;
    const more = () => list.classList.toggle('more', list.scrollTop + list.clientHeight < list.scrollHeight - 1);
    list.addEventListener('scroll', more);

    function meta(file) {
      if (file.needs) return installing ? 'Installing LibreOffice…' : 'Needs LibreOffice';
      if (file.kind === 'document') return 'Made into PDF pages';
      return file.pages ? pagesIn(file.pages) : '';
    }

    function picture(file) {
      const art = svg('svg', { class: 'cicon', viewBox: '0 0 52 62', 'aria-hidden': 'true' });
      window.pomeloIcons.draw(svg, svg('g', { class: 'picon' }, art), { ext: file.ext, group: file.group, count: 1 }, 26, 52);
      return art;
    }

    function draw(focus) {
      list.replaceChildren(...files.map((file, i) => {
        const item = el('li', file.current ? 'cfile me' : 'cfile');
        item.dataset.i = String(i);
        if (file.current) item.setAttribute('aria-current', 'true');
        const grip = el('button', 'grip');
        grip.type = 'button';
        grip.title = 'Drag to move';
        grip.setAttribute('aria-label', `Move ${file.name} (Alt+Up, Alt+Down)`);
        grip.onpointerdown = (e) => lift(e, item);
        // A long name loses its middle, so the end that tells files apart (a date, "final", the extension) stays in view.
        const label = el('span', 'cname');
        const cut = Math.max(file.name.length - 14, 0);
        label.append(el('span', 'head', file.name.slice(0, cut)), el('span', 'tail', file.name.slice(cut)));
        label.title = file.name;
        label.dir = 'auto';
        const words = el('span', 'cwords');
        words.append(label, el('span', 'cmeta', meta(file)));
        item.append(grip, picture(file), words);
        if (file.current) item.append(el('span', 'ctag', 'This document'));
        if (file.needs && !installing) {
          const get = el('button', 'cinstall', 'Install');
          get.type = 'button';
          get.onclick = install;
          item.append(get);
        }
        if (!file.current) {
          const remove = el('button', 'cremove');
          remove.type = 'button';
          remove.title = 'Remove';
          remove.setAttribute('aria-label', `Remove: ${file.name}`);
          remove.innerHTML = icon('close');
          remove.onclick = () => { files.splice(i, 1); draw({ at: Math.min(i, files.length - 1) }); };
          item.append(remove);
        }
        return item;
      }), ...Array.from({ length: reading }, () => {
        const item = el('li', 'cfile loading');
        const words = el('span', 'cwords');
        words.append(el('span', 'sk'), el('span', 'sk'));
        item.append(el('span', 'sk art'), words);
        return item;
      }));
      list.setAttribute('aria-busy', String(reading > 0 || working));
      list.inert = working;
      if (focus) {
        const target = list.children[focus.at];
        (target.querySelector(focus.grip ? '.grip' : '.cremove') ?? target.querySelector('.grip')).focus();
      }
      go.disabled = files.length < 2 || installing || reading > 0 || files.some((f) => f.needs);
      choose.disabled = installing || reading > 0 || working || files.length > MAX_ADDED;
      cancel.disabled = working;
      more();
    }

    // Until the main process has read the files, a row stands in for each.
    const expect = (n) => { reading = Math.min(n, MAX_ADDED + 1 - files.length); draw(); };

    // `given` is how many files were dropped or chosen; any that cannot be added are left out and the card says so.
    async function take(found, given = found.length) {
      reading = 0;
      note.classList.remove('bad');
      note.textContent = found.length < given ? 'Only PDFs, pictures and documents can be added' : '';
      for (const source of found.slice(0, MAX_ADDED + 1 - files.length)) {
        if (!source.locked || (await window.workspaceDialogs.askSource(source))) files.push(source);
      }
      draw();
    }

    async function install() {
      installing = true;
      note.classList.remove('bad');
      draw();
      const stop = window.workspaceApi.onInstallNote(({ key, fraction }) => {
        if (key !== 'soffice') return;
        for (const m of list.querySelectorAll('.cfile:not(.me) .cmeta')) if (m.textContent.startsWith('Installing')) m.textContent = `Installing LibreOffice… ${typeof fraction === 'number' ? `${Math.round(fraction * 100)}%` : ''}`.trim();
      });
      const result = await window.workspaceApi.installEngine('soffice').catch(() => ({ ok: false, message: '' }));
      stop();
      installing = false;
      if (result.ok) for (const f of files) f.needs = null;
      else { note.textContent = result.message || "Can't install LibreOffice"; note.classList.add('bad'); }
      draw();
    }

    function shift(i, by) {
      const to = i + by;
      if (to < 0 || to >= files.length) return;
      [files[i], files[to]] = [files[to], files[i]];
      draw({ at: to, grip: true });
    }

    // The row follows the pointer and the others make way, gliding to their new places, so the order is seen to change.
    function lift(e, item) {
      if (e.button !== 0 || installing || working) return;
      e.preventDefault();
      item.querySelector('.grip').focus();
      const order = files.slice();
      const moving = order[Number(item.dataset.i)];
      let from = e.clientY;
      let offset = 0;
      item.classList.add('lift');
      const move = (m) => {
        const box = list.getBoundingClientRect();
        const scrolled = list.scrollTop;
        if (m.clientY < box.top + 24) list.scrollTop -= 8;
        else if (m.clientY > box.bottom - 24) list.scrollTop += 8;
        from -= list.scrollTop - scrolled;
        const others = [...list.children].filter((r) => r !== item);
        const next = others.find((r) => { const b = r.getBoundingClientRect(); return m.clientY < b.top + b.height / 2; }) ?? null;
        if (next !== item.nextElementSibling) {
          const tops = new Map(others.map((r) => [r, r.getBoundingClientRect().top]));
          const slot = item.getBoundingClientRect().top - offset;
          list.insertBefore(item, next);
          if (!still()) for (const r of others) { const by = tops.get(r) - r.getBoundingClientRect().top; if (by) r.animate([{ translate: `0 ${by}px` }, { translate: '0 0' }], { duration: 240, easing: EASE }); }
          from += item.getBoundingClientRect().top - offset - slot;
        }
        offset = m.clientY - from;
        item.style.translate = `0 ${offset}px`;
      };
      const end = (cancelled) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        window.removeEventListener('keydown', esc, true);
        item.classList.remove('lift');
        files = cancelled ? order : [...list.children].map((r) => files[Number(r.dataset.i)]);
        const at = files.indexOf(moving);
        draw({ at, grip: true });
        if (offset && !cancelled && !still()) list.children[at].animate([{ translate: `0 ${offset}px` }, { translate: '0 0' }], { duration: 200, easing: EASE });
      };
      const up = () => end(false);
      const esc = (k) => { if (k.key === 'Escape') { k.preventDefault(); k.stopPropagation(); end(true); } };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
      window.addEventListener('keydown', esc, true);
    }

    // Files dragged from Explorer turn the whole card into the place to drop them; entering and leaving its children is counted, so
    // the card only goes back when the pointer leaves it or the drag ends. A drag cancelled with Esc sends no dragleave, so the card
    // also goes back once dragover, which comes several times a second while files are over it, stops.
    let inside = 0;
    let quiet = 0;
    const showOver = (on) => { box.classList.toggle('dropping', on); if (!on) inside = 0; };
    const carries = (e) => e.dataTransfer?.types.includes('Files');
    box.addEventListener('dragenter', (e) => { if (carries(e) && !installing && !working) { inside += 1; showOver(true); } });
    box.addEventListener('dragover', () => { clearTimeout(quiet); quiet = setTimeout(() => showOver(false), 1000); });
    box.addEventListener('dragleave', (e) => { if (carries(e) && --inside <= 0) showOver(false); });
    box.addEventListener('drop', (e) => {
      showOver(false);
      dropped = e.dataTransfer?.files.length ?? 0;
      if (e.isTrusted && carries(e) && dropped && !installing && !working) expect(dropped);
    });
    const away = () => showOver(false);
    window.addEventListener('drop', away);
    window.addEventListener('dragend', away);

    return new Promise((resolve) => {
      const done = () => {
        stopListening();
        window.removeEventListener('drop', away);
        window.removeEventListener('dragend', away);
        close();
        document.getElementById('scroller').focus();
        resolve();
      };
      choose.onclick = async () => {
        await take(await window.workspaceApi.chooseSources(expect).catch(() => []));
        choose.focus();
      };
      const stopListening = window.workspaceApi.onFilesDropped((found, into) => { if (into === 'card' && !installing && !working) take(found, Math.max(dropped, found.length)); });
      go.onclick = async () => {
        if (go.disabled || working) return;
        const at = files.findIndex((f) => f.current);
        working = true;
        go.focus();
        draw();
        go.setAttribute('aria-busy', 'true');
        go.replaceChildren(el('span', 'spin'), 'Add to document');
        await add({ before: files.slice(0, at).map((f) => f.id), after: files.slice(at + 1).map((f) => f.id) }).catch(() => {});
        done();
      };
      cancel.onclick = () => done();
      box.addEventListener('keydown', (e) => {
        const item = e.target.closest?.('.cfile');
        if (e.altKey && item && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); shift(Number(item.dataset.i), e.key === 'ArrowUp' ? -1 : 1); }
        else if (e.key === 'Escape') { e.preventDefault(); if (!working) done(); }
        else if (e.key === 'Tab' && !working) window.pomeloCard.loop(e, [...box.querySelectorAll('button')]);
      });
      draw();
      choose.focus({ focusVisible: keyboard });
      if (found.length) take(found);
    });
  }

  window.workspaceAddFiles = { open };
})();

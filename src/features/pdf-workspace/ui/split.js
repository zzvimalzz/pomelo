// SPDX-License-Identifier: AGPL-3.0-or-later
// The Split card: ranges, every N pages or at the top-level bookmarks. The files are saved next to the document. A classic script that
// adds window.workspaceSplit.
(() => {
  const { el, icon } = window.pomeloUi;
  const MODES = [['ranges', 'By ranges'], ['every', 'Every N pages'], ['bookmarks', 'At bookmarks']];
  const HINTS = { ranges: '1-3, 4-9, 10-', every: 'Pages in each file' };

  // The pages the top-level bookmarks go to after the first page; a bookmark with no page of its own is left out.
  async function bookmarkStarts(pdf) {
    const outline = await pdf.getOutline().catch(() => null);
    const found = await Promise.all((outline ?? []).map(async ({ dest }) => {
      try {
        const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
        const ref = explicit[0];
        return Number.isInteger(ref) ? ref + 1 : (await pdf.getPageIndex(ref)) + 1;
      } catch {
        return 0;
      }
    }));
    return [...new Set(found.filter((page) => page > 1))];
  }

  // Resolves with the answer of the main process when the card is closed after a try, or null.
  function open(token, viewer) {
    const { box, close } = window.pomeloCard.frame(document.querySelector('.well'));
    const badge = el('i', 'badge');
    badge.innerHTML = icon('split');
    const title = el('h3', '', 'Split');
    title.id = 'dialog-title';
    const head = el('div', 'uhead');
    head.append(badge, title);
    const note = el('p', 'note', 'The files are saved in the same folder');
    const modes = el('div', 'seg3');
    modes.setAttribute('role', 'radiogroup');
    modes.setAttribute('aria-label', 'Split by');
    const buttons = MODES.map(([mode, words]) => {
      const b = el('button', '', words);
      b.type = 'button';
      b.dataset.mode = mode;
      b.setAttribute('role', 'radio');
      return b;
    });
    modes.append(...buttons);
    const field = el('input', 'fld');
    field.autocomplete = 'off';
    const message = el('p');
    message.setAttribute('role', 'alert');
    const inner = el('div');
    inner.append(message);
    const room = el('div', 'emsg');
    room.append(inner);
    const cancel = el('button', 'btn', 'Cancel');
    const go = el('button', 'btn primary', 'Split');
    const row = el('div', 'row');
    row.append(cancel, go);
    box.append(head, note, modes, field, room, row);

    let mode = 'ranges';
    let starts = null;
    let working = false;

    function sync() {
      room.classList.remove('on');
      field.removeAttribute('aria-invalid');
      field.hidden = mode === 'bookmarks';
      field.placeholder = HINTS[mode] ?? '';
      field.setAttribute('aria-label', mode === 'ranges' ? 'Pages for each file' : 'Pages in each file');
      for (const b of buttons) {
        b.setAttribute('aria-checked', String(b.dataset.mode === mode));
        b.tabIndex = b.dataset.mode === mode ? 0 : -1;
      }
      go.disabled = mode === 'bookmarks' ? !starts?.length : !field.value.trim();
    }

    function says() {
      note.textContent = starts.length ? `${starts.length + 1} files, one for each top-level bookmark.` : 'No bookmarks to split at.';
      sync();
    }

    function choose(next) {
      mode = next;
      note.textContent = 'The files are saved in the same folder';
      sync();
      if (mode !== 'bookmarks') { field.focus(); return; }
      if (starts) { says(); return; }
      note.textContent = 'Reading bookmarks…';
      bookmarkStarts(viewer.pdfDocument).then((found) => { starts = found; if (mode === 'bookmarks') says(); });
    }

    const request = () => (mode === 'ranges' ? { mode, text: field.value } : mode === 'every' ? { mode, n: /^\s*\d+\s*$/.test(field.value) ? Number(field.value) : 0 } : { mode, starts });

    return new Promise((resolve) => {
      const done = (answer) => {
        close();
        document.getElementById('scroller').focus();
        resolve(answer);
      };
      for (const b of buttons) b.onclick = () => choose(b.dataset.mode);
      modes.addEventListener('keydown', (e) => {
        const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
        if (!step) return;
        const next = buttons[(buttons.findIndex((b) => b.dataset.mode === mode) + step + buttons.length) % buttons.length];
        choose(next.dataset.mode);
        next.focus();
        e.preventDefault();
      });
      field.oninput = sync;
      go.onclick = async () => {
        if (go.disabled || working) return;
        working = true;
        for (const b of [...buttons, cancel, go]) b.disabled = true;
        field.disabled = true;
        go.replaceChildren(el('span', 'spin'));
        const result = await window.workspaceApi.split(token, request(), viewer.pagesCount).catch(() => null);
        working = false;
        if (result?.stop !== 'invalid') { done(result); return; }
        for (const b of [...buttons, cancel]) b.disabled = false;
        field.disabled = false;
        go.replaceChildren(document.createTextNode('Split'));
        sync();
        message.textContent = result.message;
        room.classList.add('on');
        field.setAttribute('aria-invalid', 'true');
        field.focus();
        field.select();
      };
      cancel.onclick = () => done(null);
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); if (!working) done(null); }
        else if (e.key === 'Enter' && e.target === field) { e.preventDefault(); go.click(); }
        else if (e.key === 'Tab') window.pomeloCard.loop(e, [buttons.find((b) => b.tabIndex === 0), field, cancel, go].filter((s) => s && !s.hidden));
      });
      sync();
      field.focus();
    });
  }

  window.workspaceSplit = { open };
})();

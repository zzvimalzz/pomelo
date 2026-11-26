// SPDX-License-Identifier: AGPL-3.0-or-later
// The Split card: ranges, every N pages or at the top-level bookmarks. The files are saved next to the document. A classic script that
// adds window.workspaceSplit.
(() => {
  const { el, icon } = window.pomeloUi;
  const MODES = [['ranges', 'By ranges'], ['every', 'Every N pages'], ['bookmarks', 'At bookmarks']];
  const HINTS = { ranges: '1-3, 4-9, 10-', every: 'Pages in each file' };
  const NOTES = { ranges: 'One file for each range, separated by commas', every: 'The last file takes the pages left over' };
  const LABEL_ROOM = 30;
  const EASE = 'cubic-bezier(.22, 1, .36, 1)';
  const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

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
    // The line under the field says what to type, says what went wrong in its place, and in At bookmarks says what was found. It keeps
    // the card one height whatever the mode, so its buttons do not move under the pointer.
    const message = el('p', 'cnote');
    message.id = 'split-note';
    message.setAttribute('aria-live', 'polite');
    field.setAttribute('aria-describedby', message.id);
    // One row standing for the document's pages, left to right, with a box for each file over the pages it takes: true to scale, so a
    // short file in a long document is a sliver in its place, and pages no file takes are left empty.
    const strip = el('div', 'sstrip');
    strip.setAttribute('role', 'img');
    const slot = el('div', 'sslot');
    slot.append(field, strip, message);
    const cancel = el('button', 'btn', 'Cancel');
    const go = el('button', 'btn primary', 'Split');
    const row = el('div', 'row');
    row.append(cancel, go);
    box.append(head, note, modes, slot, row);

    let mode = 'ranges';
    let starts = null;
    let working = false;
    let asked = 0;
    const parts = [];

    async function preview() {
      const total = viewer.pagesCount;
      const ask = ++asked;
      const empty = mode === 'bookmarks' ? !starts?.length : !field.value.trim();
      const plan = empty ? {} : await window.workspaceApi.splitPlan(request(), total).catch(() => ({}));
      if (ask !== asked) return;
      const spans = plan.spans ?? [];
      // Typing passes through text that makes no sense (`1-3,` on the way to `1-3, 4-9`), so the boxes wait a moment before they go.
      if (!spans.length && !empty && parts.length) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        if (ask !== asked) return;
      }
      const wide = strip.clientWidth;
      while (parts.length > spans.length) {
        const part = parts.pop();
        if (still()) part.remove();
        else part.animate([{ opacity: 1 }, { opacity: 0, transform: 'scaleY(.6)' }], { duration: 160, easing: 'ease-in', fill: 'forwards' }).onfinish = () => part.remove();
      }
      spans.forEach(([from, to], i) => {
        let part = parts[i];
        if (!part) {
          part = strip.appendChild(el('span', `spart c${i % 6}`));
          parts.push(part);
          if (!still()) part.animate([{ opacity: 0, transform: 'scaleY(.6)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: EASE });
        }
        part.textContent = (to - from + 1) / total * wide >= LABEL_ROOM ? (from === to ? String(from) : `${from}-${to}`) : '';
        part.style.left = `${(from - 1) / total * 100}%`;
        part.style.width = `${(to - from + 1) / total * 100}%`;
      });
      strip.setAttribute('aria-label', spans.map(([from, to]) => (from === to ? String(from) : `${from}-${to}`)).join(', '));
    }

    function sync() {
      message.classList.remove('bad');
      message.textContent = NOTES[mode] ?? (!starts ? 'Reading bookmarks…' : starts.length ? `${starts.length + 1} files, one for each top-level bookmark.` : 'No bookmarks to split at.');
      field.removeAttribute('aria-invalid');
      field.hidden = mode === 'bookmarks';
      field.placeholder = HINTS[mode] ?? '';
      field.setAttribute('aria-label', mode === 'ranges' ? 'Pages for each file' : 'Pages in each file');
      for (const b of buttons) {
        b.setAttribute('aria-checked', String(b.dataset.mode === mode));
        b.tabIndex = b.dataset.mode === mode ? 0 : -1;
      }
      go.disabled = mode === 'bookmarks' ? !starts?.length : !field.value.trim();
      preview();
    }

    function choose(next) {
      mode = next;
      sync();
      if (mode !== 'bookmarks') { field.focus(); return; }
      buttons.find((b) => b.dataset.mode === mode).focus();
      if (!starts) bookmarkStarts(viewer.pdfDocument).then((found) => { starts = found; if (mode === 'bookmarks') sync(); });
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
        go.setAttribute('aria-busy', 'true');
        go.replaceChildren(el('span', 'spin'), 'Split');
        const result = await window.workspaceApi.split(token, request(), viewer.pagesCount).catch(() => null);
        working = false;
        if (result?.stop !== 'invalid') { done(result); return; }
        for (const b of [...buttons, cancel]) b.disabled = false;
        field.disabled = false;
        go.setAttribute('aria-busy', 'false');
        go.replaceChildren('Split');
        sync();
        message.textContent = result.message;
        message.classList.add('bad');
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

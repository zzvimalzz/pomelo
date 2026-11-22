// SPDX-License-Identifier: AGPL-3.0-or-later
// The Links panel on the right: every web and mail address in the document, one row each, found by reading the pages in turn the first time
// the panel is opened. A row is selected with its circle, goes to the link with a click and opens it with its arrow; the header copies all the
// addresses or only the selected ones, one to a line. A classic script that adds window.workspaceLinkList.
(() => {
  const { el, icon } = window.pomeloUi;
  const SLIDE = 350;
  const WEB = /^(?:https?:|mailto:)/i;
  const TEXT_URL = /https?:\/\/[^\s<>"]+/gi;
  const TRAILING = /[.,;:!?)\]}'"]+$/;
  const SHOWN = 1400;
  const FINISHED = 3;

  function parts(url) {
    try {
      const u = new URL(url);
      if (u.protocol === 'mailto:') return [decodeURIComponent(u.pathname), '', 'Email'];
      return [u.host, `${u.pathname === '/' ? '' : u.pathname}${u.search}${u.hash}`, 'Web'];
    } catch {
      return [url, '', 'Web'];
    }
  }

  // The links of one page, top to bottom: those the file marks, then web addresses written in the text that no link covers.
  async function readPage(pdf, n) {
    const page = await pdf.getPage(n);
    const found = [];
    for (const a of await page.getAnnotations()) {
      if (a.subtype === 'Link' && typeof a.url === 'string' && WEB.test(a.url) && a.rect) found.push({ url: a.url, rect: a.rect });
    }
    const { items } = await page.getTextContent();
    const starts = [];
    let text = '';
    for (const item of items) {
      starts.push(text.length);
      text += `${item.str ?? ''}${item.hasEOL ? '\n' : ''}`;
    }
    for (const m of text.matchAll(TEXT_URL)) {
      const url = m[0].replace(TRAILING, '');
      if (found.some((f) => f.url === url)) continue;
      let i = starts.length - 1;
      while (i > 0 && (starts[i] > m.index || !items[i].str)) i--;
      const { transform, width, height } = items[i];
      if (transform) found.push({ url, rect: [transform[4], transform[5] - height * 0.25, transform[4] + width, transform[5] + height] });
    }
    page.cleanup();
    return found.sort((a, b) => b.rect[3] - a.rect[3]);
  }

  function watch(pdf, viewer, eventBus, container, follow) {
    const button = document.getElementById('linksbtn');
    const panel = document.getElementById('linkpanel');
    const inner = document.getElementById('linkinner');
    const list = document.getElementById('linklist');
    const total = document.getElementById('linktotal');
    const closer = document.getElementById('linkclose');
    const chooser = document.getElementById('linkchoose');
    const copier = document.getElementById('linkcopy');
    const scanning = document.getElementById('linkscan');
    const entries = [];
    const known = new Map();
    let open = false;
    let started = false;
    let finished = false;
    let closing = null;
    let copied = null;
    let scanned = 0;

    button.innerHTML = icon('link');
    button.title = 'Links in this document';
    button.setAttribute('aria-label', 'Links in this document');
    closer.innerHTML = icon('close');
    closer.title = 'Hide links';
    closer.setAttribute('aria-label', 'Hide links');
    const empty = el('div', 'linkempty');
    const emptyIcon = el('i');
    emptyIcon.innerHTML = icon('link');
    const emptyText = el('p');
    empty.append(emptyIcon, emptyText);
    list.append(empty);

    const copyIcon = el('i');
    copyIcon.innerHTML = icon('copy');
    copier.append(copyIcon, el('span'));
    const picked = () => entries.filter((e) => e.selected);

    function bar() {
      const n = picked().length;
      total.textContent = entries.length ? `${entries.length} ${entries.length === 1 ? 'link' : 'links'}` : '';
      chooser.hidden = !entries.length;
      chooser.textContent = n ? 'Clear' : 'Select all';
      copier.disabled = !entries.length;
      if (!copier.classList.contains('done')) copier.lastChild.textContent = n ? `Copy ${n}` : 'Copy all';
      list.classList.toggle('picking', n > 0);
      empty.hidden = entries.length > 0;
      if (!entries.length) emptyText.textContent = finished ? 'No links in this document' : 'Looking for links…';
      scanning.textContent = finished ? '' : `Reading page ${Math.min(scanned + 1, pdf.numPages)} of ${pdf.numPages}`;
    }

    function make(entry) {
      const row = el('div', 'linkrow');
      row.entry = entry;
      const pick = el('button', 'pick');
      pick.type = 'button';
      pick.tabIndex = -1;
      pick.title = 'Select';
      pick.setAttribute('role', 'checkbox');
      pick.setAttribute('aria-checked', 'false');
      pick.setAttribute('aria-label', 'Select this link');
      pick.innerHTML = icon('check');
      const go = el('button', 'linkgo');
      go.type = 'button';
      go.title = entry.url;
      const [host, rest, kind] = parts(entry.url);
      const line = el('span', 'linkurl');
      line.append(el('b', '', host), rest);
      const sub = el('span', 'linkpage', `Page ${entry.page}`);
      sub.append(el('em', '', kind));
      go.append(line, sub);
      const out = el('button', 'sm linkopen');
      out.type = 'button';
      out.tabIndex = -1;
      out.title = 'Open link';
      out.setAttribute('aria-label', 'Open link');
      out.innerHTML = icon('external');
      row.append(pick, go, out);
      entry.row = row;
      entry.sub = sub;
      list.append(row);
    }

    function add(page, { url, rect }) {
      const old = known.get(url);
      if (old) {
        old.count++;
        old.sub.firstChild.textContent = `Page ${old.page} · ${old.count} places`;
        return;
      }
      const entry = { url, page, rect, count: 1, selected: false, row: null, sub: null };
      known.set(url, entry);
      entries.push(entry);
      make(entry);
    }

    async function scan() {
      for (let n = 1; n <= pdf.numPages; n++) {
        for (const found of await readPage(pdf, n).catch(() => [])) add(n, found);
        scanned = n;
        bar();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      finished = true;
      bar();
    }

    function select(entry, on) {
      entry.selected = on;
      entry.row.classList.toggle('on', on);
      entry.row.querySelector('.pick').setAttribute('aria-checked', String(on));
    }

    // pdf.js clears what it did not put in a page when it draws the page, so the ring waits for a page that is not drawn yet.
    function flash(entry) {
      const view = viewer.getPageView(entry.page - 1);
      if (view.renderingState === FINISHED) { ring(entry, view); return; }
      const rendered = ({ pageNumber }) => {
        if (pageNumber !== entry.page) return;
        eventBus.off('pagerendered', rendered);
        ring(entry, view);
      };
      eventBus.on('pagerendered', rendered);
    }

    function ring(entry, view) {
      const [x1, y1] = view.viewport.convertToViewportPoint(entry.rect[0], entry.rect[1]);
      const [x2, y2] = view.viewport.convertToViewportPoint(entry.rect[2], entry.rect[3]);
      const mark = el('div', 'linkflash');
      mark.style.setProperty('left', `${Math.min(x1, x2) - 5}px`);
      mark.style.setProperty('top', `${Math.min(y1, y2) - 4}px`);
      mark.style.setProperty('width', `${Math.abs(x2 - x1) + 10}px`);
      mark.style.setProperty('height', `${Math.abs(y2 - y1) + 8}px`);
      view.div.append(mark);
      setTimeout(() => mark.remove(), 1700);
    }

    function show(entry) {
      viewer.scrollPageIntoView({ pageNumber: entry.page, destArray: [null, { name: 'XYZ' }, Math.max(0, entry.rect[0] - 20), entry.rect[3] + 90, null] });
      flash(entry);
    }

    function setOpen(on) {
      open = on;
      clearTimeout(closing);
      if (on) {
        window.workspaceResults.hide();
        inner.hidden = false;
        if (!started) { started = true; bar(); scan(); }
      } else {
        closing = setTimeout(() => { inner.hidden = true; }, SLIDE);
      }
      panel.classList.toggle('open', on);
      button.setAttribute('aria-pressed', String(on));
    }

    async function copy() {
      const chosen = picked();
      const count = await window.workspaceApi.copyLinks((chosen.length ? chosen : entries).map((e) => e.url));
      if (!count) return;
      copier.classList.add('done');
      copier.firstChild.innerHTML = icon('check');
      copier.lastChild.textContent = 'Copied';
      clearTimeout(copied);
      copied = setTimeout(() => { copier.classList.remove('done'); copier.firstChild.innerHTML = icon('copy'); bar(); }, SHOWN);
    }

    const rowOf = (e) => e.target.closest('.linkrow');
    list.addEventListener('click', (e) => {
      const row = rowOf(e);
      if (!row) return;
      if (e.target.closest('.pick')) { select(row.entry, !row.entry.selected); bar(); }
      else if (e.target.closest('.linkopen')) follow(row.entry.url);
      else if (e.target.closest('.linkgo')) { show(row.entry); container.focus(); }
    });
    list.addEventListener('mousedown', (e) => e.preventDefault());
    list.addEventListener('keydown', (e) => {
      const go = e.target.closest('.linkgo');
      if (!go) return;
      const row = rowOf(e);
      if (e.key === ' ') { e.preventDefault(); select(row.entry, !row.entry.selected); bar(); }
      else if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); follow(row.entry.url); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const next = e.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling;
        next?.querySelector('.linkgo')?.focus();
        e.preventDefault();
      }
    });
    list.addEventListener('keyup', (e) => { if (e.key === ' ' && e.target.closest('.linkgo')) e.preventDefault(); });
    chooser.onclick = () => {
      const on = !picked().length;
      for (const entry of entries) select(entry, on);
      bar();
    };
    copier.onclick = copy;
    for (const b of [closer, chooser, copier, button]) b.addEventListener('mousedown', (e) => e.preventDefault());
    closer.onclick = () => setOpen(false);
    button.onclick = () => setOpen(!open);
    eventBus.on('pagesinit', () => { button.disabled = false; });
    window.workspaceKeys.bind('escape', () => {
      if (!open || !panel.contains(document.activeElement)) return false;
      setOpen(false);
      container.focus();
      return true;
    });
    api.hide = () => { if (open) setOpen(false); };
  }

  const api = { watch, hide: () => {} };
  window.workspaceLinkList = api;
})();

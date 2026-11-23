// SPDX-License-Identifier: AGPL-3.0-or-later
// The Links tab of the panel on the right (side.js): every web and mail address in the document, one row each, found by reading the pages in
// turn the first time the tab is shown. A row is selected with its circle, goes to the link and lights it with a click and opens it with its
// arrow; the circle in the heading selects or clears them all and the Copy button copies the selected addresses, one to a line. A classic
// script that adds window.workspaceLinkList.
(() => {
  const { el, icon } = window.pomeloUi;
  const WEB = /^(?:https?:|mailto:)/i;
  const TEXT_URL = /https?:\/\/[^\s<>"]+/gi;
  const TRAILING = /[.,;:!?)\]}'"]+$/;
  const SHOWN = 1400;
  const FINISHED = 3;

  function parts(url) {
    try {
      const u = new URL(url);
      if (u.protocol === 'mailto:') return [decodeURIComponent(u.pathname), '', 'mail'];
      return [u.host, `${u.pathname === '/' ? '' : u.pathname}${u.search}${u.hash}`, 'globe'];
    } catch {
      return [url, '', 'globe'];
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

  function watch(viewer, eventBus, container, follow) {
    const button = document.getElementById('linksbtn');
    const list = document.getElementById('linklist');
    const chooser = document.getElementById('linkchoose');
    const copier = document.getElementById('linkcopy');
    const status = document.getElementById('linkscan');
    const progress = document.getElementById('linkprogress');
    const entries = [];
    const known = new Map();
    let started = false;
    let shown = false;
    let run = 0;
    let finished = false;
    let copied = null;
    let scanned = 0;
    let lit = null;
    let wanted = null;

    button.innerHTML = icon('link');
    button.title = 'Links in this document';
    button.setAttribute('aria-label', 'Links in this document');
    const empty = el('div', 'sideempty');
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
      const all = n > 0 && n === entries.length;
      chooser.hidden = !entries.length;
      chooser.setAttribute('aria-checked', all ? 'true' : n ? 'mixed' : 'false');
      chooser.innerHTML = icon(n && !all ? 'minus' : 'check');
      chooser.title = n ? 'Clear' : 'Select All';
      chooser.setAttribute('aria-label', chooser.title);
      copier.disabled = !n;
      if (!copier.classList.contains('done')) copier.lastChild.textContent = !n ? 'Copy' : all ? 'Copy All' : `Copy ${n}`;
      list.classList.toggle('picking', n > 0);
      empty.hidden = entries.length > 0;
      if (!entries.length) emptyText.textContent = finished ? 'No links in this document' : 'Looking for links…';
      status.textContent = entries.length ? `${entries.length} ${entries.length === 1 ? 'link' : 'links'}` : '';
      progress.hidden = finished || !started;
      progress.title = `Reading page ${Math.min(scanned + 1, viewer.pagesCount)} of ${viewer.pagesCount}`;
      progress.style.setProperty('--done', `${(100 * scanned) / Math.max(viewer.pagesCount, 1)}%`);
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
      const [host, rest, kind] = parts(entry.url);
      pick.innerHTML = icon(kind) + icon('check');
      const go = el('button', 'linkgo');
      go.type = 'button';
      go.title = entry.url;
      const line = el('span', 'linkurl');
      line.append(el('b', '', host), rest);
      const sub = el('span', 'linkpage', `Page ${entry.page}`);
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
        old.sub.textContent = `Page ${old.page} · ${old.count} places`;
        return;
      }
      const entry = { url, page, rect, count: 1, selected: false, row: null, sub: null };
      known.set(url, entry);
      entries.push(entry);
      make(entry);
    }

    async function scan() {
      const pdf = viewer.pdfDocument;
      const mine = run;
      for (let n = 1; n <= pdf.numPages; n++) {
        const links = await readPage(pdf, n).catch(() => []);
        if (mine !== run) return;
        for (const found of links) add(n, found);
        scanned = n;
        bar();
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (mine !== run) return;
      }
      finished = true;
      bar();
    }

    function reset() {
      run++;
      for (const entry of entries) entry.row.remove();
      entries.length = 0;
      known.clear();
      started = false;
      finished = false;
      scanned = 0;
      unlight();
      bar();
    }

    function select(entry, on) {
      entry.selected = on;
      entry.row.classList.toggle('on', on);
      entry.row.querySelector('.pick').setAttribute('aria-checked', String(on));
    }

    function unlight() {
      lit?.remove();
      lit = null;
      wanted?.row.classList.remove('now');
      wanted?.row.removeAttribute('aria-current');
      wanted = null;
    }

    // The link is lit in the yellow of the hit being looked at in a search, and stays so until another is chosen or the panel shuts.
    // pdf.js clears what it did not put in a page when it draws the page, so a page that is not drawn yet is lit once it is.
    function light(entry) {
      const view = viewer.getPageView(entry.page - 1);
      if (view.renderingState === FINISHED) { paint(entry, view); return; }
      const rendered = ({ pageNumber }) => {
        if (pageNumber !== entry.page) return;
        eventBus.off('pagerendered', rendered);
        if (wanted === entry) paint(entry, view);
      };
      eventBus.on('pagerendered', rendered);
    }

    function paint(entry, view) {
      const [x1, y1] = view.viewport.convertToViewportPoint(entry.rect[0], entry.rect[1]);
      const [x2, y2] = view.viewport.convertToViewportPoint(entry.rect[2], entry.rect[3]);
      lit = el('div', 'linkhit');
      lit.style.setProperty('left', `${Math.min(x1, x2)}px`);
      lit.style.setProperty('top', `${Math.min(y1, y2)}px`);
      lit.style.setProperty('width', `${Math.abs(x2 - x1)}px`);
      lit.style.setProperty('height', `${Math.abs(y2 - y1)}px`);
      view.div.append(lit);
    }

    function goTo(entry) {
      unlight();
      wanted = entry;
      entry.row.classList.add('now');
      entry.row.setAttribute('aria-current', 'true');
      viewer.scrollPageIntoView({ pageNumber: entry.page, destArray: [null, { name: 'XYZ' }, Math.max(0, entry.rect[0] - 20), entry.rect[3] + 90, null] });
      light(entry);
    }

    // Called by side.js when the tab comes on show or goes off it.
    function show(on) {
      shown = on;
      if (on && !started) { started = true; bar(); scan(); }
      if (!on) unlight();
    }

    async function copy() {
      const count = await window.workspaceApi.copyLinks(picked().map((e) => e.url));
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
      else if (e.target.closest('.linkgo')) { goTo(row.entry); container.focus(); }
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
    for (const b of [chooser, copier, button]) b.addEventListener('mousedown', (e) => e.preventDefault());
    button.onclick = () => window.workspaceSide.toggle('links');
    window.workspaceSide.onchange((open, tab) => button.setAttribute('aria-pressed', String(open && tab === 'links')));
    eventBus.on('pagesinit', () => {
      button.disabled = false;
      if (shown) { started = true; bar(); scan(); }
    });
    eventBus.on('pagesdestroy', () => { reset(); button.disabled = true; });
    api.show = show;
  }

  const api = { watch, show: () => {} };
  window.workspaceLinkList = api;
})();

// SPDX-License-Identifier: AGPL-3.0-or-later
// The list of hits in a panel of its own on the right: one row for every hit, the page it is on and a few words round it with the hit marked. Only the
// rows in view exist, so a word that is found thirty thousand times costs the same as one that is found ten times. A classic script
// that adds window.workspaceResults.
(() => {
  const { el, icon } = window.pomeloUi;
  const SLIDE = 350;
  const ROW = 68;
  const SPARE = 3;
  const BEFORE = 36;
  const AFTER = 64;
  const TEXTS = 60;

  // hits: what search.js knows of the matches: count(), locate(n) giving { page, index }, offset(page, index), length(page, index),
  // current() and jump(n). The text is the page's own, read the way pdf.js reads it to find. Its offsets count the words of the page
  // and not the line ends, which are kept apart so that a snippet can put a space where a line ended.
  function watch(pdf, hits, container) {
    const panel = document.getElementById('hitpanel');
    const inner = document.getElementById('hitinner');
    const list = document.getElementById('results');
    const total = document.getElementById('hittotal');
    const closer = document.getElementById('hitclose');
    closer.innerHTML = icon('close');
    closer.title = 'Hide results';
    closer.setAttribute('aria-label', 'Hide results');
    const space = el('div', 'rowspace');
    const note = el('p', 'empty', 'No results');
    note.hidden = true;
    list.append(note, space);
    const rows = new Map();
    const texts = new Map();
    let shownCurrent = -2;
    let none = false;
    let open = false;
    let closing = null;

    function pageText(page) {
      if (!texts.has(page)) {
        texts.set(page, pdf.getPage(page + 1).then((p) => p.getTextContent({ disableNormalization: true })).then(({ items }) => {
          const ends = new Set();
          let text = '';
          for (const item of items) {
            text += item.str;
            if (item.hasEOL) ends.add(text.length);
          }
          return { text, ends };
        }).catch(() => ({ text: '', ends: new Set() })));
        if (texts.size > TEXTS) texts.delete(texts.keys().next().value);
      }
      return texts.get(page);
    }

    async function fill(row, n) {
      const { page, index } = hits.locate(n);
      const { text, ends } = await pageText(page);
      if (rows.get(n) !== row) return;
      const piece = (from, to, lead = false) => {
        let out = '';
        for (let i = from; i < to; i++) out += ((i > from || lead) && ends.has(i) ? ' ' : '') + text[i];
        return out.replace(/\s+/g, ' ');
      };
      const at = hits.offset(page, index);
      const mid = at + hits.length(page, index);
      const from = Math.max(0, at - BEFORE);
      const to = Math.min(text.length, mid + AFTER);
      row.snippet.replaceChildren(`${from ? '…' : ''}${piece(from, at)}`, el('mark', '', piece(at, mid)), `${piece(mid, to, true)}${to < text.length ? '…' : ''}`);
    }

    function make(n) {
      const b = el('button', 'hitrow');
      b.type = 'button';
      b.style.setProperty('top', `${n * ROW}px`);
      const { page } = hits.locate(n);
      const snippet = el('span', 'snip');
      b.append(el('span', 'pg', `Page ${page + 1}`), snippet);
      b.snippet = snippet;
      b.onclick = () => { hits.jump(n); container.focus(); };
      space.append(b);
      rows.set(n, b);
      fill(b, n);
      return b;
    }

    function reset() {
      for (const row of rows.values()) row.remove();
      rows.clear();
      texts.clear();
      shownCurrent = -2;
      list.scrollTop = 0;
    }

    function draw() {
      if (!open) return;
      const found = hits.count();
      total.textContent = found ? `${found} ${found === 1 ? 'result' : 'results'}` : '';
      note.hidden = found > 0 || !none;
      space.style.setProperty('height', `${found * ROW}px`);
      if (!found) reset();
      const height = list.clientHeight;
      if (!height) return;
      const first = Math.max(0, Math.floor(list.scrollTop / ROW) - SPARE);
      const last = Math.min(found - 1, Math.ceil((list.scrollTop + height) / ROW) + SPARE);
      for (const [n, row] of rows) {
        if (n < first || n > last) { row.remove(); rows.delete(n); }
      }
      for (let n = first; n <= last; n++) if (!rows.has(n)) make(n);
      const now = hits.current();
      for (const [n, row] of rows) {
        row.classList.toggle('on', n === now);
        if (n === now) row.setAttribute('aria-current', 'true'); else row.removeAttribute('aria-current');
      }
      if (now !== shownCurrent && now >= 0) {
        const top = now * ROW;
        if (top < list.scrollTop) list.scrollTop = top;
        else if (top + ROW > list.scrollTop + height) list.scrollTop = top + ROW - height;
      }
      shownCurrent = now;
    }

    function setOpen(on) {
      open = on;
      clearTimeout(closing);
      if (on) inner.hidden = false;
      else closing = setTimeout(() => { inner.hidden = true; reset(); }, SLIDE);
      panel.classList.toggle('open', on);
      api.onchange(on);
      draw();
    }

    closer.onclick = () => setOpen(false);
    closer.addEventListener('mousedown', (e) => e.preventDefault());
    list.addEventListener('scroll', draw, { passive: true });
    new ResizeObserver(draw).observe(list);
    api.draw = (nothing = none) => { none = nothing; draw(); };
    api.reset = reset;
    api.toggle = () => { setOpen(!open); return open; };
    api.hide = () => { if (open) setOpen(false); };
  }

  const api = { watch, draw: () => {}, reset: () => {}, toggle: () => false, hide: () => {}, onchange: () => {} };
  window.workspaceResults = api;
})();

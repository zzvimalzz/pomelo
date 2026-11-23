// SPDX-License-Identifier: AGPL-3.0-or-later
// The list of hits, the Search tab of the panel on the right (side.js): a heading for every page that has hits, then one row for each, a few
// words round the hit with the hit marked. Only the headings and rows in view exist, so a word that is found thirty thousand times costs the
// same as one that is found ten times. A classic script that adds window.workspaceResults.
(() => {
  const { el, icon } = window.pomeloUi;
  const SLIDE = 350;
  const HINT = 'Type in the search bar to see the hits here';
  const HEAD = 30;
  const ROW = 52;
  const SPARE = 3;
  const BEFORE = 36;
  const AFTER = 64;
  const TEXTS = 60;

  // hits: what search.js knows of the matches: count(), pages() giving { page, first, count } for each page with hits, locate(n) giving
  // { page, index }, offset(page, index), length(page, index), current() and jump(n). The text is the page's own, read the way pdf.js reads
  // it to find. Its offsets count the words of the page and not the line ends, which are kept apart so that a snippet can put a space where
  // a line ended.
  function watch(viewer, hits, container) {
    const list = document.getElementById('results');
    const total = document.getElementById('hittotal');
    const space = el('div', 'rowspace');
    const note = el('div', 'sideempty');
    const noteIcon = el('i');
    noteIcon.innerHTML = icon('search');
    const noteText = el('p', '', HINT);
    note.append(noteIcon, noteText);
    list.append(note, space);
    const rows = new Map();
    const heads = new Map();
    const texts = new Map();
    let shownCurrent = -2;
    let none = false;
    let open = false;

    function pageText(page) {
      if (!texts.has(page)) {
        texts.set(page, viewer.pdfDocument.getPage(page + 1).then((p) => p.getTextContent({ disableNormalization: true })).then(({ items }) => {
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

    // What a row shows depends on the hit it stands for. pdf.js finds page after page, so while it works a row's number is a different hit
    // from one moment to the next, and a row is drawn again when its key changes.
    const keyOf = (n) => {
      const { page, index } = hits.locate(n);
      return `${page}:${index}:${hits.offset(page, index)}:${hits.length(page, index)}`;
    };

    async function fill(row, n) {
      const key = row.key;
      const { page, index } = hits.locate(n);
      const { text, ends } = await pageText(page);
      if (rows.get(n) !== row || row.key !== key) return;
      const piece = (from, to, lead = false) => {
        let out = '';
        for (let i = from; i < to; i++) out += ((i > from || lead) && ends.has(i) ? ' ' : '') + text[i];
        return out.replace(/\s+/g, ' ');
      };
      const at = hits.offset(page, index);
      const mid = at + hits.length(page, index);
      const from = Math.max(0, at - BEFORE);
      const to = Math.min(text.length, mid + AFTER);
      const before = from ? piece(from, at).replace(/^\S*\s/, '') : piece(from, at);
      const after = to < text.length ? piece(mid, to, true).replace(/\s\S*$/, '') : piece(mid, to, true);
      row.snippet.replaceChildren(`${from ? '…' : ''}${before}`, el('mark', '', piece(at, mid)), `${after}${to < text.length ? '…' : ''}`);
    }

    function make(n) {
      const b = el('button', 'hitrow');
      b.type = 'button';
      b.pg = el('span', 'pg', `Page ${hits.locate(n).page + 1}`);
      b.snippet = el('span', 'snip');
      b.append(b.pg, b.snippet);
      b.key = keyOf(n);
      b.onclick = () => { hits.jump(n); container.focus(); };
      space.append(b);
      rows.set(n, b);
      fill(b, n);
      return b;
    }

    function heading({ page, count }) {
      let h = heads.get(page);
      if (!h) {
        h = el('div', 'hitpage');
        h.append(el('span', '', `Page ${page + 1}`), el('small'));
        space.append(h);
        heads.set(page, h);
      }
      h.lastChild.textContent = String(count);
      return h;
    }

    function refresh(n, row) {
      const key = keyOf(n);
      if (row.key === key) return;
      row.key = key;
      row.pg.textContent = `Page ${hits.locate(n).page + 1}`;
      row.snippet.replaceChildren();
      fill(row, n);
    }

    function reset() {
      for (const row of rows.values()) row.remove();
      for (const h of heads.values()) h.remove();
      rows.clear();
      heads.clear();
      texts.clear();
      shownCurrent = -2;
      list.scrollTop = 0;
    }

    function draw() {
      if (!open) return;
      const found = hits.count();
      total.textContent = found ? `${found} ${found === 1 ? 'result' : 'results'}` : '';
      note.hidden = found > 0;
      noteText.textContent = none ? 'No results' : HINT;
      const pages = hits.pages();
      const tops = [];
      let height = 0;
      for (const g of pages) {
        tops.push(height);
        height += HEAD + g.count * ROW;
      }
      space.style.setProperty('height', `${height}px`);
      if (!found) reset();
      const view = list.clientHeight;
      if (!view) return;
      const low = list.scrollTop - SPARE * ROW;
      const high = list.scrollTop + view + SPARE * ROW;
      const keepRows = new Set();
      const keepHeads = new Set();
      pages.forEach((g, i) => {
        const top = tops[i];
        if (top + HEAD + g.count * ROW < low || top > high) return;
        keepHeads.add(g.page);
        heading(g).style.setProperty('top', `${top}px`);
        const last = Math.min(g.count - 1, Math.ceil((high - top - HEAD) / ROW));
        for (let k = Math.max(0, Math.floor((low - top - HEAD) / ROW)); k <= last; k++) {
          const n = g.first + k;
          keepRows.add(n);
          (rows.get(n) ?? make(n)).style.setProperty('top', `${top + HEAD + k * ROW}px`);
        }
      });
      for (const [n, row] of rows) if (!keepRows.has(n)) { row.remove(); rows.delete(n); }
      for (const [page, h] of heads) if (!keepHeads.has(page)) { h.remove(); heads.delete(page); }
      const now = hits.current();
      for (const [n, row] of rows) {
        refresh(n, row);
        row.classList.toggle('on', n === now);
        if (n === now) row.setAttribute('aria-current', 'true'); else row.removeAttribute('aria-current');
      }
      if (now !== shownCurrent && now >= 0) {
        const i = pages.findLastIndex((g) => g.first <= now);
        if (i >= 0) {
          const top = tops[i] + HEAD + (now - pages[i].first) * ROW;
          const want = now === pages[i].first ? top - HEAD : top;
          if (want < list.scrollTop) list.scrollTop = want;
          else if (top + ROW > list.scrollTop + view) list.scrollTop = top + ROW - view;
        }
      }
      shownCurrent = now;
    }

    function show(on) {
      open = on;
      if (!on) setTimeout(() => { if (!open) reset(); }, SLIDE);
      draw();
    }

    list.addEventListener('scroll', draw, { passive: true });
    new ResizeObserver(draw).observe(list);
    api.draw = (nothing = none) => { none = nothing; draw(); };
    api.reset = reset;
    api.show = show;
  }

  const api = { watch, draw: () => {}, reset: () => {}, show: () => {} };
  window.workspaceResults = api;
})();

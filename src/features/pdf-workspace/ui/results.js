// SPDX-License-Identifier: AGPL-3.0-or-later
// The list of hits, the Search tab of the panel on the right (side.js): one row for every hit, the page it is on and a few words round it with the hit marked. Only the
// rows in view exist, so a word that is found thirty thousand times costs the same as one that is found ten times. A classic script
// that adds window.workspaceResults.
(() => {
  const { el } = window.pomeloUi;
  const SLIDE = 350;
  const HINT = 'Type in the search bar to see the hits here';
  const ROW = 68;
  const SPARE = 3;
  const BEFORE = 36;
  const AFTER = 64;
  const TEXTS = 60;

  // hits: what search.js knows of the matches: count(), locate(n) giving { page, index }, offset(page, index), length(page, index),
  // current() and jump(n). The text is the page's own, read the way pdf.js reads it to find. Its offsets count the words of the page
  // and not the line ends, which are kept apart so that a snippet can put a space where a line ended.
  function watch(pdf, hits, container) {
    const list = document.getElementById('results');
    const total = document.getElementById('hittotal');
    const space = el('div', 'rowspace');
    const note = el('p', 'empty', HINT);
    list.append(note, space);
    const rows = new Map();
    const texts = new Map();
    let shownCurrent = -2;
    let none = false;
    let open = false;

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
      row.snippet.replaceChildren(`${from ? '…' : ''}${piece(from, at)}`, el('mark', '', piece(at, mid)), `${piece(mid, to, true)}${to < text.length ? '…' : ''}`);
    }

    function make(n) {
      const b = el('button', 'hitrow');
      b.type = 'button';
      b.style.setProperty('top', `${n * ROW}px`);
      const snippet = el('span', 'snip');
      b.pg = el('span', 'pg', `Page ${hits.locate(n).page + 1}`);
      b.append(b.pg, snippet);
      b.snippet = snippet;
      b.key = keyOf(n);
      b.onclick = () => { hits.jump(n); container.focus(); };
      space.append(b);
      rows.set(n, b);
      fill(b, n);
      return b;
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
      rows.clear();
      texts.clear();
      shownCurrent = -2;
      list.scrollTop = 0;
    }

    function draw() {
      if (!open) return;
      const found = hits.count();
      total.textContent = found ? `${found} ${found === 1 ? 'result' : 'results'}` : '';
      note.hidden = found > 0;
      note.textContent = none ? 'No results' : HINT;
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
        refresh(n, row);
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

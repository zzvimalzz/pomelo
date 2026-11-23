// SPDX-License-Identifier: AGPL-3.0-or-later
// The comments a PDF already holds, as small markers beside each page, level with what the comment is about. A marker opens a card
// with the comment and lights up its text, spot or annotation. Read only. A classic script that adds window.workspaceComments.
(() => {
  const { el, icon } = window.pomeloUi;
  const MARKUP = new Set(['Highlight', 'Underline', 'StrikeOut', 'Squiggly']);
  const COMMENTED = new Set([...MARKUP, 'Text', 'Ink', 'Square', 'Circle', 'Line', 'Polygon', 'PolyLine', 'Caret', 'Stamp']);
  const GAP = 28;
  const ROOM = 46;
  const CARD_ROOM = 300;

  // A box on the page as fractions of its width and height, so it follows every zoom without being worked out again.
  function fractions(viewport, points) {
    const at = points.map(([x, y]) => viewport.convertToViewportPoint(x, y));
    const xs = at.map((p) => p[0]);
    const ys = at.map((p) => p[1]);
    return [Math.min(...xs) / viewport.width, Math.min(...ys) / viewport.height, Math.max(...xs) / viewport.width, Math.max(...ys) / viewport.height];
  }

  function commentOf(a, viewport) {
    const text = a.contentsObj?.str.trim();
    if (!COMMENTED.has(a.subtype) || !text) return null;
    const boxes = [];
    const quads = MARKUP.has(a.subtype) && a.quadPoints ? Array.from(a.quadPoints) : [];
    for (let i = 0; i + 8 <= quads.length; i += 8) boxes.push(fractions(viewport, [[quads[i], quads[i + 1]], [quads[i + 2], quads[i + 3]], [quads[i + 4], quads[i + 5]], [quads[i + 6], quads[i + 7]]]));
    if (!boxes.length) boxes.push(fractions(viewport, [[a.rect[0], a.rect[1]], [a.rect[2], a.rect[3]]]));
    const date = /^D:(\d{4})(\d\d)?(\d\d)?/.exec(a.modificationDate || '');
    const when = date ? new Date(Number(date[1]), Number(date[2] || 1) - 1, Number(date[3] || 1)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    return {
      text, boxes, kind: a.subtype === 'Text' ? 'spot' : MARKUP.has(a.subtype) ? 'text' : 'box',
      byline: [a.titleObj?.str, when].filter(Boolean).join(' · '), colour: a.color ? `rgb(${Array.from(a.color).join(',')})` : '',
      centre: (boxes[0][1] + boxes[0][3]) / 2,
    };
  }

  function watch(viewer, eventBus, container) {
    const pages = new Map();
    let open = null;

    const onLeft = (n) => (viewer.spreadMode === 1 ? n % 2 === 1 : viewer.spreadMode === 2 ? n % 2 === 0 : false);

    function close() {
      if (!open) return;
      open.card.remove();
      open.item.mark.classList.remove('on');
      open.item.marks.forEach((m) => m.classList.remove('on'));
      open = null;
    }

    function layout(pageNumber, page) {
      const area = container.getBoundingClientRect();
      const rect = page.div.getBoundingClientRect();
      const left = onLeft(pageNumber);
      const room = left ? rect.left - area.left : area.right - rect.right;
      let last = -Infinity;
      for (const item of [...page.items].sort((a, b) => a.centre - b.centre)) {
        last = Math.max(item.centre * rect.height - 12, last + GAP);
        item.mark.style.top = `${(last / rect.height) * 100}%`;
        item.mark.classList.toggle('left', left);
        item.mark.classList.toggle('inside', room < ROOM);
        if (open?.item === item) open.card.style.top = item.mark.style.top;
      }
    }

    const layoutAll = () => {
      for (const [n, page] of pages) {
        if (page.layer.isConnected) layout(n, page);
        else pages.delete(n);
      }
    };

    function show(pageNumber, item) {
      close();
      const { div } = pages.get(pageNumber);
      const rect = div.getBoundingClientRect();
      const area = container.getBoundingClientRect();
      const left = onLeft(pageNumber);
      const room = left ? rect.left - area.left : area.right - rect.right;
      const card = el('div', `ccard ${room > CARD_ROOM ? 'out' : 'in'}${left ? ' left' : ''}${item.mark.classList.contains('inside') ? ' inside' : ''}`);
      if (item.byline) card.append(el('small', '', item.byline));
      card.append(el('p', '', item.text));
      card.style.top = item.mark.style.top;
      item.mark.after(card);
      item.mark.classList.add('on');
      item.marks.forEach((m) => m.classList.add('on'));
      open = { item, card };
    }

    async function build({ source, pageNumber }) {
      const annotations = await source.pdfPage.getAnnotations();
      pages.get(pageNumber)?.layer.remove();
      if (open && !open.card.isConnected) open = null;
      const items = annotations.map((a) => commentOf(a, source.viewport)).filter(Boolean);
      if (!items.length) { pages.delete(pageNumber); return; }
      const layer = el('div', 'cmarks');
      for (const item of items) {
        item.mark = el('button', 'cmark');
        item.mark.type = 'button';
        item.mark.title = 'Comment';
        item.mark.setAttribute('aria-label', 'Comment');
        item.mark.innerHTML = `${icon('comment')}<i></i>`;
        if (item.colour) item.mark.lastChild.style.background = item.colour;
        item.mark.onclick = () => (open?.item === item ? close() : show(pageNumber, item));
        item.marks = item.boxes.map(([x0, y0, x1, y1]) => {
          const light = el('i', `clight ${item.kind}`);
          Object.assign(light.style, { left: `${x0 * 100}%`, top: `${y0 * 100}%`, width: `${(x1 - x0) * 100}%`, height: `${(y1 - y0) * 100}%` });
          return light;
        });
        layer.append(...item.marks, item.mark);
      }
      source.div.append(layer);
      pages.set(pageNumber, { div: source.div, layer, items });
      layout(pageNumber, pages.get(pageNumber));
    }

    eventBus.on('pagesdestroy', () => { close(); pages.clear(); });
    eventBus.on('annotationlayerrendered', build);
    eventBus.on('scalechanging', layoutAll);
    eventBus.on('spreadmodechanged', layoutAll);
    new ResizeObserver(layoutAll).observe(container);
    container.addEventListener('pointerdown', (e) => { if (open && !e.target.closest('.cmark, .ccard')) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) { close(); e.preventDefault(); } });
  }

  window.workspaceComments = { watch };
})();

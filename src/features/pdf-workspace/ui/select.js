// SPDX-License-Identifier: AGPL-3.0-or-later
// Text selection that starts on empty paper. pdf.js's text layer only starts a selection on a line of text, so a press in the margin,
// the indent or below the last line selected nothing. Here a press on bare text layer picks the nearest line and the drag goes on
// from there, as in other readers. A classic script that adds window.workspaceSelect.
(() => {
  const EDGE = 24;

  // Every text node of a layer with its box, kept relative to the layer so a scroll during the drag does not spoil it.
  function boxes(layer) {
    const origin = layer.getBoundingClientRect();
    const list = [];
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.data.trim() || node.parentElement.closest('.endOfContent')) continue;
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      if (r.width && r.height) list.push({ node, l: r.left - origin.left, t: r.top - origin.top, r: r.right - origin.left, b: r.bottom - origin.top });
    }
    return list;
  }

  function nearest(list, layer, x, y) {
    const origin = layer.getBoundingClientRect();
    const px = x - origin.left;
    const py = y - origin.top;
    let best = null;
    let bestScore = Infinity;
    for (const box of list) {
      const dy = py < box.t ? box.t - py : py > box.b ? py - box.b : 0;
      const dx = px < box.l ? box.l - px : px > box.r ? px - box.r : 0;
      if (dy * 1000 + dx < bestScore) { best = box; bestScore = dy * 1000 + dx; }
    }
    if (!best) return null;
    const length = best.node.data.length;
    if (px <= best.l) return { node: best.node, offset: 0 };
    if (px >= best.r) return { node: best.node, offset: length };
    const at = document.caretPositionFromPoint(x, Math.min(Math.max(y, origin.top + best.t + 1), origin.top + best.b - 1));
    if (at && at.offsetNode === best.node) return { node: best.node, offset: at.offset };
    return { node: best.node, offset: Math.round(((px - best.l) / (best.r - best.l)) * length) };
  }

  function watch(container) {
    let cache = null;
    let drag = null;

    const layerAt = (y) => {
      let best = null;
      let gap = Infinity;
      for (const layer of container.querySelectorAll('.textLayer')) {
        const r = layer.getBoundingClientRect();
        const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
        if (d < gap) { best = layer; gap = d; }
      }
      return best;
    };

    function positionAt(x, y) {
      const over = document.elementFromPoint(x, y);
      if (over && over.closest('.textLayer span') && !over.closest('.endOfContent')) {
        const at = document.caretPositionFromPoint(x, y);
        if (at && at.offsetNode.nodeType === Node.TEXT_NODE) return { node: at.offsetNode, offset: at.offset };
      }
      const layer = layerAt(y);
      if (!layer) return null;
      if (!cache.has(layer)) cache.set(layer, boxes(layer));
      return nearest(cache.get(layer), layer, x, y);
    }

    function extend(x, y) {
      const to = positionAt(x, y);
      if (to) getSelection().setBaseAndExtent(drag.from.node, drag.from.offset, to.node, to.offset);
    }

    function stop() {
      if (!drag) return;
      clearInterval(drag.timer);
      window.removeEventListener('mousemove', drag.move);
      window.removeEventListener('mouseup', stop);
      window.removeEventListener('blur', stop);
      drag = null;
      cache = null;
    }

    container.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.detail !== 1 || e.shiftKey || !e.target.matches('.textLayer, .endOfContent')) return;
      cache = new Map();
      const from = positionAt(e.clientX, e.clientY);
      if (!from) { cache = null; return; }
      e.preventDefault();
      container.focus({ preventScroll: true });
      getSelection().setBaseAndExtent(from.node, from.offset, from.node, from.offset);
      const pointer = { x: e.clientX, y: e.clientY };
      const timer = setInterval(() => {
        const r = container.getBoundingClientRect();
        const past = pointer.y < r.top + EDGE ? pointer.y - (r.top + EDGE) : pointer.y > r.bottom - EDGE ? pointer.y - (r.bottom - EDGE) : 0;
        if (!past) return;
        container.scrollTop += Math.sign(past) * Math.min(40, 4 + Math.abs(past) / 4);
        extend(pointer.x, pointer.y);
      }, 40);
      const move = (m) => {
        if (!(m.buttons & 1)) { stop(); return; }
        pointer.x = m.clientX;
        pointer.y = m.clientY;
        extend(m.clientX, m.clientY);
      };
      drag = { from, timer, move };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', stop);
      window.addEventListener('blur', stop);
    });
  }

  window.workspaceSelect = { watch };
})();

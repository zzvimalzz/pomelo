// SPDX-License-Identifier: AGPL-3.0-or-later
// Where the hits are: a thin strip over the scroll bar's track with a mark for every hit, in step with the document's whole height,
// so a mark can be scrolled to. A hit's place on its page is its place in the page's text, which follows the page from top to bottom
// closely enough to land on the right screen. A classic script that adds window.workspaceTicks.
(() => {
  const { el } = window.pomeloUi;

  // hits: count(), locate(n) giving { page, index }, fraction(page, index) from 0 to 1, current().
  function watch(hits, viewer, container) {
    const canvas = el('canvas', 'ticks');
    canvas.setAttribute('aria-hidden', 'true');
    document.querySelector('.well').append(canvas);

    function draw() {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (!width || !height) return;
      const density = window.devicePixelRatio;
      const total = hits.count();
      const content = container.scrollHeight;
      const top = container.getBoundingClientRect().top - container.scrollTop;
      const places = [];
      let at = -1;
      let page = null;
      let y0 = 0;
      let pageHeight = 0;
      for (let n = 0; n < total; n++) {
        const where = hits.locate(n);
        if (where.page !== page) {
          page = where.page;
          const r = viewer.getPageView(page).div.getBoundingClientRect();
          y0 = r.top - top;
          pageHeight = r.height;
        }
        places.push(((y0 + pageHeight * hits.fraction(page, where.index)) / content) * height);
        if (n === hits.current()) at = places[n];
      }
      canvas.width = Math.round(width * density);
      canvas.height = Math.round(height * density);
      const g = canvas.getContext('2d');
      g.scale(density, density);
      const style = getComputedStyle(document.documentElement);
      g.fillStyle = `rgb(${style.getPropertyValue('--found')})`;
      for (const y of places) g.fillRect(0, Math.round(y) - 1, width, 3);
      if (at >= 0) {
        g.fillStyle = `rgb(${style.getPropertyValue('--found-now')})`;
        g.fillRect(0, Math.round(at) - 2, width, 5);
      }
    }

    let queued = false;
    api.draw = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; draw(); });
    };
    new ResizeObserver(api.draw).observe(container);
  }

  const api = { watch, draw: () => {} };
  window.workspaceTicks = api;
})();

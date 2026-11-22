// SPDX-License-Identifier: AGPL-3.0-or-later
// Page thumbnails: draws the pages that are asked for, one at a time so the main view is never starved, and keeps the last 300 as
// bitmaps. A classic script that adds window.workspaceThumbs.
(() => {
  const WIDTH = 120;
  const TALLEST = 240;
  const KEPT = 300;

  function fit(ratio) {
    const width = Math.min(WIDTH, TALLEST / ratio);
    return [width, width * ratio];
  }

  function create(pdf) {
    const cache = new Map();
    const waiting = new Map();
    const scratch = document.createElement('canvas');
    let current = null;
    let running = false;

    function keep(n, image) {
      cache.delete(n);
      cache.set(n, image);
      if (cache.size <= KEPT) return;
      const [oldest] = cache.keys();
      cache.get(oldest).bitmap.close();
      cache.delete(oldest);
    }

    async function render(job) {
      const page = await pdf.getPage(job.n);
      if (job.cancelled) return null;
      const base = page.getViewport({ scale: 1 });
      const ratio = base.height / base.width;
      const viewport = page.getViewport({ scale: (fit(ratio)[0] * Math.min(window.devicePixelRatio, 2)) / base.width });
      scratch.width = Math.ceil(viewport.width);
      scratch.height = Math.ceil(viewport.height);
      job.task = page.render({ canvasContext: scratch.getContext('2d'), viewport, background: '#fff' });
      await job.task.promise;
      const bitmap = await createImageBitmap(scratch);
      page.cleanup();
      return { bitmap, ratio };
    }

    async function pump() {
      if (running) return;
      running = true;
      while (waiting.size) {
        const [n, paint] = waiting.entries().next().value;
        waiting.delete(n);
        const job = { n, task: null, cancelled: false };
        current = job;
        const image = await render(job).catch(() => null);
        if (image) {
          keep(n, image);
          if (!job.cancelled) paint(image);
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      current = null;
      running = false;
    }

    // paint(image) gets { bitmap, ratio } at once when the page is kept, or when it has been drawn.
    function want(n, paint) {
      const image = cache.get(n);
      if (image) {
        keep(n, image);
        paint(image);
        return;
      }
      waiting.set(n, paint);
      pump();
    }

    function drop(n) {
      waiting.delete(n);
      if (current && current.n === n && !current.cancelled) {
        current.cancelled = true;
        current.task?.cancel();
      }
    }

    return { want, drop, kept: () => cache.size };
  }

  window.workspaceThumbs = { create, fit };
})();

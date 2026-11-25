// SPDX-License-Identifier: AGPL-3.0-or-later
// Page thumbnails: draws the pages that are asked for, one at a time so the main view is never starved, and keeps up to 300 as bitmaps
// (fewer when they are large, so the pictures stay within one memory budget). A classic script that adds window.workspaceThumbs.
(() => {
  const KEPT = 300;
  const BUDGET = 110 * 1048576;
  const TALL = 2;

  // `width` is the CSS width of a thumbnail. A page taller than TALL times its width is shrunk to that height, as workspace.css sizes
  // the sheet it is shown on.
  function create(pdf, startWidth) {
    let width = startWidth;
    const cache = new Map();
    const waiting = new Map();
    const scratch = document.createElement('canvas');
    let current = null;
    let running = false;

    const density = () => Math.min(window.devicePixelRatio, 2);
    const limit = () => Math.min(KEPT, Math.floor(BUDGET / ((width * density()) ** 2 * 1.5 * 4)));

    function keep(n, image) {
      cache.delete(n);
      cache.set(n, image);
      while (cache.size > limit()) {
        const [oldest] = cache.keys();
        cache.get(oldest).bitmap.close();
        cache.delete(oldest);
      }
    }

    async function render(job) {
      const page = await pdf.getPage(job.n);
      if (job.cancelled) return null;
      const base = page.getViewport({ scale: 1 });
      const ratio = base.height / base.width;
      const viewport = page.getViewport({ scale: (width * Math.min(1, TALL / ratio) * density()) / base.width });
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
        if (image && !job.cancelled) {
          keep(n, image);
          paint(image);
        } else image?.bitmap.close();
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

    function cancel(job) {
      job.cancelled = true;
      job.task?.cancel();
    }

    function drop(n) {
      waiting.delete(n);
      if (current && current.n === n && !current.cancelled) cancel(current);
    }

    function release() {
      waiting.clear();
      for (const { bitmap } of cache.values()) bitmap.close();
      cache.clear();
      if (current && !current.cancelled) cancel(current);
    }

    function setWidth(next) {
      if (next === width) return;
      width = next;
      release();
    }

    return { want, drop, setWidth, release, kept: () => cache.size };
  }

  function picture({ bitmap }) {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    return canvas;
  }

  window.workspaceThumbs = { create, picture };
})();

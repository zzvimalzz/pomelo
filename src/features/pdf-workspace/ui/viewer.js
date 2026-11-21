// SPDX-License-Identifier: AGPL-3.0-or-later
// pdf.js in this page: the options every open uses, the transport that fetches bytes from the main process by range, and the viewer.
// A classic script that adds window.workspaceViewer. pdf.js ships as ES modules only, so it is loaded with import().
(() => {
  const SPAN = 4 * 1048576;
  const PRESETS = ['page-fit', 'page-width'];
  const root = new URL('../../../../node_modules/pdfjs-dist/', location.href).href;

  const loading = import(`${root}build/pdf.mjs`).then(async (lib) => {
    lib.GlobalWorkerOptions.workerSrc = `${root}build/pdf.worker.mjs`;
    return { lib, viewerLib: await import(`${root}web/pdf_viewer.mjs`) };
  });

  // pdf.js answers one request with exactly one onDataRange call, and a request can be the whole file, which the main process
  // serves only 4 MiB at a time, so the pieces are joined here.
  function transport(lib, token, size) {
    const range = new lib.PDFDataRangeTransport(size, null);
    range.requestDataRange = async (begin, end) => {
      const bytes = new Uint8Array(end - begin);
      for (let at = begin; at < end; at += SPAN) bytes.set(await window.workspaceApi.read(token, at, Math.min(end, at + SPAN)), at - begin);
      range.onDataRange(begin, bytes);
    };
    return range;
  }

  // Every getDocument option Pomelo sets, in one place. A file reached by URL would be read whole, so bytes only come through
  // `range`; with the chunk at 64 KiB opening the first page of a 1 GB file reads 7 MB. disableAutoFetch stops the idle worker
  // reading the rest. useWorkerFetch is what lets the worker load the colour profiles and fonts from the local files below.
  function loadOptions(range) {
    return {
      range, rangeChunkSize: 65536, disableAutoFetch: true, disableStream: true, disableRange: false,
      enableScripting: false, isEvalSupported: false, useWorkerFetch: true,
      cMapUrl: `${root}cmaps/`, cMapPacked: true, standardFontDataUrl: `${root}standard_fonts/`, wasmUrl: `${root}wasm/`, iccUrl: `${root}iccs/`,
    };
  }

  // A password is asked for until pdf.js accepts one, five wrong ones in all. The main process hears of it only after pdf.js has
  // accepted it, and the page forgets it.
  async function load(lib, doc) {
    const task = lib.getDocument(loadOptions(transport(lib, doc.token, doc.size)));
    let password = null;
    let wrong = 0;
    let gaveUp = false;
    const abort = () => { gaveUp = true; password = null; task.destroy(); };
    task.onPassword = async (update, reason) => {
      const again = reason === lib.PasswordResponses.INCORRECT_PASSWORD;
      password = !again || ++wrong < 5 ? await window.workspaceDialogs.askPassword(again, abort) : null;
      if (password === null) abort(); else update(password);
    };
    let pdf;
    try {
      pdf = await task.promise;
    } catch (e) {
      throw gaveUp ? Object.assign(new Error('password needed'), { name: 'PasswordException' }) : e;
    } finally {
      window.workspaceDialogs.closePassword();
    }
    if (password !== null) await window.workspaceApi.unlock(doc.token, password);
    password = null;
    return pdf;
  }

  // doc: { token, size } from the main process. The page is drawn into viewerEl, which sits in the absolutely positioned container.
  async function open(doc, container, viewerEl) {
    const { lib, viewerLib } = await loading;
    const pdf = await load(lib, doc);
    const eventBus = new viewerLib.EventBus();
    const linkService = new viewerLib.PDFLinkService({ eventBus });
    const viewer = new viewerLib.PDFViewer({ container, viewer: viewerEl, eventBus, linkService, annotationEditorMode: lib.AnnotationEditorType.DISABLE, removePageBorders: true });
    linkService.setViewer(viewer);
    api.viewer = viewer;
    window.workspaceComments.watch(viewer, eventBus, container);
    window.workspaceDock.watch(viewer, eventBus, container);
    eventBus.on('pagesinit', () => { viewer.currentScaleValue = 'page-fit'; });
    // A fit keeps fitting as the window changes size; a zoom the user chose stays as it is.
    new ResizeObserver(() => { const zoom = viewer.currentScaleValue; if (viewer.pagesCount && PRESETS.includes(zoom)) viewer.currentScaleValue = zoom; }).observe(container);
    let resting = null;
    container.addEventListener('scroll', () => {
      container.classList.add('scrolling');
      clearTimeout(resting);
      resting = setTimeout(() => container.classList.remove('scrolling'), 900);
    }, { passive: true });
    viewer.setDocument(pdf);
    linkService.setDocument(pdf, null);
  }

  const api = { loadOptions, open, viewer: null };
  window.workspaceViewer = api;
})();

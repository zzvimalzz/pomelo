// SPDX-License-Identifier: AGPL-3.0-or-later
// pdf.js in this page: the options every open uses, the transport that fetches bytes from the main process by range, and the viewer.
// A classic script that adds window.workspaceViewer. pdf.js ships as ES modules only, so it is loaded with import().
(() => {
  const SPAN = 4 * 1048576;
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

  // doc: { token, size } from the main process. The page is drawn into viewerEl, which sits in the absolutely positioned container.
  async function open(doc, container, viewerEl) {
    const { lib, viewerLib } = await loading;
    const pdf = await lib.getDocument(loadOptions(transport(lib, doc.token, doc.size))).promise;
    const eventBus = new viewerLib.EventBus();
    const linkService = new viewerLib.PDFLinkService({ eventBus });
    const viewer = new viewerLib.PDFViewer({ container, viewer: viewerEl, eventBus, linkService, annotationEditorMode: lib.AnnotationEditorType.DISABLE, removePageBorders: true });
    linkService.setViewer(viewer);
    const fit = () => { if (viewer.pagesCount) viewer.currentScaleValue = 'page-fit'; };
    eventBus.on('pagesinit', fit);
    new ResizeObserver(fit).observe(container);
    viewer.setDocument(pdf);
    linkService.setDocument(pdf, null);
  }

  window.workspaceViewer = { loadOptions, open };
})();

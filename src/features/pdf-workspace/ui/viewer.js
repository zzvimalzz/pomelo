// SPDX-License-Identifier: AGPL-3.0-or-later
// pdf.js in this page: the options every open uses, the transport that fetches bytes from the main process by range, and the viewer.
// A classic script that adds window.workspaceViewer. pdf.js ships as ES modules only, so it is loaded with import().
(() => {
  const SPAN = 4 * 1048576;
  const PRESETS = ['page-fit', 'page-width'];
  const LAYOUTS = { continuous: 0, spread: 1 };
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

  async function followLink(url) {
    const address = await window.workspaceApi.checkLink(url);
    if (address && await window.workspaceDialogs.confirmLink(address)) window.workspaceApi.openLink(address);
  }

  // A scroll bar shows while its area scrolls and for 0.9 s after, and while the pointer is over it (workspace.css).
  function restScrollbar(area) {
    let resting = null;
    area.addEventListener('scroll', () => {
      area.classList.add('scrolling');
      clearTimeout(resting);
      resting = setTimeout(() => area.classList.remove('scrolling'), 900);
    }, { passive: true });
  }

  let pending = null;
  let sending = null;
  let saved = {};
  function remember(patch) {
    Object.assign(saved, patch);
    pending = { ...pending, ...patch };
    clearTimeout(sending);
    sending = setTimeout(() => { window.workspaceApi.setView(pending); pending = null; }, 300);
  }

  // One viewer serves every tab. The page of the tab on show is set into it, and each module below keeps its own state in step
  // through pdf.js's pagesdestroy and pagesinit. view: the remembered view the main process sent.
  let session = null;
  let restore = {};
  let restoring = false;

  async function start(container, viewerEl, view) {
    const { lib, viewerLib } = await loading;
    saved = { ...view };
    const eventBus = new viewerLib.EventBus();
    const linkService = new viewerLib.PDFLinkService({ eventBus });
    const findController = new viewerLib.PDFFindController({ linkService, eventBus });
    const colours = saved.pageColours ?? 'original';
    // The editor is made with its tools put down. Annotations that are in the file are kept out of it: it would let them be changed with no
    // way to write the change, so they stay as the annotation layer draws them.
    lib.AnnotationLayer.prototype.hasEditableAnnotations = () => false;
    lib.AnnotationLayer.prototype.getEditableAnnotations = () => [];
    const viewer = new viewerLib.PDFViewer({ container, viewer: viewerEl, eventBus, linkService, findController, annotationEditorMode: lib.AnnotationEditorType.NONE, annotationEditorHighlightColors: window.workspaceAnnotate.colours, removePageBorders: true, pageColors: window.workspaceColours.pageColors(colours) });
    window.workspaceColours.watch(viewer, viewerEl, colours, eventBus, lib.OPS);
    linkService.setViewer(viewer);
    // The link never holds the address, so a click, a middle click or a drag takes the page nowhere. pdf.js shows the same for a disabled link.
    linkService.addLinkAttributes = (link, url) => {
      link.href = '';
      link.title = url;
      link.onclick = () => { followLink(url); return false; };
    };
    const history = new viewerLib.PDFHistory({ eventBus, linkService });
    linkService.setHistory(history);
    window.workspaceKeys.bind('back', () => history.back());
    window.workspaceKeys.bind('forward', () => history.forward());
    api.viewer = viewer;
    window.workspaceComments.watch(viewer, eventBus, container);
    window.workspaceDock.watch(viewer, eventBus, container);
    window.workspaceOrganise.watch(viewer, eventBus, container);
    window.workspaceAnnotate.watch(viewer, eventBus, container, lib);
    window.workspaceSidebar.watch(viewer, eventBus, container, linkService, saved.sidebar);
    window.workspaceLinkList.watch(viewer, eventBus, container, followLink);
    window.workspaceSelect.watch(container);
    window.workspaceSearch.watch(viewer, eventBus, container);
    window.workspaceSide.watch(container, { search: window.workspaceResults, links: window.workspaceLinkList });
    // The choices are recorded only after they have been restored, so showing a file does not write what it has just read.
    eventBus.on('pagesinit', () => {
      restoring = true;
      viewer.spreadMode = LAYOUTS[restore.layout ?? saved.layout] ?? 0;
      viewer.currentScaleValue = String(restore.zoom ?? saved.zoom ?? 'page-fit');
      container.scrollTop = restore.top ?? 0;
      restoring = false;
    });
    eventBus.on('scalechanging', ({ scale, presetValue }) => { if (!restoring) remember({ zoom: PRESETS.includes(presetValue) ? presetValue : Math.round(scale * 1000) / 1000 }); });
    eventBus.on('spreadmodechanged', ({ mode }) => { if (!restoring) remember({ layout: Object.keys(LAYOUTS)[mode] }); });
    // A fit keeps fitting as the window changes size; a zoom the user chose stays as it is. Fitting once the size has settled draws
    // the pages once at the end of a panel's slide instead of on every frame of it.
    let fitting = null;
    new ResizeObserver(() => {
      clearTimeout(fitting);
      fitting = setTimeout(() => { const zoom = viewer.currentScaleValue; if (viewer.pagesCount && PRESETS.includes(zoom)) viewer.currentScaleValue = zoom; }, 120);
    }).observe(container);
    restScrollbar(container);
    session = { viewer, linkService, history, container };
  }

  const openDocument = async (doc) => load((await loading).lib, doc);

  function where() {
    const { viewer, container } = session;
    return { zoom: viewer.currentScaleValue, layout: Object.keys(LAYOUTS)[viewer.spreadMode], top: container.scrollTop };
  }

  // pdf: the document of the tab. tabView: { zoom, layout, top } it was left in, empty for a tab not shown before.
  function show(pdf, tabView) {
    const { viewer, linkService, history } = session;
    restore = tabView;
    viewer.setDocument(pdf);
    linkService.setDocument(pdf, null);
    history.initialize({ fingerprint: pdf.fingerprints[0], resetHistory: true });
  }

  function clear() {
    session.viewer.setDocument(null);
    session.linkService.setDocument(null, null);
  }

  const api = { loadOptions, start, openDocument, show, clear, where, remember, restScrollbar, viewer: null };
  window.workspaceViewer = api;
})();

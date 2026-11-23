// SPDX-License-Identifier: AGPL-3.0-or-later
// The colour of the pages: the file's own, sepia, dark, or a page and text colour the user chose. pdf.js draws the pages in the pair
// (its pageColors) and the page records the choice. Pictures keep their own colours: pdf.js recolours the whole canvas in one last
// step, so a page with pictures gets a second layer over the first, drawn in the file's colours and cut to the pictures. A classic
// script that adds window.workspaceColours.
(() => {
  const PRESETS = { sepia: { background: '#f4ecd8', foreground: '#4b3b25' }, dark: { background: '#1e1e20', foreground: '#d8d8dc' } };
  const CLEAR = 'rgba(0,0,0,0)';
  let viewer = null;
  let paper = null;
  let chosen = 'original';
  let pictures = null;
  let onlyPictures = null;
  const layers = new Map();
  const versions = new Map();

  const pair = (choice) => (choice === 'original' ? null : typeof choice === 'string' ? PRESETS[choice] : { background: choice.page, foreground: choice.text });
  const dim = (hex) => (0.2126 * parseInt(hex.slice(1, 3), 16) + 0.7152 * parseInt(hex.slice(3, 5), 16) + 0.0722 * parseInt(hex.slice(5, 7), 16)) / 255 < 0.5;

  // `paper` is pdf.js's viewer element. Its --page-bg-color is what an undrawn page shows, and the class tells workspace.css to
  // colour web links for a dark page.
  function paint() {
    const colours = pair(chosen);
    viewer.pageColors = colours;
    for (let n = 0; n < viewer.pagesCount; n++) viewer.getPageView(n).pageColors = colours;
    if (colours) paper.style.setProperty('--page-bg-color', colours.background); else paper.style.removeProperty('--page-bg-color');
    paper.classList.toggle('dim', !!colours && dim(colours.background));
    if (!colours) for (const n of [...layers.keys()]) drop(n);
  }

  function drop(n) {
    layers.get(n)?.remove();
    layers.delete(n);
  }

  // The layer is the page drawn in the file's own colours, kept only where a picture is: a picture alone is drawn first and its
  // opacity is what the whole page is cut to, so text over a picture stays and paper round a see-through picture does not.
  async function protect(n) {
    const version = (versions.get(n) ?? 0) + 1;
    versions.set(n, version);
    const view = viewer.getPageView(n - 1);
    const wrapper = view.div.querySelector('.canvasWrapper');
    const main = view.canvas;
    if (chosen === 'original' || !wrapper || !main || !view.pdfPage) { drop(n); return; }
    const { fnArray } = await view.pdfPage.getOperatorList();
    if (!fnArray.some((fn) => pictures.has(fn))) { drop(n); return; }
    const draw = async (filter) => {
      const canvas = document.createElement('canvas');
      canvas.width = main.width;
      canvas.height = main.height;
      const viewport = view.viewport.clone({ scale: view.viewport.scale * (main.width / view.viewport.width) });
      await view.pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport, background: CLEAR, annotationMode: 0, optionalContentConfigPromise: view._optionalContentConfigPromise, operationsFilter: filter }).promise;
      return canvas;
    };
    const only = await draw(onlyPictures);
    const layer = await draw(null);
    const ctx = layer.getContext('2d');
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(only, 0, 0);
    only.width = only.height = 0;
    if (versions.get(n) !== version || view.canvas !== main || chosen === 'original') { layer.width = layer.height = 0; return; }
    drop(n);
    layer.style.width = main.style.width;
    layer.style.height = main.style.height;
    wrapper.append(layer);
    layers.set(n, layer);
  }

  // `ops` is pdf.js's OPS table. The picture-only pass runs what sets the state a picture is drawn in (the matrix, the clip, groups,
  // hidden layers) and the picture operators, and skips everything that paints.
  function watch(pdfViewer, viewerElement, choice, eventBus, ops) {
    viewer = pdfViewer;
    paper = viewerElement;
    chosen = choice;
    pictures = new Set([ops.paintImageXObject, ops.paintInlineImageXObject, ops.paintInlineImageXObjectGroup, ops.paintImageXObjectRepeat]);
    const state = new Set([ops.save, ops.restore, ops.transform, ops.setGState, ops.clip, ops.eoClip, ops.dependency, ops.paintFormXObjectBegin, ops.paintFormXObjectEnd, ops.beginGroup, ops.endGroup,
      ops.beginMarkedContent, ops.beginMarkedContentProps, ops.endMarkedContent, ops.beginCompat, ops.endCompat]);
    onlyPictures = (i, list) => {
      const fn = list.fnArray[i];
      return pictures.has(fn) || state.has(fn) || (fn === ops.constructPath && list.argsArray[i][0] === ops.endPath);
    };
    eventBus.on('pagerendered', ({ pageNumber, cssTransform }) => { if (!cssTransform) protect(pageNumber); });
    eventBus.on('scalechanging', () => {
      for (const [n, layer] of layers) {
        const main = viewer.getPageView(n - 1).canvas;
        if (main) { layer.style.width = main.style.width; layer.style.height = main.style.height; }
      }
    });
    paint();
  }

  function set(choice) {
    if (JSON.stringify(choice) === JSON.stringify(chosen)) return;
    chosen = choice;
    paint();
    viewer.refresh();
    window.workspaceViewer.remember({ pageColours: choice });
  }

  async function choose() {
    const colours = await window.workspaceDialogs.chooseColours(typeof chosen === 'object' ? chosen : null);
    if (colours) set(colours);
  }

  window.workspaceColours = { pageColors: pair, watch, set, choose, current: () => chosen };
})();

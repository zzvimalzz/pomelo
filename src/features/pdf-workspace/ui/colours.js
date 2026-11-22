// SPDX-License-Identifier: AGPL-3.0-or-later
// The colour of the pages: the file's own, sepia, dark, or a page and text colour the user chose. pdf.js draws the pages in the pair
// (its pageColors) and the page records the choice. A classic script that adds window.workspaceColours.
(() => {
  const PRESETS = { sepia: { background: '#f4ecd8', foreground: '#4b3b25' }, dark: { background: '#1e1e20', foreground: '#d8d8dc' } };
  let viewer = null;
  let paper = null;
  let chosen = 'original';

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
  }

  function watch(pdfViewer, viewerElement, choice) {
    viewer = pdfViewer;
    paper = viewerElement;
    chosen = choice;
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

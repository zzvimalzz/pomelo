// SPDX-License-Identifier: AGPL-3.0-or-later
// Focus reading: the window goes full screen and only the pages stay. The title row returns at the top edge and the dock at the bottom
// edge, and both leave again with the pointer. The main process owns the full-screen state and says when it changes. A classic script.
(() => {
  const { icon } = window.pomeloUi;
  const { label, bind } = window.workspaceKeys;
  const TOP = 56;
  const DOCK_EDGE = 120;
  const body = document.body;
  const button = document.getElementById('focus');
  const on = () => body.classList.contains('focus');

  function paint(entered) {
    body.classList.toggle('focus', entered);
    body.classList.remove('reveal-top', 'reveal-dock');
    const text = entered ? 'Leave focus reading' : 'Focus reading';
    button.innerHTML = icon(entered ? 'shrink' : 'expand');
    button.title = `${text} (${label(entered ? 'escape' : 'focusReading')})`;
    button.setAttribute('aria-label', text);
    button.setAttribute('aria-pressed', String(entered));
  }

  // Fit page is the natural zoom here; what the user had comes back when focus reading ends.
  let before = null;
  function render(entered) {
    if (entered === on()) return;
    paint(entered);
    const viewer = window.workspaceViewer.viewer;
    if (!viewer) return;
    if (entered) { before = viewer.currentScaleValue; viewer.currentScaleValue = 'page-fit'; }
    else if (before) { viewer.currentScaleValue = before; before = null; }
  }

  const toggle = () => window.workspaceApi.focus(!on());
  button.onclick = toggle;
  bind('focusReading', toggle);
  bind('escape', () => (on() ? (window.workspaceApi.focus(false), true) : false));
  window.workspaceApi.onFocus(render);
  paint(false);

  document.addEventListener('pointermove', (e) => {
    if (!on()) return;
    body.classList.toggle('reveal-top', e.clientY < TOP || !!e.target.closest('.titlerow'));
    const edge = window.workspaceDockPlace.edgeDistance(e, { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight });
    body.classList.toggle('reveal-dock', edge < DOCK_EDGE || !!e.target.closest('.dock'));
  });
  document.documentElement.addEventListener('mouseleave', () => body.classList.remove('reveal-top', 'reveal-dock'));
})();

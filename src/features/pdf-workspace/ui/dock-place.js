// SPDX-License-Identifier: AGPL-3.0-or-later
// Where the dock stands: at the bottom, top, left or right middle of the document area. The grip at its start end is dragged, or moved
// with the arrow keys, and the dock settles on the nearest of the four places. A classic script that adds window.workspaceDockPlace.
(() => {
  const { el } = window.pomeloUi;
  const SIDES = ['bottom', 'top', 'left', 'right'];
  const KEYS = { ArrowDown: 'bottom', ArrowUp: 'top', ArrowLeft: 'left', ArrowRight: 'right' };
  const area = () => document.querySelector('.well');
  const calm = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // How far the pointer is from the edge of `box` that the dock stands at.
  function edgeDistance(e, box) {
    return { bottom: box.bottom - e.clientY, top: e.clientY - box.top, left: e.clientX - box.left, right: box.right - e.clientX }[area().dataset.dock];
  }

  function nearest(x, y, width, height) {
    const away = { bottom: [x - width / 2, y - height], top: [x - width / 2, y], left: [x, y - height / 2], right: [x - width, y - height / 2] };
    return SIDES.reduce((best, side) => (Math.hypot(...away[side]) < Math.hypot(...away[best]) ? side : best));
  }

  // Puts the dock at `side` and eases it over from where it was, then tells the main process so the place is kept.
  function settleAt(dock, side) {
    const from = dock.getBoundingClientRect();
    dock.classList.remove('dragging');
    dock.style.left = '';
    dock.style.top = '';
    const changed = side !== area().dataset.dock;
    area().dataset.dock = side;
    const to = dock.getBoundingClientRect();
    if (!calm()) {
      const move = `translate(${from.left + from.width / 2 - to.left - to.width / 2}px, ${from.top + from.height / 2 - to.top - to.height / 2}px)`;
      const glide = dock.animate([{ transform: move }, { transform: 'none' }], { duration: 480, easing: 'cubic-bezier(.22, 1, .36, 1)' });
      dock.classList.add('placing');
      glide.onfinish = glide.oncancel = () => dock.classList.remove('placing');
    }
    if (changed) window.workspaceApi.setDock(side);
  }

  function attach(dock, grip, start) {
    grip.addEventListener('pointerdown', (down) => {
      if (down.button !== 0) return;
      down.preventDefault();
      start();
      const bounds = area().getBoundingClientRect();
      const box = dock.getBoundingClientRect();
      const grabX = down.clientX - box.left;
      const grabY = down.clientY - box.top;
      const spots = SIDES.map((side) => [side, el('div', `snap ${side}`)]);
      area().append(...spots.map(([, spot]) => spot));
      grip.setPointerCapture(down.pointerId);
      dock.classList.add('dragging');
      let side = null;

      const follow = (move) => {
        dock.style.left = `${Math.min(Math.max(move.clientX - bounds.left - grabX, 0), bounds.width - box.width)}px`;
        dock.style.top = `${Math.min(Math.max(move.clientY - bounds.top - grabY, 0), bounds.height - box.height)}px`;
        side = nearest(move.clientX - bounds.left, move.clientY - bounds.top, bounds.width, bounds.height);
        for (const [name, spot] of spots) spot.classList.toggle('on', name === side);
      };
      const drop = () => {
        grip.removeEventListener('pointermove', follow);
        grip.removeEventListener('pointerup', drop);
        grip.removeEventListener('pointercancel', drop);
        for (const [, spot] of spots) spot.remove();
        settleAt(dock, side);
      };
      grip.addEventListener('pointermove', follow);
      grip.addEventListener('pointerup', drop);
      grip.addEventListener('pointercancel', drop);
      follow(down);
    });
    grip.addEventListener('keydown', (e) => {
      const side = KEYS[e.key];
      if (!side) return;
      e.preventDefault();
      if (side !== area().dataset.dock) { start(); settleAt(dock, side); }
    });
  }

  window.workspaceDockPlace = { attach, edgeDistance };
})();

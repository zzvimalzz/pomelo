// SPDX-License-Identifier: AGPL-3.0-or-later
// A card over a veil, for the windows' questions. frame(host) puts one inside an element and makes everything round it inert; loop keeps
// Tab inside the card. A classic script that adds window.pomeloCard.
(() => {
  const { el } = window.pomeloUi;

  // The card is labelled by the element whose id is dialog-title. While it is up everything round it is inert, so nothing behind it
  // can be clicked, selected or scrolled, and close() gives that back (a folded dock stays inert).
  function frame(host) {
    const box = el('div', 'card');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'dialog-title');
    const veil = el('div', 'veil');
    veil.append(box);
    veil.addEventListener('mousedown', (e) => { if (e.target === veil) e.preventDefault(); });
    host.append(veil);
    const idle = [];
    for (let n = veil; n !== document.body; n = n.parentElement) {
      for (const other of n.parentElement.children) if (other !== n && !other.inert) { other.inert = true; idle.push(other); }
    }
    const close = () => { veil.remove(); for (const n of idle) n.inert = false; };
    return { box, close };
  }

  function loop(e, stops) {
    const live = stops.filter((s) => !s.disabled);
    const next = live[(live.indexOf(document.activeElement) + (e.shiftKey ? -1 : 1) + live.length) % live.length];
    e.preventDefault();
    next.focus();
  }

  window.pomeloCard = { frame, loop, isOpen: () => !!document.querySelector('[aria-modal="true"]') };
})();

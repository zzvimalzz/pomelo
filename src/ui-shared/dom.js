// SPDX-License-Identifier: AGPL-3.0-or-later
// Helpers the windows' pages share. A classic script: it adds window.pomeloUi.

window.pomeloUi = {
  // A new element with an optional class and text.
  el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  },
};

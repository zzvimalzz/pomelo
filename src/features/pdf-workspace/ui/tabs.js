// SPDX-License-Identifier: AGPL-3.0-or-later
// The row of tabs that takes the place of the file name in the title row once more than one PDF is open. A tab selects, its cross
// closes, and Left, Right, Home and End move along the row while Delete closes the tab that has the focus. File names are only ever
// set as text. A classic script that adds window.workspaceTabs.
(() => {
  const { el, icon } = window.pomeloUi;
  const strip = document.getElementById('tabs');
  let on = { select: () => {}, close: () => {} };

  // docs: [{ token, name, dirty }] in order, active: the token on show. The strip is hidden while there is only one. A name is followed
  // by a dot while its document has changes that are not saved.
  function render(docs, active) {
    const focused = strip.contains(document.activeElement);
    strip.hidden = docs.length < 2;
    strip.replaceChildren(...docs.map(({ token, name, dirty }) => {
      const tab = el('div', token === active ? 'tab on' : 'tab');
      tab.dataset.token = token;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(token === active));
      tab.tabIndex = token === active ? 0 : -1;
      tab.title = name;
      const cross = el('button', 'x');
      cross.type = 'button';
      cross.tabIndex = -1;
      cross.title = 'Close';
      cross.setAttribute('aria-label', `Close ${name}`);
      cross.innerHTML = icon('close');
      tab.append(el('span', '', name));
      if (dirty) {
        const dot = el('i', 'dot');
        dot.title = 'Unsaved changes';
        tab.append(dot);
      }
      tab.append(cross);
      return tab;
    }));
    if (focused) strip.querySelector('.on')?.focus();
  }

  const tokenOf = (e) => e.target.closest('.tab')?.dataset.token;

  strip.addEventListener('click', (e) => {
    const token = tokenOf(e);
    if (token) (e.target.closest('.x') ? on.close : on.select)(token);
  });
  // A click on a tab must not take the keys from the document.
  strip.addEventListener('mousedown', (e) => e.preventDefault());
  strip.addEventListener('keydown', (e) => {
    const tabs = [...strip.children];
    const here = tabs.findIndex((t) => t === e.target.closest('.tab'));
    if (here < 0) return;
    const to = { ArrowLeft: here - 1, ArrowRight: here + 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (e.key === 'Delete') on.close(tabs[here].dataset.token);
    else if (to !== undefined && tabs[to]) on.select(tabs[to].dataset.token);
    else if (e.key === 'Enter' || e.key === ' ') on.select(tabs[here].dataset.token);
    else return;
    e.preventDefault();
  });

  window.workspaceTabs = { render, bind: (handlers) => { on = handlers; } };
})();

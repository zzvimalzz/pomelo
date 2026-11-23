// SPDX-License-Identifier: AGPL-3.0-or-later
// The panel on the right, with its Search and Links tabs: it slides open and shut, switches between the two views and tells whoever
// asked what changed. Choosing the Search tab opens the find bar, which is search.js's; a search shows its hits here. A classic script
// that adds window.workspaceSide.
(() => {
  const { icon } = window.pomeloUi;
  const SLIDE = 350;
  const panel = document.getElementById('hitpanel');
  const inner = document.getElementById('hitinner');
  const closer = document.getElementById('hitclose');
  const tabs = { search: document.getElementById('tabsearch'), links: document.getElementById('tablinks') };
  const views = { search: document.getElementById('searchview'), links: document.getElementById('linksview') };
  const listeners = [];
  let open = false;
  let tab = 'search';
  let closing = null;

  closer.innerHTML = icon('close');
  closer.title = 'Hide panel';
  closer.setAttribute('aria-label', 'Hide panel');

  // modules: { search, links }, the scripts that fill the two views, each with show(on) for when its view is on show or not.
  function watch(container, modules) {
    function render() {
      for (const name of Object.keys(tabs)) {
        tabs[name].setAttribute('aria-checked', String(name === tab));
        views[name].hidden = name !== tab;
        modules[name].show(open && name === tab);
      }
      for (const fn of listeners) fn(open, tab);
    }

    // The Search tab belongs with the find bar: asking for it, by the tab or by a search, opens the bar as well, and the Links tab closes
    // it. The field keeps what was typed, so the Search tab brings the last search back.
    function openTab(name) {
      clearTimeout(closing);
      const order = Object.keys(tabs);
      if (open && name !== tab) panel.dataset.turn = order.indexOf(name) > order.indexOf(tab) ? 'next' : 'prev';
      else delete panel.dataset.turn;
      open = true;
      tab = name;
      inner.hidden = false;
      panel.classList.add('open');
      render();
      if (name === 'search') window.workspaceSearch.reveal(); else window.workspaceSearch.conceal();
    }

    function shut() {
      if (!open) return;
      open = false;
      panel.classList.remove('open');
      closing = setTimeout(() => { inner.hidden = true; }, SLIDE);
      render();
    }

    for (const name of Object.keys(tabs)) tabs[name].onclick = () => openTab(name);
    closer.onclick = shut;
    for (const b of [closer, ...Object.values(tabs)]) b.addEventListener('mousedown', (e) => e.preventDefault());
    window.workspaceKeys.bind('escape', () => {
      if (!open || !panel.contains(document.activeElement)) return false;
      shut();
      container.focus();
      return true;
    });
    api.open = (name) => { if (!open || tab !== name) openTab(name); };
    api.toggle = (name) => (open && tab === name ? shut() : openTab(name));
    api.shutTab = (name) => { if (open && tab === name) shut(); };
    api.pairSearch = () => {
      if (!open || tab !== 'links') return false;
      openTab('search');
      return true;
    };
  }

  const api = { watch, open: () => {}, toggle: () => {}, shutTab: () => {}, pairSearch: () => false, onchange: (fn) => listeners.push(fn) };
  window.workspaceSide = api;
})();

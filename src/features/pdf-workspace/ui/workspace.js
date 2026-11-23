// SPDX-License-Identifier: AGPL-3.0-or-later
// The workspace page: asks the main process which documents the window was opened for, keeps one tab for each, and shows the tab
// on show in the one viewer. A tab that is not on show keeps its pdf.js document but holds no drawn pages.
(async () => {
  if (new URLSearchParams(location.search).has('solid')) document.documentElement.classList.add('solid');
  const viewer = window.workspaceViewer;
  const failure = document.getElementById('failure');
  const name = document.getElementById('docname');
  const tabs = [];
  let active = null;
  let turn = 0;

  const find = (token) => tabs.find((t) => t.doc.token === token);

  function drawTabs() {
    name.hidden = tabs.length > 1;
    window.workspaceTabs.render(tabs.map((t) => t.doc), active?.doc.token);
  }

  function showFailure(tab) {
    viewer.clear();
    failure.textContent = tab.error === 'locked' ? 'This file is password-protected' : 'This file is damaged or is not a PDF';
    if (tab.error === 'locked') {
      const unlock = window.pomeloUi.el('button', 'btn primary', 'Unlock');
      unlock.onclick = () => { tab.error = null; display(tab); };
      failure.append(unlock);
    }
    failure.hidden = false;
  }

  function put(tab) {
    viewer.show(tab.pdf, tab.left);
    tab.shown = true;
  }

  async function display(tab) {
    const mine = ++turn;
    failure.hidden = true;
    if (tab.error) { showFailure(tab); return; }
    if (tab.pdf) { put(tab); return; }
    viewer.clear();
    let pdf;
    try {
      pdf = await viewer.openDocument(tab.doc);
    } catch (e) {
      if (mine === turn && tabs.includes(tab)) {
        tab.error = e && e.name === 'PasswordException' ? 'locked' : 'damaged';
        showFailure(tab);
      }
      return;
    }
    if (!tabs.includes(tab)) { pdf.destroy(); return; }
    tab.pdf = pdf;
    if (mine === turn) put(tab);
  }

  function activate(tab) {
    if (tab === active) return;
    if (active?.shown) {
      active.left = viewer.where();
      active.shown = false;
    }
    active = tab;
    name.textContent = tab.doc.name;
    document.title = `${tab.doc.name} - Pomelo`;
    drawTabs();
    display(tab);
  }

  function add(doc) {
    const tab = { doc, pdf: null, left: {}, shown: false, error: null };
    tabs.push(tab);
    return tab;
  }

  function close(token) {
    const at = tabs.findIndex((t) => t.doc.token === token);
    if (at < 0) return;
    const [tab] = tabs.splice(at, 1);
    window.workspaceApi.close(token);
    if (tab === active) {
      active = null;
      if (tabs.length) activate(tabs[Math.min(at, tabs.length - 1)]);
    } else drawTabs();
    tab.pdf?.destroy();
  }

  window.workspaceTabs.bind({ select: (token) => activate(find(token)), close });

  // Files opened while the window is still starting wait for it, so none is lost between the first state and this listener.
  const ready = (async () => {
    const { documents, dock, view } = await window.workspaceApi.state();
    document.querySelector('.well').dataset.dock = dock;
    await viewer.start(document.getElementById('scroller'), document.getElementById('viewer'), view);
    for (const doc of documents) add(doc);
    if (tabs.length) activate(tabs[0]);
  })();

  // The first of the files just opened is shown, unless a card is asking something about the one on show.
  window.workspaceApi.onOpened((docs) => ready.then(() => {
    const shown = docs.map((doc) => find(doc.token) ?? add(doc));
    drawTabs();
    if (shown.length && !window.workspaceDialogs.isOpen()) activate(shown[0]);
  }));
})();

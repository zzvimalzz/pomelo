// SPDX-License-Identifier: AGPL-3.0-or-later
// The workspace page: asks the main process which documents the window was opened for, keeps one tab for each, and shows the tab
// on show in the one viewer. A tab that is not on show keeps its pdf.js document but holds no drawn pages. It also carries the
// Save button and the questions about unsaved changes.
(async () => {
  if (new URLSearchParams(location.search).has('solid')) document.documentElement.classList.add('solid');
  const viewer = window.workspaceViewer;
  const failure = document.getElementById('failure');
  const name = document.getElementById('docname');
  const line = document.getElementById('nameline');
  const dot = document.getElementById('docdot');
  const savedNote = document.getElementById('docsaved');
  const saveButton = document.getElementById('savebtn');
  const { choose, isOpen } = window.workspaceDialogs;
  const tabs = [];
  let active = null;
  let turn = 0;

  // The loading task owns the document's memory: a document proxy has no destroy of its own.
  const release = (pdf) => pdf?.loadingTask.destroy();
  const find = (token) => tabs.find((t) => t.doc.token === token);

  function drawTabs() {
    line.hidden = tabs.length > 1;
    window.workspaceTabs.render(tabs.map((t) => t.doc), active?.doc.token);
    dot.hidden = saveButton.hidden = !active?.doc.dirty;
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

  // The pages are read again from the revision the main process now has, in the place the tab was left.
  function reopen(tab) {
    if (tab === active && tab.shown) { tab.left = viewer.where(); viewer.clear(); }
    tab.shown = false;
    release(tab.pdf);
    tab.pdf = null;
    tab.error = null;
    if (tab === active) display(tab);
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
    if (!tabs.includes(tab)) { release(pdf); return; }
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
    savedNote.classList.remove('on');
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
    release(tab.pdf);
  }

  // Saves the tab's document over its file, or as a copy. The first save over a file asks once whether to replace it. Resolves true
  // when what was asked is done, false when it was not (the user said no, or the main process said why in the corner notice).
  async function save(tab, copy = false) {
    const { token, name: file } = tab.doc;
    if (!copy && !tab.replaceAsked) {
      const answer = await choose('Replace the original?', `Save over ${file}, or keep it as it is and save a copy.`, [{ label: 'Cancel', value: null }, { label: 'Save a copy', value: 'copy' }, { label: 'Replace', value: 'replace', primary: true }]);
      if (!answer) return false;
      if (answer === 'copy') return save(tab, true);
      tab.replaceAsked = true;
    }
    const result = await (copy ? window.workspaceApi.saveAs(token) : window.workspaceApi.save(token));
    if (result?.stop === 'changed') {
      const answer = await choose(`${file} was changed by another program.`, '', [{ label: 'Cancel', value: null }, { label: 'Reload', value: 'reload' }, { label: 'Save a copy', value: 'copy', primary: true }]);
      if (answer === 'reload') await window.workspaceApi.reload(token);
      return answer === 'copy' ? save(tab, true) : false;
    }
    if (!result || result.stop) return false;
    if (!copy && tab === active) {
      savedNote.textContent = 'Saved';
      savedNote.classList.add('on');
      clearTimeout(tab.savedTimer);
      tab.savedTimer = setTimeout(() => savedNote.classList.remove('on'), 1400);
    }
    return true;
  }

  // Resolves true when the tab's changes are saved or given up, false when the user cancels or saving fails.
  async function settle(tab) {
    const answer = await choose(`Save changes to ${tab.doc.name}?`, '', [{ label: 'Cancel', value: null }, { label: "Don't save", value: 'discard' }, { label: 'Save', value: 'save', primary: true }]);
    return answer === 'discard' || (answer === 'save' && save(tab));
  }

  async function closeTab(token) {
    const tab = find(token);
    if (tab && (!tab.doc.dirty || await settle(tab))) close(token);
  }

  window.workspaceTabs.bind({ select: (token) => activate(find(token)), close: closeTab });
  saveButton.title = `Save (${window.workspaceKeys.label('save')})`;
  saveButton.onclick = () => active && save(active);
  window.workspaceKeys.bind('save', () => { if (!active?.doc.dirty) return false; save(active); });
  window.workspaceKeys.bind('saveCopy', () => { if (!active) return false; save(active, true); });

  window.workspaceApi.onChanged(({ reload, ...doc }) => {
    const tab = find(doc.token);
    if (!tab) return;
    tab.doc = doc;
    drawTabs();
    if (reload) reopen(tab);
  });

  // The window was asked to close while a document has changes: each of those is asked about in turn, and the window goes only when
  // none was cancelled.
  let leaving = false;
  window.workspaceApi.onClosing(async () => {
    if (leaving || isOpen()) return;
    leaving = true;
    let go = true;
    for (const tab of tabs.filter((t) => t.doc.dirty)) {
      activate(tab);
      if (!(go = await settle(tab))) break;
    }
    leaving = false;
    if (go) window.workspaceApi.closeWindow();
  });

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

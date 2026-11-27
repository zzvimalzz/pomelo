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
  const { choose, chooseFormat, isOpen } = window.workspaceDialogs;
  const tabStrip = window.pomeloTabs.create(document.getElementById('tabs'));
  const tabs = [];
  let active = null;
  let turn = 0;

  // The loading task owns the document's memory: a document proxy has no destroy of its own.
  const release = (pdf) => pdf?.loadingTask.destroy();
  const find = (token) => tabs.find((t) => t.doc.token === token);

  function drawTabs() {
    line.hidden = tabs.length > 1;
    tabStrip.render(tabs.map((t) => t.doc), active?.doc.token);
    dot.hidden = saveButton.hidden = !active?.doc.dirty;
  }

  function showFailure(tab) {
    window.workspaceOrganise.leave();
    window.workspaceDock.hide();
    viewer.clear();
    window.workspaceProperties.show(null);
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
    window.workspaceOrganise.use(tab);
    viewer.show(tab.pdf, tab.left);
    tab.shown = true;
    window.workspaceProperties.show(tab);
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

  function showName(tab) {
    name.textContent = tab.doc.name;
    document.title = `${tab.doc.name} - Pomelo`;
  }

  function activate(tab) {
    if (tab === active) return;
    if (active?.shown) {
      active.left = viewer.where();
      active.shown = false;
    }
    window.workspaceOrganise.leave();
    active = tab;
    showName(tab);
    savedNote.classList.remove('on');
    window.workspaceProperties.show(null);
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

  // Saves the tab's document over its file, or as a copy. The first save over a file asks once whether to replace it. A copy is opened
  // in a tab and this document is closed, unless the window is closing (`closing`). Resolves the token of the document that now holds
  // what was saved (the copy's, after a copy), or null when it was not done (the user said no, or the main process said why in the corner
  // notice).
  async function save(tab, copy = false, closing = false) {
    const { token, name: file } = tab.doc;
    if (!copy && !tab.replaceAsked) {
      const answer = await choose('Replace the original?', `Save over ${file}, or keep it as it is and save a copy.`, [{ label: 'Cancel', value: null }, { label: 'Save a copy', value: 'copy' }, { label: 'Replace', value: 'replace', primary: true }]);
      if (!answer) return null;
      if (answer === 'copy') return save(tab, true, closing);
      tab.replaceAsked = true;
    }
    const result = await (copy ? window.workspaceApi.saveAs(token, !closing) : window.workspaceApi.save(token));
    if (result?.stop === 'changed') {
      const answer = await choose(`${file} was changed by another program.`, '', [{ label: 'Cancel', value: null }, { label: 'Reload', value: 'reload' }, { label: 'Save a copy', value: 'copy', primary: true }]);
      if (answer === 'reload') await window.workspaceApi.reload(token);
      return answer === 'copy' ? save(tab, true, closing) : null;
    }
    if (!result || result.stop) return null;
    if (result.copied) close(token);
    if (!copy && tab === active) {
      savedNote.textContent = 'Saved';
      savedNote.classList.add('on');
      clearTimeout(tab.savedTimer);
      tab.savedTimer = setTimeout(() => savedNote.classList.remove('on'), 1400);
    }
    return result.copyToken ?? token;
  }

  // Asks which format, then converts the tab's file, which the converter reads from disk: changes are saved first, and a copy made for
  // that is the file converted.
  async function convert(tab) {
    const targets = await window.workspaceApi.convertTargets(tab.doc.token);
    const to = targets.length ? await chooseFormat(targets) : null;
    if (!to) return;
    let token = tab.doc.token;
    if (tab.doc.dirty) {
      const answer = await choose('Save your changes before converting?', '', [{ label: 'Cancel', value: null }, { label: 'Save a copy', value: 'copy' }, { label: 'Save', value: 'save', primary: true }]);
      token = answer && await save(tab, answer === 'copy');
      if (!token) return;
    }
    window.workspaceApi.convert(token, to);
  }

  // Resolves true when the tab's changes are saved or given up, false when the user cancels or saving fails.
  async function settle(tab) {
    const answer = await choose(`Save changes to ${tab.doc.name}?`, '', [{ label: 'Cancel', value: null }, { label: "Don't save", value: 'discard' }, { label: 'Save', value: 'save', primary: true }]);
    return answer === 'discard' || (answer === 'save' && save(tab, false, true));
  }

  async function closeTab(token) {
    const tab = find(token);
    if (tab && (!tab.doc.dirty || await settle(tab))) close(token);
  }

  tabStrip.bind({ select: (token) => activate(find(token)), close: closeTab });
  name.onclick = () => window.workspaceProperties.open();
  saveButton.title = `Save (${window.workspaceKeys.label('save')})`;
  saveButton.onclick = () => active && save(active);
  window.workspaceKeys.bind('save', () => { if (!active?.doc.dirty) return false; save(active); });
  window.workspaceKeys.bind('saveCopy', () => { if (!active) return false; save(active, true); });
  window.workspaceDock.setMore([
    { text: 'Convert to…', arrow: true, run: () => active && convert(active) },
    { text: 'Save a copy', key: 'saveCopy', run: () => active && save(active, true) },
  ]);

  window.workspaceApi.onChanged(({ reload, ...doc }) => {
    const tab = find(doc.token);
    if (!tab) return;
    tab.doc = doc;
    if (tab === active) showName(tab);
    drawTabs();
    if (reload) reopen(tab);
    else if (tab === active && tab.shown) { window.workspaceProperties.show(tab); window.workspaceOrganise.use(tab); }
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

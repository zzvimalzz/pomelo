// SPDX-License-Identifier: AGPL-3.0-or-later
// The editor page: asks the main process which pictures the window was opened for, reads the pixels of each, keeps one tab for each and
// shows the tab on show in the well. It also runs the tool switch of the panel, the edits and their history, and saving.
(async () => {
  if (new URLSearchParams(location.search).has('solid')) document.documentElement.classList.add('solid');
  const api = window.editorApi;
  const view = window.editorView;
  const geometry = window.editorGeometry;
  const { bind, label } = window.editorKeys;
  const { choose, saveCopy } = window.editorDialogs;
  const { icon, el } = window.pomeloUi;
  const $ = (id) => document.getElementById(id);
  const name = $('imgname');
  const line = $('nameline');
  const dot = $('imgdot');
  const savedNote = $('imgsaved');
  const saveButton = $('savebtn');
  const undoButton = $('undo');
  const redoButton = $('redo');
  const compare = $('compare');
  const tabStrip = window.pomeloTabs.create($('tabs'));
  const tabs = [];
  let active = null;

  const state = await api.state();
  const piece = state.piece;
  const qualities = state.quality;

  const find = (token) => tabs.find((t) => t.token === token);

  function fill(button, glyph, text, keyId) {
    button.innerHTML = icon(glyph);
    button.title = keyId ? `${text} (${label(keyId)})` : text;
    button.setAttribute('aria-label', text);
  }

  const resetButton = $('cropreset');
  resetButton.title = 'Reset';
  let cropping = false;

  const edited = (g) => ({ ...active.edit, geometry: { ...g, crop: geometry.tidy(g.crop) } });
  const crop = window.editorCrop.create({
    tab: () => active,
    live: (g) => { active.edit = edited(g); view.redraw(); paintGeometry(); },
    commit: (g, key) => commit(edited(g), key),
  });

  const adjust = window.editorAdjust.create({
    tab: () => active,
    live: (patch) => { active.edit = { ...active.edit, ...patch }; view.redraw(); adjust.paint(); },
    commit: (edit, key) => commit(edit, key),
    sample: view.sample,
    open: new Set(state.view.sections ?? ['light', 'colour']),
    remember: (sections) => api.setView({ sections }),
  });
  const settleEdits = () => { crop.settle(); adjust.settle(); };

  function paintGeometry() {
    resetButton.disabled = !active || geometry.isNeutral(active.edit.geometry);
    crop.paint();
  }

  function refresh() {
    const history = active?.history;
    undoButton.disabled = !history?.canUndo();
    redoButton.disabled = !history?.canRedo();
    compare.disabled = !history || history.isNeutral();
    paintGeometry();
    adjust.paint();
    const changed = !!history?.dirty();
    dot.hidden = saveButton.hidden = !changed;
    line.hidden = tabs.length > 1;
    name.textContent = active?.name ?? '';
    tabStrip.render(tabs.map((t) => ({ token: t.token, name: t.name, dirty: t.history.dirty() })), active?.token);
    if (active && changed !== active.reported) { active.reported = changed; api.setDirty(active.token, changed); }
  }

  // The pixels come in pieces, so no single message holds either process for long. The main process lets go of its copy when told.
  async function read(info) {
    const pixels = new Uint8Array(info.width * info.height * 4);
    for (let at = 0; at < pixels.length; at += piece) pixels.set(await api.pixels(info.token, at, Math.min(at + piece, pixels.length)), at);
    await api.pixelsDone(info.token);
    return pixels;
  }

  // Shows a tab once its pixels are here; a tab that was closed or replaced as the one on show meanwhile is left alone.
  async function activate(tab) {
    settleEdits();
    active = tab;
    if (cropping) crop.begin();
    savedNote.classList.remove('on');
    refresh();
    await tab.loading;
    if (active !== tab || !tabs.includes(tab)) return;
    const first = !tabs.some((t) => t.shownBefore);
    tab.shownBefore = true;
    view.show(tab, first ? 'first' : 'switch');
    adjust.edited();
  }

  function close(token) {
    const tab = find(token);
    if (!tab) return;
    const at = tabs.indexOf(tab);
    tabs.splice(at, 1);
    view.dispose(tab);
    api.close(token);
    if (active === tab) {
      active = null;
      if (tabs.length) activate(tabs[Math.min(at, tabs.length - 1)]);
      else view.show(null);
    }
    refresh();
  }

  function add(info) {
    const history = window.editorModel.createHistory();
    const tab = { ...info, history, edit: history.current(), reported: false, replaceAsked: false, saving: false, pixels: null, texture: null, view: { fit: true, zoom: 1, panX: 0, panY: 0 }, shownBefore: false };
    tab.loading = read(info).then((pixels) => { tab.pixels = pixels; }, () => close(info.token));
    tabs.push(tab);
    return tab;
  }

  function open(images) {
    const shown = images.map((info) => find(info.token) ?? add(info));
    if (shown.length) activate(shown[shown.length - 1]);
  }

  // A crop drag ends, a frame still easing to a new shape arrives, and a slider moved with the keys is done, before the next change
  // starts from it.
  const ready = () => { settleEdits(); return !!active?.texture && !window.pomeloCard.isOpen(); };

  // Changes with the same key in a row fold into one undo step.
  function commit(edit, key, how) {
    view.change(() => { active.history.commit(edit, key); active.edit = active.history.current(); }, how);
    refresh();
  }
  const turn = (dir) => { if (ready()) commit({ ...active.edit, geometry: geometry.rotate(active.edit.geometry, dir) }, 'rotate', { turn: dir }); };
  const flip = (axis) => { if (ready()) commit({ ...active.edit, geometry: geometry.flip(active.edit.geometry, axis) }, `flip-${axis}`, { flip: axis }); };
  const resetAll = () => { if (ready()) commit(window.editorModel.neutral(), null); };
  function step(way) {
    if (!ready()) return;
    view.change(() => { active.history[way](); active.edit = active.history.current(); });
    refresh();
  }

  fill(undoButton, 'undo', 'Undo', 'undo');
  fill(redoButton, 'redo', 'Redo', 'redo');
  undoButton.onclick = () => step('undo');
  redoButton.onclick = () => step('redo');
  bind('undo', () => (active ? step('undo') : false));
  bind('redo', () => (active ? step('redo') : false));
  bind('rotateLeft', () => (active ? turn(-1) : false));
  bind('rotateRight', () => (active ? turn(1) : false));
  bind('compare', () => { if (compare.disabled) return false; view.setCompare(true); });
  window.addEventListener('keyup', (e) => { if (e.key === '\\') view.setCompare(false); });

  const cropButton = $('cropbtn');
  fill(cropButton, 'crop', 'Crop', 'crop');
  const four = [];
  for (const [glyph, text, keyId, run] of [['rotl', 'Rotate left', 'rotateLeft', () => turn(-1)], ['rotr', 'Rotate right', 'rotateRight', () => turn(1)], ['fliph', 'Flip horizontal', null, () => flip('h')], ['flipv', 'Flip vertical', null, () => flip('v')]]) {
    const button = el('button', 'ib tbtn');
    button.type = 'button';
    fill(button, glyph, text, keyId);
    button.onclick = run;
    four.push(button);
  }
  resetButton.onclick = () => { if (ready()) commit({ ...active.edit, geometry: geometry.neutral() }, null); };
  const cancelButton = $('cropcancel');
  const doneButton = $('cropdone');
  cancelButton.title = `Cancel (${label('escape')})`;
  doneButton.title = `Done (${label('apply')})`;
  const group = (...buttons) => { const box = el('div', 'dgroup'); box.append(...buttons); return box; };
  const dockRow = el('div', 'dockrow');
  dockRow.append(group(four[0], four[1]), crop.aspect, group(four[2], four[3]));
  $('cropdock').append(crop.main, dockRow);

  function startCrop() {
    if (cropping || !active?.texture) return;
    cropping = true;
    crop.begin();
    view.setCropping(true);
  }
  function endCrop(keep) {
    if (!cropping) return;
    if (keep) crop.apply();
    else crop.cancel();
    cropping = false;
    crop.end();
    view.setCropping(false);
  }
  cropButton.onclick = startCrop;
  cancelButton.onclick = () => endCrop(false);
  doneButton.onclick = () => endCrop(true);

  // Saves the tab's picture over its file, or as a copy. The first save over a file asks once whether to replace it. Resolves true when
  // what was asked is done, false when it was not (the user said no, or the main process said why in the corner notice).
  async function save(tab, copy = !tab.writable) {
    if (tab.saving || !tab.texture || window.pomeloCard.isOpen()) return false;
    settleEdits();
    if (!copy && !tab.replaceAsked) {
      const answer = await choose('Replace the original?', `Save over ${tab.name}, or keep it as it is and save a copy.`, [{ label: 'Cancel', value: null }, { label: 'Save a copy', value: 'copy' }, { label: 'Replace', value: 'replace', primary: true }]);
      if (!answer) return false;
      if (answer === 'copy') return save(tab, true);
      tab.replaceAsked = true;
    }
    const [width, height] = geometry.outputSize(tab.edit.geometry, tab.width, tab.height);
    const options = copy ? await saveCopy({ ext: tab.ext, writable: tab.writable, width, height }, qualities) : { format: 'same', quality: null, longEdge: null };
    if (!options) return false;
    tab.saving = true;
    document.body.classList.add('busy');
    let result;
    try {
      const picture = window.editorRender.exportPixels({ width: tab.width, height: tab.height, pixels: tab.pixels }, tab.edit);
      result = await api.save(tab.token, picture.rgba, { mode: copy ? 'copy' : 'replace', ...options, width: picture.width, height: picture.height });
    } catch {
      result = { stop: 'failed' };
    } finally {
      tab.saving = false;
      document.body.classList.remove('busy');
    }
    if (result.stop === 'changed') {
      const answer = await choose(`${tab.name} was changed by another program.`, '', [{ label: 'Cancel', value: null }, { label: 'Save a copy', value: 'copy', primary: true }]);
      return answer === 'copy' ? save(tab, true) : false;
    }
    if (!result.ok) return false;
    if (result.copy === 'opened') { close(tab.token); return true; }
    if (!result.copy) { tab.history.markSaved(); refresh(); }
    if (tab === active && tabs.length === 1) {
      savedNote.textContent = 'Saved';
      savedNote.classList.add('on');
      clearTimeout(tab.savedTimer);
      tab.savedTimer = setTimeout(() => savedNote.classList.remove('on'), 1400);
    }
    return true;
  }

  // Resolves true when the tab's changes are saved or given up, false when the user cancels or saving fails.
  async function settle(tab) {
    const answer = await choose(`Save changes to ${tab.name}?`, '', [{ label: 'Cancel', value: null }, { label: "Don't save", value: 'discard' }, { label: 'Save', value: 'save', primary: true }]);
    return answer === 'discard' || (answer === 'save' && save(tab));
  }

  async function closeTab(token) {
    const tab = find(token);
    if (tab && (!tab.history.dirty() || await settle(tab))) close(token);
  }

  tabStrip.bind({ select: (token) => { const tab = find(token); if (tab && tab !== active) activate(tab); }, close: closeTab });

  saveButton.title = `Save (${label('save')})`;
  saveButton.onclick = () => active && save(active);
  bind('save', () => (active?.history.dirty() ? save(active) : false));
  bind('saveCopy', () => (active ? save(active, true) : false));

  // The window was asked to close while a picture has changes: each of those is asked about in turn, and the window goes only when none
  // was cancelled.
  let leaving = false;
  api.onClosing(async () => {
    if (leaving || window.pomeloCard.isOpen()) return;
    leaving = true;
    let go = true;
    for (const tab of tabs.filter((t) => t.history.dirty())) {
      await activate(tab);
      if (!(go = await settle(tab))) break;
    }
    leaving = false;
    if (go) api.closeWindow();
  });

  const more = $('more');
  const menu = $('mmenu');
  fill(more, 'more', 'More');
  more.setAttribute('aria-haspopup', 'menu');
  const closeMenu = () => {
    if (menu.contains(document.activeElement)) more.focus({ preventScroll: true });
    menu.hidden = true;
    more.setAttribute('aria-expanded', 'false');
  };
  more.onclick = () => {
    if (!menu.hidden) { closeMenu(); return; }
    menu.hidden = false;
    more.setAttribute('aria-expanded', 'true');
    menu.querySelector('.mi').focus({ preventScroll: true });
  };
  for (const [text, keyId, run] of [['Save a copy…', 'saveCopy', () => active && save(active, true)], ['Reset all', null, resetAll], [], ['Show in folder', null, () => active && api.showInFolder(active.token)]]) {
    if (!run) { menu.append(el('hr')); continue; }
    const item = el('button', 'mi');
    item.type = 'button';
    item.setAttribute('role', 'menuitem');
    item.append(el('span', '', text));
    if (keyId) item.append(el('kbd', '', label(keyId)));
    item.onclick = () => { closeMenu(); run(); };
    menu.append(item);
  }
  document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !e.target.closest('#mmenu, #more')) closeMenu(); });
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(); return; }
    const by = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (!by) return;
    const items = [...menu.querySelectorAll('.mi')];
    items[(items.indexOf(document.activeElement) + by + items.length) % items.length].focus({ preventScroll: true });
    e.preventDefault();
  });

  const TOOLS = ['adjust', 'presets'];
  const tools = $('tools');
  const views = $('views');
  let tool = 'adjust';
  function setTool(next) {
    endCrop(true);
    view.showPanel();
    if (next === tool) return;
    views.dataset.turn = TOOLS.indexOf(next) > TOOLS.indexOf(tool) ? 'next' : 'prev';
    tool = next;
    for (const button of tools.children) button.setAttribute('aria-checked', String(button.dataset.tool === tool));
    for (const t of TOOLS) $(`view-${t}`).hidden = t !== tool;
    if (tool === 'adjust') adjust.edited();
  }
  tools.addEventListener('click', (e) => { const button = e.target.closest('button'); if (button) setTool(button.dataset.tool); });
  for (const id of TOOLS) bind(id, () => setTool(id));
  bind('crop', () => (cropping ? false : startCrop()));
  bind('escape', () => {
    if (!cropping) return false;
    endCrop(false);
  });
  bind('apply', (e) => {
    if (!cropping || e.target.closest?.('button')) return false;
    endCrop(true);
  });

  view.setPanel(state.view.panel !== false, { remember: false, still: true });
  open(state.images);
  api.onOpened(open);
})();

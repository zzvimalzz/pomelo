// SPDX-License-Identifier: AGPL-3.0-or-later
// The editor page: asks the main process which pictures the window was opened for, reads the pixels of each, keeps one tab for each and
// shows the tab on show in the well. It also runs the tool switch of the panel.
(async () => {
  if (new URLSearchParams(location.search).has('solid')) document.documentElement.classList.add('solid');
  const api = window.editorApi;
  const view = window.editorView;
  const { bind } = window.editorKeys;
  const name = document.getElementById('imgname');
  const line = document.getElementById('nameline');
  const tabStrip = window.pomeloTabs.create(document.getElementById('tabs'));
  const tabs = [];
  let active = null;
  let piece = 0;

  const find = (token) => tabs.find((t) => t.token === token);

  function drawTabs() {
    line.hidden = tabs.length > 1;
    name.textContent = active?.name ?? '';
    tabStrip.render(tabs.map((t) => ({ token: t.token, name: t.name, dirty: false })), active?.token);
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
    active = tab;
    drawTabs();
    await tab.loading;
    if (active !== tab || !tabs.includes(tab)) return;
    const first = !tabs.some((t) => t.shownBefore);
    tab.shownBefore = true;
    view.show(tab, first ? 'first' : 'switch');
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
    drawTabs();
  }

  function add(info) {
    const tab = { ...info, pixels: null, texture: null, view: { fit: true, zoom: 1, panX: 0, panY: 0 }, shownBefore: false };
    tab.loading = read(info).then((pixels) => { tab.pixels = pixels; }, () => close(info.token));
    tabs.push(tab);
    return tab;
  }

  function open(images) {
    const shown = images.map((info) => find(info.token) ?? add(info));
    if (shown.length) activate(shown[shown.length - 1]);
  }

  tabStrip.bind({ select: (token) => { const tab = find(token); if (tab && tab !== active) activate(tab); }, close });

  const TOOLS = ['adjust', 'presets', 'crop'];
  const tools = document.getElementById('tools');
  const views = document.getElementById('views');
  let tool = 'adjust';
  function setTool(next) {
    view.showPanel();
    if (next === tool) return;
    views.dataset.turn = TOOLS.indexOf(next) > TOOLS.indexOf(tool) ? 'next' : 'prev';
    tool = next;
    for (const button of tools.children) button.setAttribute('aria-checked', String(button.dataset.tool === tool));
    for (const t of TOOLS) document.getElementById(`view-${t}`).hidden = t !== tool;
  }
  tools.addEventListener('click', (e) => { const button = e.target.closest('button'); if (button) setTool(button.dataset.tool); });
  for (const id of TOOLS) bind(id, () => setTool(id));

  const state = await api.state();
  piece = state.piece;
  view.setPanel(state.view.panel !== false, { remember: false, still: true });
  open(state.images);
  api.onOpened(open);
})();

// SPDX-License-Identifier: AGPL-3.0-or-later
// The Settings page: a sidebar of sections, a search box, and the state each section shows. A section is one entry in SECTIONS
// (its sidebar item, title and a render function), so a new section needs no other change.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const { el } = window.pomeloUi;
const api = window.settingsApi;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const ICONS = {
  sliders: '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
  palette: '<circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.65-.75 1.65-1.69 0-.44-.18-.84-.44-1.12-.29-.29-.44-.65-.44-1.13a1.64 1.64 0 0 1 1.67-1.67h2c3.05 0 5.55-2.5 5.55-5.55C21.97 6.01 17.46 2 12 2z"/>',
  cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  copy: '<rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4M10 9H8M16 13H8M16 17H8"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01"/>',
};
const icon = (n) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n]}</svg>`;

// What each optional engine does for the user. `install` ones get an Install button.
const ENGINES = [
  { key: 'builtin', name: 'Built-in', role: 'Documents, images, subtitles, archives', always: true },
  { key: 'ffmpeg', name: 'FFmpeg', role: 'Video and audio (comes with Pomelo)' },
  { key: 'pdf', name: 'PDF engine', role: 'PDF to editable Word, Excel, slides and text', install: true },
  { key: 'ocr', name: 'OCR', role: 'Reads scanned PDFs as text', install: true },
  { key: 'heic', name: 'HEIC export', role: 'Write HEIC photos (reading is built in)', install: true },
  { key: 'soffice', name: 'LibreOffice', role: 'Office formats and high-fidelity PDF export', install: true },
  { key: 'pandoc', name: 'Pandoc', role: 'Markdown, HTML, RTF and ODT', install: true },
];

let state;                    // { settings, engines, installing, version, os }
let pending = null;           // where to go, when the main process asks before the page has its state
let update = { state: 'idle' };
let current = 'general';
const failures = {};          // engine key -> why the last install failed

const row = (title, desc, control, { cls = '', tip = '', id = '' } = {}) =>
  `<div class="row"${tip ? ` title="${esc(tip)}"` : ''}><span class="info"><b>${title}</b>${desc ? `<small class="${cls}"${id ? ` id="${id}"` : ''}>${desc}</small>` : ''}</span>${control}</div>`;
const group = (items, title = '', cls = '') => `<section class="group ${cls}">${title ? `<h2>${title}</h2>` : ''}${items.join('')}</section>`;
const toggle = (key, label) => `<input type="checkbox" class="switch" data-bind="${key}" aria-label="${label}">`;

const general = () =>
  '<section class="panel"><div class="hero"><img src="logo.png" alt=""><span class="grow"><h3 id="statusTitle"></h3></span>' +
  `${toggle('enabled', 'Enabled')}</div>` +
  '<div class="steps" aria-label="How it works"><div class="step"><span class="n">1</span><span><b>Drag</b> a file</span></div><div class="step"><span class="n">2</span><span>Tap <kbd>Ctrl</kbd></span></div><div class="step"><span class="n">3</span><span><b>Drop</b> on a format</span></div></div></section>' +
  group([
    row('Start with Windows', '', toggle('openAtLogin', 'Start with Windows')),
    '<div class="row"><span class="info"><b>Save conversions to</b><small id="outputNote" hidden></small></span><span class="dd">' +
      '<button type="button" id="output" class="dd-btn" data-action="menu" aria-haspopup="listbox" aria-expanded="false" aria-label="Save conversions to"><span id="outputText"></span></button>' +
      '<ul id="outputMenu" class="dd-menu" role="listbox" aria-label="Save conversions to" hidden></ul></span></div>',
  ]);

const appearance = () => group([`<div class="themes" role="radiogroup" aria-label="Appearance">${['system', 'light', 'dark'].map((t) =>
  `<button class="tc" role="radio" aria-checked="false" data-action="theme" data-v="${t}"><div class="thumb t-${t}"></div>${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>`]);

function engines() {
  const have = (e) => e.always || state.engines[e.key];
  const ready = ENGINES.filter(have).length;
  const chip = (e) => {
    if (have(e)) return '<span class="chip">Ready</span>';
    if (state.installing?.keys.includes(e.key)) return '<span class="chip busy"><i class="spin"></i>Installing…</span>';
    if (e.install) return `<button class="chip" data-action="install" data-v="${e.key}"${state.installing ? ' disabled' : ''}>${failures[e.key] ? 'Retry' : 'Install'}</button>`;
    return '<span class="chip off">Missing</span>';
  };
  const line = (e) => {
    if (state.installing?.keys.includes(e.key)) return row(esc(e.name), esc(state.installing.note), chip(e), { cls: 'note' });
    if (failures[e.key]) return row(esc(e.name), esc(failures[e.key]), chip(e), { cls: 'bad' });
    return row(esc(e.name), esc(e.role), chip(e), { tip: typeof state.engines[e.key] === 'string' ? state.engines[e.key] : '' });
  };
  return group([`<b>${ready === ENGINES.length ? 'All engines ready' : `${ready} of ${ENGINES.length} engines ready`}</b><div class="meter"><i data-w="${ready / ENGINES.length * 100}"></i></div>`]) + group(ENGINES.map(line));
}

function updates() {
  const mb = (n) => `${((n || 0) / 1048576).toFixed(n > 10485760 ? 0 : 1)} MB`;
  const now = esc(state.version || '');
  let title = `Version ${now}`, label = 'Check for updates', note = '', cls = '', extra = '';
  const found = () => { title = `Version ${now}<span class="vnew">&gt;</span>Version ${esc(update.latest)}`; };
  switch (update.state) {
    case 'checking': label = 'Checking…'; extra = ' disabled'; note = 'Looking for a newer version…'; break;
    case 'uptodate': label = 'Check again'; note = update.note ? `You're up to date. ${esc(update.note)}.` : "You're up to date"; cls = 'ok'; break;
    case 'available': found(); label = 'Download update'; extra = ' primary'; note = 'A new version is available'; cls = 'ok'; break;
    case 'downloading': {
      const p = update.progress || {};
      found();
      label = p.phase === 'install' ? 'Installing…' : `Downloading ${p.fraction ? `${Math.floor(p.fraction * 100)}%` : ''}`.trim();
      extra = ' disabled';
      note = p.phase === 'install' ? 'Pomelo will restart in a moment' : `${mb(p.received)} of ${mb(p.total)}${p.left ? ` · about ${esc(p.left)} s left` : ''}`;
      break;
    }
    case 'unconfigured': note = 'Update checks start once Pomelo is released'; break;
    case 'error': label = 'Try again'; note = `${update.retry ? 'The update failed' : 'Update check failed'}. ${esc(update.message)}`; cls = 'bad'; break;
  }
  const button = `<button class="btn${extra.includes('primary') ? ' primary' : ''}" data-action="update"${extra.includes('disabled') ? ' disabled' : ''}>${label}</button>`;
  return group([row(title, note, button, { cls }), row('Check automatically', '', toggle('autoUpdate', 'Check automatically'))]);
}

const diagnostics = () => group([
  row('Log file', '', `<button class="btn" data-action="log">${icon('file')}Open log</button>`),
  row('Support info', '', `<button class="btn" id="copyBtn" data-action="copy">${icon('copy')}Copy</button>`),
]);

const about = () =>
  `<div class="about"><img src="logo.png" alt=""><div><h3>Pomelo</h3><p class="muted">Version ${esc(state.version || '')}</p></div></div>` +
  group([row('Source code and licences', 'Free software under the GNU AGPL', `<a class="btn" href="https://github.com/zzvimalzz/pomelo#licence" target="_blank" rel="noopener">Open${icon('external')}</a>`)]) +
  group([row('Uninstall', 'Removes Pomelo, its settings and the engines it installed', '<button class="btn danger" id="uninstall" data-action="uninstall">Uninstall</button>', { id: 'uninstallNote' })], 'Remove Pomelo', 'danger');

const SECTIONS = [
  { id: 'general', label: 'General', icon: 'sliders', group: 'Settings', title: 'General', render: general },
  { id: 'appearance', label: 'Appearance', icon: 'palette', group: 'Settings', title: 'Appearance', render: appearance },
  { id: 'engines', label: 'Engines', icon: 'cpu', group: 'Settings', title: 'Engines', render: engines },
  { id: 'updates', label: 'Updates', icon: 'refresh', group: 'Settings', title: 'Updates', render: updates },
  { id: 'help', label: 'How Pomelo works', icon: 'help', group: 'Help', title: 'How Pomelo works', render: () => window.pomeloHelp.page() },
  { id: 'diagnostics', label: 'Diagnostics', icon: 'activity', group: 'Advanced', title: 'Diagnostics', render: diagnostics },
  { id: 'about', label: 'About', icon: 'info', group: 'Advanced', title: 'About', render: about },
];

function build() {
  let last = '';
  $('#nav').innerHTML = SECTIONS.map((s) => {
    const heading = s.group !== last ? `<div class="navgroup">${s.group}</div>` : '';
    last = s.group;
    return `${heading}<button class="nav" data-action="nav" data-v="${s.id}" title="${s.label}">${icon(s.icon)}<span>${s.label}</span></button>`;
  }).join('');
  $('#content').innerHTML = SECTIONS.map((s) =>
    `<section class="page" id="page-${s.id}" hidden><header class="page-head"><h1>${s.title}</h1></header><div class="page-body">${s.render()}</div></section>`).join('') +
    '<p class="empty" id="empty" hidden></p>';
  sync();
  applySearch();
}

function renderPage(id) {
  if (!state) return;
  $(`#page-${id} .page-body`).innerHTML = SECTIONS.find((s) => s.id === id).render();
  sync();
  applySearch();
}

function go(id) {
  if (!SECTIONS.some((s) => s.id === id)) return;
  current = id;
  $('#q').value = '';
  applySearch();
  $('#content').scrollTop = 0;
}

// Brings everything that shows a setting in step with the stored settings, without rebuilding a page (so focus stays where it is).
function sync() {
  const { settings } = state;
  for (const i of $$('[data-bind]')) i.checked = !!settings[i.dataset.bind];
  $('#pill').textContent = settings.enabled ? 'Running' : 'Paused';
  $('#pill').classList.toggle('off', !settings.enabled);
  $('#ver').textContent = `Version ${state.version}`;
  const title = $('#statusTitle');
  if (title) title.textContent = settings.enabled ? 'Pomelo is running' : 'Pomelo is paused';
  const theme = ['light', 'dark'].includes(settings.theme) ? settings.theme : 'system';
  for (const b of $$('.tc')) b.setAttribute('aria-checked', String(b.dataset.v === theme));
  for (const m of $$('.meter i')) m.style.width = `${m.dataset.w}%`;
  renderOutput(settings.outputDir);
}

function applySearch() {
  const q = $('#q').value.trim().toLowerCase();
  for (const c of $$('#content .group, #content .panel')) {
    const rows = $$('.row, .faq', c);
    if (!rows.length) { c.hidden = !!q && !c.textContent.toLowerCase().includes(q); continue; }
    let any = false;
    for (const r of rows) {
      const match = !q || r.textContent.toLowerCase().includes(q);
      r.hidden = !match;
      any = any || match;
    }
    c.hidden = !any;
  }
  for (const t of $$('#content .tour')) t.hidden = !!q;
  let shown = 0;
  for (const p of $$('#content .page')) {
    p.hidden = q ? !$$('.group, .panel', p).some((c) => !c.hidden) : p.id !== `page-${current}`;
    if (!p.hidden) shown++;
  }
  $('#empty').hidden = !q || shown > 0;
  $('#empty').textContent = `Nothing matches “${$('#q').value.trim()}”.`;
  for (const n of $$('.nav')) { if (n.dataset.v === current) n.setAttribute('aria-current', 'page'); else n.removeAttribute('aria-current'); }
}

const folderName = (dir) => dir.split(/[\\/]/).filter(Boolean).pop() || dir;
const outputOptions = () => $$('#outputMenu [role="option"]');

// Default, the folder in use when there is one, and Choose folder. Picking a new folder replaces the old one, so there are never more than three.
function renderOutput(dir) {
  const choices = [['default', 'Default'], ...(dir ? [['current', folderName(dir)]] : [])];
  const selected = dir ? 'current' : 'default';
  const option = ([value, text]) => {
    const li = el('li', '', text);
    li.setAttribute('role', 'option');
    li.dataset.action = 'pick';
    li.dataset.v = value;
    li.tabIndex = -1;
    return li;
  };
  const separator = el('li');
  separator.setAttribute('role', 'separator');
  $('#outputMenu').replaceChildren(...choices.map(option), separator, option(['choose', 'Choose folder…']));
  for (const o of outputOptions()) o.setAttribute('aria-selected', String(o.dataset.v === selected));
  $('#outputText').textContent = choices.find(([value]) => value === selected)[1];
  $('#output').title = dir || '';
  $('#outputNote').hidden = !dir;
  $('#outputNote').textContent = dir || '';
}

function toggleOutputMenu(open, focus = true) {
  $('#outputMenu').hidden = !open;
  $('#output').setAttribute('aria-expanded', String(open));
  if (open) (outputOptions().find((o) => o.getAttribute('aria-selected') === 'true') || outputOptions()[0]).focus();
  else if (focus) $('#output').focus();
}

async function pickOutput(value) {
  toggleOutputMenu(false);
  if (value === 'default') await save({ outputDir: '' });
  else if (value === 'choose') { state = { ...state, settings: await api.chooseOutput() }; sync(); }
}

async function save(patch) {
  state = { ...state, settings: await api.set(patch) };
  sync();
}

async function install(key) {
  for (const k of Object.keys(failures)) delete failures[k];
  state.installing = { keys: [key], note: 'Starting…' };       // the main process replaces this with the full list and live notes
  renderPage('engines');
  const r = await api.installEngine(key);
  state.installing = null;
  if (r.engines) state.engines = r.engines;
  if (!r.ok) failures[key] = r.message || 'Install failed';
  renderPage('engines');
}

async function checkNow() {
  update = { state: 'checking' };
  renderPage('updates');
  update = await api.checkUpdates();
  renderPage('updates');
}

async function updateClick() {
  if (update.state === 'available') {                       // the download starts only here, when the user presses the button
    if (!update.installable) {                              // no checksum to verify against: the browser download instead
      const r = await api.downloadUpdate(update.url);
      if (!r.ok) { update = { state: 'error', message: r.message }; renderPage('updates'); }
      return;
    }
    const found = update;
    update = { ...found, state: 'downloading', progress: { phase: 'download' } };
    renderPage('updates');
    const r = await api.installUpdate();                    // on success Pomelo restarts itself, so this rarely returns
    if (r.cancelled) { update = found; renderPage('updates'); return; }
    if (!r.ok) { update = { state: 'error', message: r.message, retry: found }; renderPage('updates'); }
    return;
  }
  if (update.state === 'error' && update.retry) { update = update.retry; renderPage('updates'); return; }
  checkNow();
}

function diagnosticsText() {
  const lines = [`Pomelo ${state.version}`, state.os || '', `Save conversions to: ${state.settings.outputDir ? 'a chosen folder' : 'next to the original'}`, 'Engines:'];
  for (const e of ENGINES) lines.push(`  ${e.name}: ${e.always ? 'built in' : state.engines[e.key] || 'not found'}`);
  return lines.filter(Boolean).join('\n');
}

async function uninstall() {
  const btn = $('#uninstall'), note = $('#uninstallNote'), before = note.textContent;
  btn.disabled = true;
  const r = await api.uninstall();                          // the confirmation is a native dialog from the main process
  if (!r.ok) { btn.disabled = false; note.textContent = before; } else { btn.textContent = 'Uninstalling'; }
}

function copyDiagnostics() {
  const btn = $('#copyBtn'), before = btn.innerHTML;
  api.copy(diagnosticsText());
  btn.textContent = 'Copied';
  setTimeout(() => { btn.innerHTML = before; }, 1600);
}

const ACTIONS = {
  nav: (_, v) => go(v),
  menu: () => toggleOutputMenu($('#outputMenu').hidden),
  pick: (_, v) => pickOutput(v),
  theme: (_, v) => save({ theme: v }),
  install: (_, v) => install(v),
  update: updateClick,
  log: () => api.openLogs(),
  copy: copyDiagnostics,
  uninstall,
  website: () => api.website(),
};

function openTarget(target) {
  if (!state) { pending = target; return; }
  if (target?.page) go(target.page);
  if (target?.check && update.state !== 'checking') checkNow();
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.dd')) toggleOutputMenu(false, false);
  const t = e.target.closest('[data-action]');
  if (t) ACTIONS[t.dataset.action]?.(t, t.dataset.v);
});
document.addEventListener('change', async (e) => {
  const key = e.target.dataset?.bind;
  if (!key) return;
  await save({ [key]: e.target.checked });
  if (key === 'autoUpdate' && e.target.checked && update.state !== 'available') checkNow();      // switching it on looks straight away, so the answer is on screen
});
document.addEventListener('keydown', (e) => {
  const menu = e.target.closest?.('#outputMenu');
  if (menu) {
    const options = outputOptions();
    const at = options.indexOf(document.activeElement);
    const to = { ArrowDown: (at + 1) % options.length, ArrowUp: (at - 1 + options.length) % options.length, Home: 0, End: options.length - 1 }[e.key];
    if (to !== undefined) options[to].focus();
    else if (e.key === 'Enter' || e.key === ' ') pickOutput(document.activeElement.dataset.v);
    else if (e.key === 'Escape') toggleOutputMenu(false);
    else if (e.key === 'Tab') { toggleOutputMenu(false, false); return; }
    else return;
    e.preventDefault();
  } else if (e.target.id === 'output' && ['ArrowDown', 'ArrowUp'].includes(e.key)) {
    e.preventDefault();
    toggleOutputMenu(true);
  } else if (e.key === 'Escape' && e.target.id === 'q') {
    e.target.value = '';
    applySearch();
  } else if (e.key === 'f' && e.ctrlKey) {
    $('#q').focus();
    $('#q').select();
  }
});
$('#q').addEventListener('input', applySearch);
window.addEventListener('blur', () => toggleOutputMenu(false, false));

api.onUpdateProgress((p) => { if (update.state === 'downloading') { update = { ...update, progress: p }; renderPage('updates'); } });
api.onUpdateFound((result) => { update = result; renderPage('updates'); });         // the automatic check found something: show the button, do not download
api.onEngineProgress((installing) => {
  if (!state || !installing) return;
  if (!installing.keys.length) { const note = $('#uninstallNote'); if (note) note.textContent = installing.note; return; }       // progress of an uninstall
  state.installing = installing;
  renderPage('engines');
});
api.onGo(openTarget);
api.onChanged((settings) => { if (state) { state = { ...state, settings }; sync(); } });

api.get().then(async (s) => {
  state = s;
  if (s.update) update = s.update;
  else if (s.updated) update = { state: 'uptodate', current: s.version, note: 'Pomelo has just been updated' };      // started again by an update
  build();
  const query = new URLSearchParams(location.search);
  openTarget(pending || { page: query.get('page') || 'general', check: query.get('check') === 'true' });
  window.pomeloHelp.start();
});

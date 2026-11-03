// SPDX-License-Identifier: AGPL-3.0-or-later
const $ = (id) => document.getElementById(id);
const cap = (s) => s[0].toUpperCase() + s.slice(1);

// What each optional engine does for the user. `install` ones get an Install button. (Shown in the Advanced view.)
const ENGINES = [
  { key: 'builtin', name: 'Built-in', role: 'Documents, images, subtitles, archives', always: true },
  { key: 'ffmpeg', name: 'FFmpeg', role: 'Video and audio (comes with Pomelo)' },
  { key: 'pdf2docx', name: 'PDF fidelity', role: 'PDF to Word and Excel, keeping fonts and tables', install: true },
  { key: 'heic', name: 'HEIC export', role: 'Write HEIC photos (reading is built in)', install: true },
  { key: 'soffice', name: 'LibreOffice', role: 'Office formats and high-fidelity PDF export', install: true },
  { key: 'pandoc', name: 'Pandoc', role: 'Markdown, HTML, RTF and ODT', install: true },
];

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };

const failures = {};   // engine key -> why the last install failed

function engineRow(e, found) {
  const row = el('div', 'engine');
  const busy = state.installing?.keys.includes(e.key);
  row.append(el('span', 'name', e.name));
  row.append(el('small', busy ? 'role note' : failures[e.key] ? 'role bad' : 'role', busy ? state.installing.note : failures[e.key] || e.role));
  if (found) {
    if (typeof found === 'string') row.title = found;          // full path on hover, never inline (long paths)
    row.append(el('span', 'chip', 'Ready'));
  } else if (busy) {
    const chip = el('span', 'chip busy', 'Installing…');
    row.append(chip);
  } else if (e.install) {
    const btn = el('button', 'chip off', failures[e.key] ? 'Retry' : 'Install');
    btn.disabled = !!state.installing;                         // one install at a time
    btn.onclick = () => install(e.key);
    row.append(btn);
  } else {
    row.append(el('span', 'chip off', 'Missing'));
  }
  return row;
}

async function install(key) {
  for (const k of Object.keys(failures)) delete failures[k];
  state.installing = { keys: [key], note: 'Starting…' };       // the main process replaces this with the full list and live notes
  render();
  const r = await window.settingsApi.installEngine(key);
  state.installing = null;
  if (r.engines) state.engines = r.engines;
  if (!r.ok) failures[key] = r.message || 'Install failed';
  render();
}

let state;           // { settings, engines, installing, version, os }

function render() {
  const { settings, engines } = state;
  $('enabled').checked = settings.enabled;
  $('openAtLogin').checked = settings.openAtLogin;
  $('keycap').textContent = cap(settings.key);
  for (const b of document.querySelectorAll('#key button')) b.setAttribute('aria-checked', String(b.dataset.key === settings.key));
  $('status').classList.toggle('off', !settings.enabled);
  $('statusText').textContent = settings.enabled ? 'Running' : 'Paused';

  $('engines').replaceChildren(...ENGINES.map((e) => engineRow(e, e.always ? true : engines[e.key])));
  const ready = ENGINES.filter((e) => e.always || engines[e.key]).length;
  $('engineSummary').textContent = ready === ENGINES.length ? 'All ready' : `${ready} of ${ENGINES.length} ready`;
  $('engineSummary').classList.toggle('warn', ready < ENGINES.length);

  $('advanced').hidden = !settings.advanced;
  $('advToggle').textContent = settings.advanced ? 'Hide advanced' : 'Advanced';
  $('advToggle').setAttribute('aria-expanded', String(!!settings.advanced));
  renderUpdate();
}

// ---- updates: Check for updates -> (Checking...) -> up to date | Version X > Version Y + Download | error ------
let update = { state: 'idle' };

function renderUpdate() {
  const btn = $('updateBtn'), line = $('versionLine'), status = $('updateStatus');
  const current = state?.version || '';
  btn.className = 'btn';
  btn.disabled = false;
  status.hidden = false;
  status.className = '';
  line.className = '';
  line.replaceChildren(document.createTextNode(`Version ${current}`));
  switch (update.state) {
    case 'checking': btn.textContent = 'Checking…'; btn.disabled = true; status.textContent = 'Looking for a newer version…'; break;
    case 'uptodate': btn.textContent = 'Check again'; status.textContent = update.note ? `You're up to date. ${update.note}.` : "You're up to date"; status.className = 'ok'; break;
    case 'available':
      // "Version 0.1.0 > Version 0.2.0"
      line.className = 'new';
      line.replaceChildren(document.createTextNode(`Version ${current}`), el('span', 'vnew', '>'), document.createTextNode(`Version ${update.latest}`));
      btn.textContent = 'Download update'; btn.className = 'btn primary';
      status.textContent = 'A new version is available'; status.className = 'ok';
      break;
    case 'unconfigured': btn.textContent = 'Check for updates'; status.textContent = 'Update checks start once Pomelo is released'; break;
    case 'error': btn.textContent = 'Try again'; status.textContent = `Update check failed. ${update.message}`; status.className = 'bad'; break;
    default: btn.textContent = 'Check for updates'; status.hidden = true;
  }
  fit();
}

$('updateBtn').onclick = async () => {
  if (update.state === 'available') {
    const r = await window.settingsApi.downloadUpdate(update.url);
    if (!r.ok) { update = { state: 'error', message: r.message }; renderUpdate(); }
    return;
  }
  update = { state: 'checking' };
  renderUpdate();
  update = await window.settingsApi.checkUpdates();
  renderUpdate();
};

// ---- window fitting: the window sizes itself to this height ---------------------------------------
function fit() {
  requestAnimationFrame(() => window.settingsApi.fit(Math.ceil($('app').getBoundingClientRect().height)));
}

// ---- diagnostics ---------------------------------------------------------------------------------
function diagnostics() {
  const lines = [`Pomelo ${state.version}`, state.os || '', `Trigger key: ${state.settings.key}`, 'Engines:'];
  for (const e of ENGINES) lines.push(`  ${e.name}: ${e.always ? 'built in' : state.engines[e.key] || 'not found'}`);
  return lines.filter(Boolean).join('\n');
}

async function save(patch) { state = { ...state, settings: await window.settingsApi.set(patch) }; render(); }

window.settingsApi.get().then((s) => { state = s; render(); });
window.settingsApi.onEngineProgress((installing) => {
  if (!state || !installing) return;
  if (!installing.keys.length) { $('uninstallNote').textContent = installing.note; return; }   // progress of an uninstall
  state.installing = installing;
  render();
});
new ResizeObserver(fit).observe($('app'));
$('uninstall').onclick = async () => {
  const btn = $('uninstall'), note = $('uninstallNote'), before = note.textContent;
  btn.disabled = true;
  const r = await window.settingsApi.uninstall();   // the confirmation is a native dialog from the main process
  if (!r.ok) { btn.disabled = false; note.textContent = before; } else { btn.textContent = 'Uninstalling'; }
};
$('logs').onclick = () => window.settingsApi.openLogs();
$('diag').onclick = () => { window.settingsApi.copy(diagnostics()); $('diag').textContent = 'Copied'; setTimeout(() => { $('diag').textContent = 'Copy'; }, 1600); };
$('advToggle').onclick = () => save({ advanced: !state.settings.advanced });
$('enabled').onchange = (e) => save({ enabled: e.target.checked });
$('openAtLogin').onchange = (e) => save({ openAtLogin: e.target.checked });
$('key').onclick = (e) => { const k = e.target.dataset?.key; if (k) save({ key: k }); };

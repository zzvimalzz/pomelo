// SPDX-License-Identifier: AGPL-3.0-or-later
const $ = (id) => document.getElementById(id);
const { el } = window.pomeloUi;

const TITLE = { download: 'Downloading', install: 'Installing', engines: 'Adding extras', done: 'All done', error: 'The update did not finish' };
const FUN = {
  download: ['We are updating your Pomelo', 'Peeling the skin carefully', 'Separating the segments', 'Picking out the pips', 'Choosing the juiciest bits', 'Giving it a gentle squeeze'],
  install: ['Planting the fresh Pomelo', 'Swapping in the new fruit', 'Nearly ready to eat'],
  engines: ['Teaching Pomelo a few new tricks', 'Packing the extras', 'Sharpening the knife', 'Adding the finishing touches'],
};
// After this many seconds in a step, every other message is an apology for the wait. Adding extras downloads hundreds of MB, so it gets longer.
const SLOW_AFTER = { download: 40, install: 30, engines: 180 };
const SLOW = ['This is taking a while. Hang tight', 'Still going. Big fruit, slow juicer', 'Thank you for waiting, it is still working'];
const HOLD = [5000, 10000];     // each heading stays this long (ms), picked at random so it does not tick like a clock
const FADE = 700;               // keep in step with the transition in downloader.css

let state = null;
let stepSince = 0;     // when the current step began
let ticks = 0;         // headings shown in the current step

const mb = (n) => `${((n || 0) / 1048576).toFixed(n > 10485760 ? 0 : 1)} MB`;
const span = (s) => (s < 90 ? `${s} s` : `${Math.round(s / 60)} min`);

function detail(s) {
  if (s.phase === 'download') {
    return [s.total ? `${mb(s.received)} of ${mb(s.total)}` : mb(s.received), s.left ? `about ${span(s.left)} left` : ''].filter(Boolean).join(' · ');
  }
  if (s.phase === 'install') return 'Pomelo needs to restart, it will do so automatically when ready';
  if (s.phase === 'error') return s.message || '';
  return s.note || s.message || '';
}

const stage = (s) => s.title || TITLE[s.phase] || '';

// The big line above the bar. It names the stage, then lets the step's friendly messages take its place one after the other,
// coming back to the stage name in between, with an apology among them once the step has taken too long.
function heading() {
  const list = [stage(state), ...(FUN[state.phase] || [])];
  const secs = (Date.now() - stepSince) / 1000;
  const slow = FUN[state.phase] && secs > SLOW_AFTER[state.phase];
  if (slow && ticks % 2 === 1) return SLOW[Math.min(SLOW.length - 1, Math.floor(secs / SLOW_AFTER[state.phase]) - 1)];
  return list[Math.floor(ticks / (slow ? 2 : 1)) % list.length];
}

// Fade out, swap, fade in.
let fading = null;
function say(text) {
  const phase = $('phase');
  if (phase.textContent === text) return;
  phase.classList.add('out');
  clearTimeout(fading);
  fading = setTimeout(() => { phase.textContent = text; phase.classList.remove('out'); }, FADE);
}

function actions(s) {
  const button = (label, onclick, primary) => { const b = el('button', primary ? 'btn primary' : 'btn', label); b.onclick = onclick; return b; };
  const api = window.downloaderApi;
  if (s.phase === 'download') return [button('Cancel', api.cancel)];
  if (s.phase === 'error') return [button('Try again', api.retry, true), button('Close', api.close)];
  if (s.phase === 'done') return [button('Close', api.close, true)];
  return [];
}

function render() {
  const s = state;
  const known = Number.isFinite(s.fraction);
  const pct = known ? Math.floor(Math.min(1, s.fraction) * 100) : null;
  $('versions').textContent = s.current && s.latest && s.current !== s.latest ? `Version ${s.current} › Version ${s.latest}` : `Version ${s.latest || s.current || ''}`;
  $('percent').textContent = s.phase === 'done' ? '100%' : pct === null ? '' : `${pct}%`;
  const bar = $('bar');
  bar.classList.toggle('busy', !known && s.phase !== 'done' && s.phase !== 'error');
  bar.classList.toggle('bad', s.phase === 'error');
  bar.firstChild.style.width = s.phase === 'done' ? '100%' : s.phase === 'error' ? '100%' : known ? `${pct}%` : '';
  if (pct !== null) bar.setAttribute('aria-valuenow', String(pct)); else bar.removeAttribute('aria-valuenow');
  $('detail').textContent = detail(s) || ' ';
  $('actions').replaceChildren(...actions(s));
}

window.downloaderApi.onState((next) => {
  const changed = !state || state.phase !== next.phase;
  if (changed) { stepSince = Date.now(); ticks = 0; }
  state = next;
  render();
  if (changed) { clearTimeout(fading); $('phase').classList.remove('out'); $('phase').textContent = stage(next); }   // a new stage starts with its name, at once
});

function advance() {
  if (state && FUN[state.phase]) { ticks++; say(heading()); }
}
(function schedule() {
  setTimeout(() => { advance(); schedule(); }, HOLD[0] + Math.random() * (HOLD[1] - HOLD[0]));
})();

window.addEventListener('contextmenu', (e) => e.preventDefault());
window.downloaderApi.ready();

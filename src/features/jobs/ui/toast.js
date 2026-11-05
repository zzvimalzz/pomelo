// SPDX-License-Identifier: AGPL-3.0-or-later
const api = window.toast;
const stack = document.getElementById('stack');

const ICON = { done: '✓', error: '!', info: 'i' };
const LINGER = { done: 5500, info: 6000, error: 9000 };     // working cards stay until they finish
const RING = 2 * Math.PI * 18;                              // circumference of the progress ring (r = 18)

const cards = new Map();                                    // id -> { el, state, timer, outPath }

const make = window.pomeloUi.el;

function build(id) {
  const el = make('div', 'card');
  el.dataset.id = id;
  const text = make('div', 'text');
  text.append(make('div', 'title'), make('div', 'detail'));
  const close = make('button', 'close', '✕');
  close.setAttribute('aria-label', 'Dismiss');
  el.append(make('div'), text, close);                      // first child is replaced by the ring or the status icon
  el.addEventListener('mouseenter', () => clearTimeout(cards.get(id)?.timer));   // reading it? keep it
  el.addEventListener('mouseleave', () => schedule(id));
  el.addEventListener('click', (e) => {
    const c = cards.get(id);
    if (!c) return;
    if (e.target.closest('.cancel')) return api.cancel(id);
    if (e.target.closest('.close')) return dismiss(id);
    if (c.state === 'done' && c.outPath) { api.reveal(c.outPath); dismiss(id); }
  });
  return el;
}

// Progress ring with the cancel X in its centre (the percentage is in the text beside it).
function ringEl() {
  const wrap = make('div', 'ring');
  wrap.innerHTML = '<svg viewBox="0 0 44 44" aria-hidden="true"><circle class="track" cx="22" cy="22" r="18"/><circle class="value" cx="22" cy="22" r="18"/></svg>';
  const cancel = make('button', 'cancel', '✕');
  cancel.setAttribute('aria-label', 'Cancel');
  cancel.title = 'Cancel';
  wrap.append(cancel);
  return wrap;
}

function schedule(id) {
  const c = cards.get(id);
  if (!c) return;
  clearTimeout(c.timer);
  if (LINGER[c.state]) c.timer = setTimeout(() => dismiss(id), LINGER[c.state]);
}

// Fade the card out, then tell the main process so the window can shrink.
function dismiss(id) {
  const c = cards.get(id);
  if (!c || c.el.classList.contains('out')) return;
  clearTimeout(c.timer);
  c.el.classList.add('out');
  setTimeout(() => { cards.delete(id); c.el.remove(); api.remove(id); }, 170);
}

function paint(c, data) {
  const el = c.el;
  const stateChanged = c.state !== data.state;
  c.state = data.state;
  c.outPath = data.outPath || '';
  el.classList.remove('working', 'done', 'error', 'info');
  el.classList.add(data.state);
  el.classList.toggle('clickable', data.state === 'done' && !!c.outPath);

  const lead = el.firstChild;
  if (data.ring) {
    if (!lead.classList.contains('ring')) lead.replaceWith(ringEl());
    const ring = el.firstChild;
    const progress = Math.min(1, Math.max(0, data.progress || 0));   // always a figure: measured, or estimated from the clock
    const value = ring.querySelector('.value');
    value.style.strokeDasharray = String(RING);
    value.style.strokeDashoffset = String(RING * (1 - progress));
    ring.setAttribute('aria-label', `${Math.round(progress * 100)} percent`);
  } else {
    if (!lead.classList.contains('icon')) lead.replaceWith(make('div', 'icon'));
    el.firstChild.textContent = ICON[data.state] ?? '';
  }
  el.querySelector('.title').textContent = data.title || '';
  const detail = el.querySelector('.detail');
  detail.textContent = data.detail || '';
  detail.hidden = !data.detail;
  if (stateChanged) schedule(data.id);
}

// The main process sends the full list every time; draw it newest first (top) to oldest (bottom).
api.onView((view) => {
  const ids = new Set(view.cards.map((d) => d.id));
  for (const [id, c] of cards) if (!ids.has(id) && !c.el.classList.contains('out')) { clearTimeout(c.timer); c.el.remove(); cards.delete(id); }
  view.cards.forEach((data, index) => {
    let c = cards.get(data.id);
    if (c && c.el.classList.contains('out')) return;        // already fading out; main will drop it
    if (!c) {
      c = { el: build(data.id), state: null, timer: null, outPath: '' };
      cards.set(data.id, c);
    }
    paint(c, data);
    if (stack.children[index] !== c.el) stack.insertBefore(c.el, stack.children[index] || null);
  });
});

window.addEventListener('contextmenu', (e) => e.preventDefault());
api.ready();

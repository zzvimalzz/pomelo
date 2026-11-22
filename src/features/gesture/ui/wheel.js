// SPDX-License-Identifier: AGPL-3.0-or-later
const api = window.pomelo;
const { CX, CY, R_OUT, R_IN, svg: el, pt, segmentPath, ringPath } = window.pomeloWheelShapes;

const stage = document.getElementById('stage');
const segmentsEl = document.getElementById('segments');
const centerEl = document.getElementById('center');
const plate = document.getElementById('plate');
const pill = document.getElementById('pill');
const pillIn = document.getElementById('pillIn');
const pillKey = document.getElementById('pillKey');
window.pomeloIcons.addDefs(el, document.getElementById('wheel'));

let targets = [];
let leaving = [];          // targets turning away while the other wheel turns in
let hot = -1;
let picking = false;       // opened from the right-click menu: segments are clicked, not dropped on
let wheel = 'convert';     // 'convert' or 'open': which wheel is showing
let sent = false;          // files were dropped or a segment was clicked: the main process is checking them, and the wheel waits for its answer

const ICONS = { book: ['M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z', 'M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z'] };
const OTHER = { convert: { key: 'Shift', name: 'Open' }, open: { key: 'Ctrl', name: 'Convert' } };    // what the pill names: the other wheel
const EASE_OUT = 'cubic-bezier(0.2, 0.9, 0.25, 1.12)';
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const DISC = R_IN - 8, NAME_MAX = 84;
let centerName = null, centerText = '';

// Shrinks a name that would reach past the disc at its height.
function setName(text) {
  centerName.textContent = text;
  centerName.style.fontSize = '';
  const w = centerName.getComputedTextLength();
  if (w > NAME_MAX) centerName.style.fontSize = `${Math.max(8, (11 * NAME_MAX) / w)}px`;
}

// The disc is opaque so the file's icon reads clearly over whatever is behind the wheel.
function drawCenter(info) {
  centerEl.replaceChildren();
  el('circle', { class: 'disc', cx: CX, cy: CY, r: DISC }, centerEl);
  el('circle', { cx: CX, cy: CY, r: DISC }, el('clipPath', { id: 'discClip' }, centerEl));
  const content = el('g', { 'clip-path': 'url(#discClip)' }, centerEl);
  const doc = el('g', { class: 'doc picon' }, content);
  const { x, y } = window.pomeloIcons.draw(el, doc, info, CX, CY);
  if (info.count > 1) {
    el('circle', { class: 'count', cx: x + 4, cy: y + 6, r: 9.5 }, doc);
    el('text', { class: 'countText', x: x + 4, y: y + 9.5 }, doc).textContent = info.count > 99 ? '99+' : info.count;
  }
  centerName = el('text', { class: 'name', x: CX, y: CY + 30 }, content);
  setName(centerText = info.count > 1 ? `${info.count} files` : info.name);      // the main process has already shortened a long name
}

// One segment for each target, each inside a group of its own that the turn animation moves. A single target is the whole ring.
// With an icon, the icon stands above the label.
function addTargets(list) {
  const n = list.length;
  const step = 360 / n;
  return list.map((t, i) => {
    const mid = -90 + i * step;
    const spin = el('g', { class: 'spin' }, segmentsEl);
    const g = el('g', { class: n === 1 ? 'seg ring' : 'seg' }, spin);
    el('path', n === 1 ? { 'fill-rule': 'evenodd', d: ringPath() } : { d: segmentPath(mid, step) }, g);
    const [lx, ly] = pt((R_IN + R_OUT) / 2, mid);
    if (ICONS[t.icon]) {
      const icon = el('g', { class: 'ticon', transform: `translate(${lx - 11} ${ly - 20}) scale(0.92)` }, g);
      for (const d of ICONS[t.icon]) el('path', { d }, icon);
    }
    const label = el('text', { class: 'label', x: lx, y: ly + (t.icon ? 20 : t.sub ? 0 : 5) }, g);
    label.textContent = t.label;
    if (t.sub) el('text', { class: 'sub', x: lx, y: ly + 15 }, g).textContent = t.sub;
    g.style.transitionDelay = `${i * 14}ms, 0ms`;
    return { ...t, node: g, spin, labelEl: label, mid, whole: n === 1 };
  });
}

function buildWheel(data) {
  segmentsEl.replaceChildren();
  leaving = [];
  targets = addTargets(data.targets);
  hot = -1;
  drawCenter(data.info);
}

function setHot(i) {
  if (i === hot) return;
  if (hot >= 0) {
    const old = targets[hot];
    old.node.classList.remove('hot');
    old.node.style.transform = '';
    old.labelEl.textContent = old.label;
  }
  hot = i;
  const t = hot >= 0 ? targets[hot] : null;
  if (centerName) {
    setName(t ? (wheel === 'open' ? t.label : `to ${t.label}`) : centerText);
    centerName.classList.toggle('to', !!t);
  }
  if (!t) return;
  t.node.classList.add('hot');
  if (t.whole) { t.node.style.transform = 'scale(1.03)'; return; }
  const rad = (t.mid * Math.PI) / 180;
  t.node.style.transform = `translate(${Math.cos(rad) * 7}px, ${Math.sin(rad) * 7}px)`;
}

function hitTest(x, y) {
  if (!targets.length) return -1;
  const box = stage.getBoundingClientRect();
  const dx = x - box.left - CX, dy = y - box.top - CY;
  const r = Math.hypot(dx, dy);
  if (r < R_IN - 4 || r > R_OUT + 16) return -1;
  const step = 360 / targets.length;
  const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  return Math.floor((((deg + 90 + step / 2) % 360) + 360) % 360 / step) % targets.length;
}

const fillPill = () => {
  document.getElementById('pillKbd').textContent = OTHER[wheel].key;
  document.getElementById('pillName').textContent = OTHER[wheel].name;
};

// The key just pressed sinks, its words lift away, and the other wheel's key and name rise in while the pill eases to its new width.
function turnPill() {
  for (const a of [...pill.getAnimations(), ...pillIn.getAnimations()]) a.cancel();
  if (reduced()) { fillPill(); return; }
  pillKey.classList.add('down');
  setTimeout(() => pillKey.classList.remove('down'), 140);
  const before = pill.offsetWidth;
  pillIn.animate([{ opacity: 0, transform: 'translateY(-9px)' }], { duration: 120, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' }).onfinish = () => {
    fillPill();
    pillIn.getAnimations().forEach((a) => a.cancel());
    pill.animate([{ width: `${before}px` }, { width: `${pill.offsetWidth}px` }], { duration: 320, easing: EASE_OUT });
    pillIn.animate([{ opacity: 0, transform: 'translateY(9px)' }, { opacity: 1, transform: 'none' }], { duration: 300, easing: EASE_OUT });
  };
}

// The old segments turn away and fade, one after another, as the new ones turn in; the plate and the file in the centre stay put,
// so it reads as one dial turning. The new segments take drops at once; the turn is only to look at. With reduced motion they cross-fade.
function turn(out, inn, dir) {
  const still = reduced();
  const keep = (t) => { for (const a of t.spin.getAnimations()) { a.commitStyles(); a.cancel(); } };     // a turn pressed during a turn goes on from where it is
  [...leaving, ...out, ...inn].forEach(keep);
  for (const t of leaving) t.spin.remove();
  leaving = out;
  out.forEach((t, i) => {
    const gone = still ? { opacity: 0 } : { opacity: 0, transform: `rotate(${-34 * dir}deg) scale(0.84)` };
    t.spin.animate([gone], { duration: still ? 160 : 200, delay: still ? 0 : i * 8, easing: 'cubic-bezier(0.4, 0, 0.7, 0.2)', fill: 'forwards' }).onfinish = () => t.spin.remove();
  });
  inn.forEach((t, i) => {
    const from = still ? { opacity: 0 } : { opacity: 0, transform: `rotate(${34 * dir}deg) scale(0.84)` };
    const a = t.spin.animate([from, still ? { opacity: 1 } : { opacity: 1, transform: 'none' }], { duration: still ? 160 : 330, delay: still ? 0 : 90 + i * 10, easing: still ? 'linear' : EASE_OUT, fill: 'both' });
    a.onfinish = () => { a.cancel(); t.spin.style.opacity = ''; t.spin.style.transform = ''; };
  });
  if (still) return;
  plate.animate([{ r: 170 }, { r: 163 }, { r: 170 }], { duration: 400, easing: 'cubic-bezier(0.3, 0.7, 0.3, 1)' });
  document.querySelector('#center .doc').animate([{ transform: 'scale(1)' }, { transform: 'scale(0.9) rotate(-6deg)' }, { transform: 'scale(1)' }], { duration: 360, easing: 'cubic-bezier(0.3, 0.7, 0.3, 1.2)' });
}

// ---- show / hide -------------------------------------------------------------------------
// The overlay only ever shows the wheel. Progress, results and errors live in the bottom-right toast.
api.onOpen((data) => {
  picking = data.pick;
  wheel = data.wheel || 'convert';
  stage.dataset.wheel = wheel;
  stage.classList.toggle('picking', picking);
  stage.classList.remove('open', 'closing');
  window.pomeloCard.reset();
  sent = false;
  for (const a of [...plate.getAnimations(), ...pill.getAnimations(), ...pillIn.getAnimations()]) a.cancel();
  buildWheel(data);
  pill.hidden = picking || !data.switchable;
  fillPill();
  requestAnimationFrame(() => requestAnimationFrame(() => stage.classList.add('open')));
});

api.onSwitch((data) => {
  if (!targets.length) return;        // folding away
  const out = targets;
  setHot(-1);
  wheel = data.wheel;
  stage.dataset.wheel = wheel;
  targets = addTargets(data.targets);
  turn(out, targets, wheel === 'open' ? 1 : -1);
  turnPill();
});

api.onUnlock(({ files }) => {
  picking = false;
  stage.classList.remove('picking');
  setHot(-1);
  window.pomeloCard.show(files);
});

api.onClose(() => {
  window.pomeloCard.close();
  stage.classList.remove('open');
  stage.classList.add('closing');
  targets = [];                       // nothing to hit-test while folding away (stale segments caused phantom drops)
  hot = -1;
});

// ---- drag & drop target -----------------------------------------------------------------
let loggedOver = false;
window.addEventListener('dragenter', (e) => { e.preventDefault(); api.log('dragenter'); loggedOver = false; });
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (window.pomeloCard.isOpen()) { e.dataTransfer.dropEffect = 'none'; return; }
  const i = hitTest(e.clientX, e.clientY);
  if (!loggedOver) { loggedOver = true; api.log(`dragover at ${e.clientX},${e.clientY} segment=${i}`); }
  setHot(i);
  e.dataTransfer.dropEffect = i >= 0 ? 'copy' : 'none';
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const paths = [...e.dataTransfer.files].map((f) => api.pathFor(f)).filter(Boolean);
  if (sent) return;
  const i = hitTest(e.clientX, e.clientY);
  api.log(`drop segment=${i} files=${e.dataTransfer.files.length}`);
  if (i >= 0 && paths.length) { sent = true; api.drop(targets[i].id, paths); return; }
  api.cancel();
  setHot(-1);
});

window.addEventListener('mousemove', (e) => { if (picking && !sent) setHot(hitTest(e.clientX, e.clientY)); });
window.addEventListener('click', (e) => {
  if (!picking || sent) return;
  const i = hitTest(e.clientX, e.clientY);
  if (i >= 0) { sent = true; api.pick(targets[i].id); } else api.cancel();
});
window.addEventListener('keydown', (e) => { if (picking && e.key === 'Escape') api.cancel(); });

window.addEventListener('contextmenu', (e) => e.preventDefault());
api.ready();

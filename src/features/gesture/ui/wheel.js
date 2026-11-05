// SPDX-License-Identifier: AGPL-3.0-or-later
const api = window.pomelo;
const { CX, CY, R_OUT, R_IN, svg: el, pt, segmentPath } = window.pomeloWheelShapes;

const stage = document.getElementById('stage');
const segmentsEl = document.getElementById('segments');
const centerEl = document.getElementById('center');
window.pomeloIcons.addDefs(el, document.getElementById('wheel'));

let targets = [];
let hot = -1;
let picking = false;       // opened from the right-click menu: segments are clicked, not dropped on

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

function buildWheel(data) {
  segmentsEl.replaceChildren();
  targets = data.targets;
  hot = -1;
  const n = targets.length;
  const step = 360 / n;
  targets.forEach((t, i) => {
    const mid = -90 + i * step;
    const g = el('g', { class: 'seg' }, segmentsEl);
    el('path', { d: segmentPath(mid, step) }, g);
    const [lx, ly] = pt((R_IN + R_OUT) / 2, mid);
    el('text', { class: 'label', x: lx, y: ly + (t.sub ? 0 : 5) }, g).textContent = t.label;
    if (t.sub) el('text', { class: 'sub', x: lx, y: ly + 15 }, g).textContent = t.sub;
    g.style.transitionDelay = `${i * 14}ms, 0ms`;
    t.node = g;
    t.mid = mid;
  });
  drawCenter(data.info);
}

function setHot(i) {
  if (i === hot) return;
  if (hot >= 0) { targets[hot].node.classList.remove('hot'); targets[hot].node.style.transform = ''; }
  hot = i;
  if (centerName) {
    setName(hot >= 0 ? `to ${targets[hot].label}` : centerText);
    centerName.classList.toggle('to', hot >= 0);
  }
  if (hot >= 0) {
    const t = targets[hot];
    const rad = (t.mid * Math.PI) / 180;
    t.node.classList.add('hot');
    t.node.style.transform = `translate(${Math.cos(rad) * 7}px, ${Math.sin(rad) * 7}px)`;
  }
}

function hitTest(x, y) {
  if (!targets.length) return -1;
  const dx = x - CX, dy = y - CY;
  const r = Math.hypot(dx, dy);
  if (r < R_IN - 4 || r > R_OUT + 16) return -1;
  const step = 360 / targets.length;
  const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  return Math.floor((((deg + 90 + step / 2) % 360) + 360) % 360 / step) % targets.length;
}

// ---- show / hide -------------------------------------------------------------------------
// The overlay only ever shows the wheel. Progress, results and errors live in the bottom-right toast.
api.onOpen((data) => {
  picking = data.pick;
  stage.classList.toggle('picking', picking);
  stage.classList.remove('open', 'closing');
  buildWheel(data);
  requestAnimationFrame(() => requestAnimationFrame(() => stage.classList.add('open')));
});

api.onClose(() => {
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
  const i = hitTest(e.clientX, e.clientY);
  if (!loggedOver) { loggedOver = true; api.log(`dragover at ${e.clientX},${e.clientY} segment=${i}`); }
  setHot(i);
  e.dataTransfer.dropEffect = i >= 0 ? 'copy' : 'none';
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const i = hitTest(e.clientX, e.clientY);
  api.log(`drop segment=${i} files=${e.dataTransfer.files.length}`);
  const paths = [...e.dataTransfer.files].map((f) => api.pathFor(f)).filter(Boolean);
  if (i >= 0 && paths.length) api.drop(targets[i].id, paths);
  else api.cancel();
  setHot(-1);
});

window.addEventListener('mousemove', (e) => { if (picking) setHot(hitTest(e.clientX, e.clientY)); });
window.addEventListener('click', (e) => {
  if (!picking) return;
  const i = hitTest(e.clientX, e.clientY);
  if (i >= 0) api.pick(targets[i].id); else api.cancel();
});
window.addEventListener('keydown', (e) => { if (picking && e.key === 'Escape') api.cancel(); });

window.addEventListener('contextmenu', (e) => e.preventDefault());
api.ready();

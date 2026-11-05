// SPDX-License-Identifier: AGPL-3.0-or-later
const api = window.pomelo;
const NS = 'http://www.w3.org/2000/svg';
const CX = 200, CY = 200, R_OUT = 160, R_IN = 68, GAP_DEG = 3, PAD = 5;
const GROUP_COLOR = { doc: '#2b6cd4', pdf: '#e5483d', sheet: '#1e9e5a', slide: '#e8793a', image: '#8a5cf0',
  folder: '#e0a030', video: '#0e7490', audio: '#0ca678', subtitle: '#d99100', archive: '#6c757d' };

const stage = document.getElementById('stage');
const segmentsEl = document.getElementById('segments');
const centerEl = document.getElementById('center');

let targets = [];
let hot = -1;

const el = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  parent?.appendChild(n);
  return n;
};
const pt = (r, deg) => [CX + r * Math.cos((deg * Math.PI) / 180), CY + r * Math.sin((deg * Math.PI) / 180)];

// Segment outline inset by PAD; the thick round-joined stroke in the same colour rounds the corners.
function segmentPath(mid, step) {
  const ro = R_OUT - PAD, ri = R_IN + PAD;
  const half = step / 2 - GAP_DEG / 2;
  const off = (r) => (PAD / r) * (180 / Math.PI);
  const [a0o, a1o] = [mid - half + off(ro), mid + half - off(ro)];
  const [a0i, a1i] = [mid - half + off(ri), mid + half - off(ri)];
  const large = a1o - a0o > 180 ? 1 : 0;
  const [x0, y0] = pt(ro, a0o), [x1, y1] = pt(ro, a1o), [x2, y2] = pt(ri, a1i), [x3, y3] = pt(ri, a0i);
  return `M${x0} ${y0} A${ro} ${ro} 0 ${large} 1 ${x1} ${y1} L${x2} ${y2} A${ri} ${ri} 0 ${large} 0 ${x3} ${y3}Z`;
}

function drawCenter(info) {
  centerEl.replaceChildren();
  el('circle', { class: 'disc', cx: CX, cy: CY, r: R_IN - 8 }, centerEl);
  const color = GROUP_COLOR[info.group] || '#8e8e93';
  const stack = info.count > 1 ? 2 : 0;
  for (let i = stack; i >= 0; i--) {
    const x = CX - 15 + i * 5, y = CY - 32 - i * 3;
    el('rect', { x, y, width: 30, height: 38, rx: 6, fill: i ? 'rgba(128,128,140,.35)' : color }, centerEl);
  }
  const badge = el('text', { class: 'badge', x: CX, y: CY - 9 }, centerEl);
  badge.textContent = (info.ext || '?').toUpperCase().slice(0, 4);
  const name = el('text', { class: 'name', x: CX, y: CY + 22 }, centerEl);
  name.textContent = info.count > 1 ? `${info.count} files` : info.name;      // the main process has already shortened a long name
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

window.addEventListener('contextmenu', (e) => e.preventDefault());
api.ready();

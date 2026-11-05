// SPDX-License-Identifier: AGPL-3.0-or-later
// Builds the animation's wheel, file icons and window contents with the same drawing code the real wheel uses, and moves on to the next
// sample file each time the loop starts again. The motion itself is in guide.css, so there is nothing to keep in step here.
const { CX, CY, R_OUT, R_IN, svg: el, pt, segmentPath } = window.pomeloWheelShapes;
const { draw, addDefs } = window.pomeloIcons;
const html = window.pomeloUi.el;
const $ = (id) => document.getElementById(id);

const FILE_BOX = '-26 -50 52 64';       // the box around an icon drawn at (0, 0)
const TILE_W = 100;
const GRAB = { x: -10, y: -13 };         // where the pointer holds a file, from the middle of its icon

let samples = [];
let tiles = [];
let fresh = null;
let current = 0;

const fileOf = (sample) => ({ ext: sample.ext, group: sample.group, count: 1 });

function icon(parent, info) {
  draw(el, el('g', { class: 'picon' }, parent), info, 0, 0);
}

function fillTile(t, info, name) {
  t.replaceChildren();
  icon(el('svg', { viewBox: FILE_BOX }, t), info);
  t.append(html('span', 'name', name));
  return t;
}

function buildWheel(sample) {
  const wheel = $('wheel');
  wheel.replaceChildren();
  addDefs(el, wheel);
  el('circle', { class: 'plate', cx: CX, cy: CY, r: 170 }, wheel);
  const step = 360 / sample.targets.length;
  const segment = (parent, t, i) => {
    const mid = -90 + i * step;
    const g = el('g', { class: 'seg' }, parent);
    el('path', { d: segmentPath(mid, step) }, g);
    const [lx, ly] = pt((R_IN + R_OUT) / 2, mid);
    el('text', { class: 'label', x: lx, y: ly + (t.sub ? 0 : 5) }, g).textContent = t.label;
    if (t.sub) el('text', { class: 'sub', x: lx, y: ly + 15 }, g).textContent = t.sub;
    return g;
  };
  const segs = el('g', { class: 'segs' }, wheel);
  sample.targets.forEach((t, i) => segment(segs, t, i).style.setProperty('--i', i));
  segment(el('g', { class: 'hotseg' }, wheel), sample.targets[0], 0).classList.add('hot');
  el('circle', { class: 'disc', cx: CX, cy: CY, r: R_IN - 8 }, wheel);
  draw(el, el('g', { class: 'picon centre' }, wheel), fileOf(sample), CX, CY + 18);
}

function resultOf(sample) {
  const t = sample.targets[0];
  return { label: t.label, info: { ext: t.ext, group: t.group, count: 1 }, name: `${sample.name.replace(/\.[^.]+$/, '')}.${t.ext}` };
}

function fillPair(sample) {
  const made = resultOf(sample);
  const fresh = fillTile(html('div', 'tile new'), made.info, made.name);
  fresh.append(html('span', 'tag', 'New'));
  $('figPair').setAttribute('role', 'img');
  $('figPair').setAttribute('aria-label', `${sample.name} and the new ${made.name}, in the same folder`);
  $('figPair').replaceChildren(fillTile(html('div', 'tile'), fileOf(sample), sample.name), fresh);
}

// Gets the stage ready for the sample at `i`: which file is picked up, its wheel, and what the new file will be called.
function show(i) {
  current = i;
  const sample = samples[i];
  const result = resultOf(sample);
  tiles.forEach((t, n) => t.classList.toggle('lift', n === i));
  $('tour').style.setProperty('--pa', `${TILE_W * i + 76 + GRAB.x}px ${97 + GRAB.y}px`);
  $('ghost').querySelector('svg').replaceChildren();
  icon($('ghost').querySelector('svg'), fileOf(sample));
  $('ghostName').textContent = sample.name;
  buildWheel(sample);
  fillTile(fresh, result.info, result.name);
  $('toastBusy').textContent = `Converting to ${result.label}`;
  $('toastDone').textContent = `Converted to ${result.label}`;
  $('toastFile').textContent = result.name;
}

async function start() {
  ({ samples } = await window.guideApi.data());
  if (!samples.length) { $('tour').hidden = true; return; }
  tiles = samples.map((s) => fillTile(html('div', 'tile'), fileOf(s), s.name));
  fresh = html('div', 'tile fresh');
  $('files').append(...tiles, fresh);
  show(0);
  fillPair(samples[0]);
  document.querySelector('.wheelbox').addEventListener('animationiteration', (e) => {
    if (e.animationName === 'wheel') show((current + 1) % samples.length);
  });
  $('tour').classList.add('play');
}

new ResizeObserver(() => window.guideApi.fit(Math.ceil($('app').getBoundingClientRect().height))).observe($('app'));
$('site').onclick = () => window.guideApi.website();
$('close').onclick = () => window.guideApi.close();
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.guideApi.close(); });
start();

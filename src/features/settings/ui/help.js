// SPDX-License-Identifier: AGPL-3.0-or-later
// The Help page: an animation of the gesture and the questions with their answers. A classic script: it adds window.pomeloHelp.
// The wheel, file icons and window contents are drawn with the same code the real wheel uses; the motion itself is CSS (help.css).
(() => {
  const { CX, CY, R_OUT, R_IN, svg: el, pt, segmentPath } = window.pomeloWheelShapes;
  const { draw, addDefs } = window.pomeloIcons;
  const html = window.pomeloUi.el;
  const $ = (id) => document.getElementById(id);

  const FILE_BOX = '-26 -50 52 64';       // the box around an icon drawn at (0, 0)
  const TILE_W = 100;
  const GRAB = { x: -10, y: -13 };         // where the pointer holds a file, from the middle of its icon

  const how = (...steps) => `<ol class="how">${steps.map((s) => `<li><span>${s}</span></li>`).join('')}</ol>`;
  const faq = (question, answer, open = false) => `<details class="fold faq" name="faq"${open ? ' open' : ''}><summary><span class="qa q">Q</span><span class="qt">${question}</span><i class="chev" aria-hidden="true"></i></summary>` +
    `<div class="reply"><span class="qa a">A</span><div class="text">${answer}</div></div></details>`;

  const QUESTIONS = [
    faq('How do I convert a file?', how('<b>Drag</b> a file in Explorer or on the desktop. Keep the left mouse button held.', 'Tap <kbd>Ctrl</kbd>. The wheel of formats opens.', '<b>Drop</b> the file on the format you want.') +
      '<p class="note">Changed your mind? Press <kbd>Esc</kbd> to close the wheel.</p>', true),
    faq('Can I convert several files at once?', '<p><b>Yes.</b> Select the files, then drag and tap <kbd>Ctrl</kbd> as usual.</p><p class="note">The wheel shows the formats that every selected file can become.</p>'),
    faq('Where do converted files go?', '<p>Right <b>next to the original</b>, in the same folder. The original is never changed.</p><figure class="fig pair" id="figPair"></figure>' +
      '<p class="note">Prefer one place for everything? Choose it under <b>Save conversions to</b> in General.</p><button class="btn" data-action="nav" data-v="general">Open General</button>'),
    faq('Can I use the right-click menu instead?', how('<b>Right-click</b> a file, then <b>Show more options</b> on Windows 11.', 'Choose <b>Convert with Pomelo</b>, then click a format.') +
      `<figure class="fig menus" role="img" aria-label="The Windows 11 right-click menu ends with Show more options. The classic menu it opens has Convert with Pomelo.">
        <div class="menu" aria-hidden="true"><span>Open</span><span>Pin to Quick access</span><hr><span>Copy</span><hr><span class="hot">Show more options</span></div>
        <i class="to" aria-hidden="true"></i>
        <div class="menu" aria-hidden="true"><span>Open</span><span class="hot"><img src="logo.png" width="14" height="14" alt="">Convert with Pomelo</span><span>Send to</span><hr><span>Copy</span></div>
      </figure>`),
    faq('Does Pomelo upload my files?', '<p><b>No.</b> Everything happens on this PC.</p><p class="note">Pomelo goes online only to check for updates or to add an engine, and only when you ask it to.</p>'),
    faq('A format I need is missing', '<p>Some conversions need an extra engine, such as the PDF components or LibreOffice.</p>' + how('Open <b>Engines</b> in the sidebar.', 'Press <b>Install</b> next to the one you need.') +
      '<button class="btn" data-action="nav" data-v="engines">Open Engines</button>'),
    faq('Where is Pomelo?', `<p>Pomelo lives in the <b>tray</b>, by the clock. Windows often tucks it behind the little arrow. Click its icon to open Settings.</p>
      <figure class="fig tray" role="img" aria-label="The Windows taskbar. Step 1: the arrow beside the clock opens a small pop-up. Step 2: the pop-up holds the Pomelo icon; click it to open Settings.">
        <ol class="how cap" aria-hidden="true"><li><span>Click the <b>arrow</b></span></li><li><span>Click the <b>Pomelo</b> icon</span></li></ol>
        <div class="taskbar" aria-hidden="true">
          <span class="caret"><i></i><em class="pin">1</em>
            <span class="flyout"><span class="app"></span><span class="app"></span><span class="app"></span><span class="app"></span>
              <span class="app me"><img src="logo.png" width="22" height="22" alt=""><em class="pin">2</em></span><span class="app"></span></span>
          </span>
          <span class="sys"></span><span class="sys"></span><span class="sys"></span>
          <span class="clock"><b>10:42</b><small>06/11/2026</small></span>
        </div>
      </figure>`),
  ];

  const TOUR = `<section class="tour tour-card" id="tour" aria-label="Animation: a file is dragged, Ctrl is tapped, and the file is dropped on a format">
    <div class="stage" id="stage" aria-hidden="true">
      <div class="win"><div class="bar"><span class="where">Documents</span><span class="ctl"><b></b><b></b><b></b></span></div><div class="files" id="files"></div></div>
      <div class="wheelbox"><svg class="wheel" id="wheel" viewBox="0 0 400 400"></svg></div>
      <div class="ghost" id="ghost"><svg viewBox="-26 -50 52 64"></svg><span id="ghostName"></span></div>
      <div class="keycap"><span>Tap</span><kbd>Ctrl</kbd></div>
      <div class="cursor"><svg viewBox="0 0 14 20" width="14" height="20"><path d="M1 1v14.2l3.6-3.2 2.5 5.7 2.4-1.1-2.4-5.5H12z"/></svg></div>
      <div class="toast">
        <div class="lead">
          <svg class="ring" viewBox="0 0 36 36"><circle class="track" cx="18" cy="18" r="14"/><circle class="value" cx="18" cy="18" r="14"/></svg>
          <span class="tick"><svg viewBox="0 0 24 24"><path d="M6.5 12.5l3.8 3.8 7.2-7.6"/></svg></span>
        </div>
        <div class="copy"><b class="t1" id="toastBusy"></b><b class="t2" id="toastDone"></b><small id="toastFile"></small></div>
      </div>
    </div>
    <ol class="tour-steps">
      <li class="s1"><span class="n">1</span><span><b>Drag</b> a file</span></li>
      <li class="s2"><span class="n">2</span><span>Tap <kbd>Ctrl</kbd></span></li>
      <li class="s3"><span class="n">3</span><span><b>Drop</b> on a format</span></li>
    </ol>
  </section>`;

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
    const added = fillTile(html('div', 'tile new'), made.info, made.name);
    added.append(html('span', 'tag', 'New'));
    $('figPair').setAttribute('role', 'img');
    $('figPair').setAttribute('aria-label', `${sample.name} and the new ${made.name}, in the same folder`);
    $('figPair').replaceChildren(fillTile(html('div', 'tile'), fileOf(sample), sample.name), added);
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

  // Builds the animation once the page is in the document, and moves on to the next sample file each time the loop starts again.
  async function start() {
    ({ samples } = await window.settingsApi.samples());
    if (!samples.length) { $('tour').remove(); return; }
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

  window.pomeloHelp = {
    page: () => `${TOUR}<section class="group"><div class="faq-list">${QUESTIONS.join('')}</div></section>` +
      '<div class="more"><button class="btn" data-action="website">More help on the website</button></div>',
    start,
  };
})();

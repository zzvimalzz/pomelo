// SPDX-License-Identifier: AGPL-3.0-or-later
// The editor's questions: a card over a veil on the picture. A classic script that adds window.editorDialogs.
(() => {
  const { el } = window.pomeloUi;
  const { loop } = window.pomeloCard;
  const FORMATS = [['same', 'Same'], ['jpg', 'JPG'], ['png', 'PNG'], ['webp', 'WebP'], ['avif', 'AVIF']];
  const WITH_QUALITY = ['jpg', 'webp', 'avif'];
  const MIN_EDGE = 16;

  const frame = () => window.pomeloCard.frame(document.getElementById('well'));

  function heading(box, title) {
    const h = el('h3', '', title);
    h.id = 'dialog-title';
    const head = el('div', 'uhead');
    head.append(h);
    box.append(head);
  }

  // Asks a question with its answers as buttons, drawn left to right with the last one as the main one. Resolves with the value of the
  // button chosen, or null on Esc.
  function choose(title, detail, buttons) {
    const { box, close } = frame();
    heading(box, title);
    if (detail) box.append(el('p', 'note', detail));
    const row = el('div', 'row');
    const made = buttons.map(({ label, primary }) => el('button', primary ? 'btn primary' : 'btn', label));
    row.append(...made);
    box.append(row);
    return new Promise((resolve) => {
      const done = (answer) => { close(); resolve(answer); };
      made.forEach((button, i) => { button.onclick = () => done(buttons[i].value); });
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); done(null); }
        else if (e.key === 'Tab') loop(e, made);
      });
      made[made.length - 1].focus();
    });
  }

  function chips(label, options, current, pick) {
    const group = el('div', 'chips');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', label);
    const buttons = options.map(([value, text]) => {
      const chip = el('button', 'chip', text);
      chip.type = 'button';
      chip.setAttribute('role', 'radio');
      chip.dataset.value = value;
      chip.onclick = () => { pick(value); paint(); };
      return chip;
    });
    const paint = () => { for (const chip of buttons) { const on = chip.dataset.value === current(); chip.classList.toggle('on', on); chip.setAttribute('aria-checked', String(on)); } };
    group.append(...buttons);
    return { group, paint, buttons };
  }

  const field = (label, ...content) => {
    const row = el('div', 'field');
    row.append(el('span', 'flabel', label), ...content);
    return row;
  };

  // The picture is { ext, writable, width, height }: its format, whether Save can write that format, and the size it will have. `qualities`
  // is the default quality of each format that has one. Resolves { format, quality, longEdge } (null where it does not apply), or null
  // when the user cancels.
  function saveCopy({ ext, writable, width, height }, qualities) {
    const { box, close } = frame();
    heading(box, 'Save a copy');
    const long = Math.max(width, height);
    const chosen = { format: writable ? 'same' : (ext === 'svg' ? 'png' : 'jpg'), quality: null, custom: false, edge: String(long) };
    const effective = () => (chosen.format === 'same' ? ext : chosen.format);
    const hasQuality = () => WITH_QUALITY.includes(effective());
    const reset = () => { chosen.quality = qualities[effective()] ?? null; };
    reset();

    const format = chips('Format', FORMATS.filter(([value]) => writable || value !== 'same'), () => chosen.format, (value) => { chosen.format = value; reset(); sync(); });
    const slider = el('input', 'range');
    slider.type = 'range';
    slider.min = '1';
    slider.max = '100';
    slider.setAttribute('aria-label', 'Quality');
    const level = el('span', 'level');
    const quality = field('Quality', slider, level);
    slider.oninput = () => { chosen.quality = Number(slider.value); level.textContent = slider.value; };
    const size = chips('Size', [['original', 'Original'], ['custom', 'Custom']], () => (chosen.custom ? 'custom' : 'original'), (value) => { chosen.custom = value === 'custom'; sync(); });
    const edge = el('input', 'fld');
    edge.type = 'number';
    edge.min = String(MIN_EDGE);
    edge.max = String(long);
    edge.setAttribute('aria-label', 'Long edge');
    const result = el('span', 'level');
    const custom = field('Long edge', edge, result);
    edge.oninput = () => { chosen.edge = edge.value; sync(); };
    const cancel = el('button', 'btn', 'Cancel');
    const save = el('button', 'btn primary', 'Save…');
    const row = el('div', 'row');
    row.append(cancel, save);
    box.append(field('Format', format.group), quality, field('Size', size.group), custom, row);

    const edgeValue = () => Number(chosen.edge);
    const edgeOk = () => Number.isInteger(edgeValue()) && edgeValue() >= MIN_EDGE && edgeValue() <= long;
    function sync() {
      format.paint();
      size.paint();
      quality.hidden = !hasQuality();
      slider.value = String(chosen.quality ?? 100);
      level.textContent = slider.value;
      custom.hidden = !chosen.custom;
      const ok = !chosen.custom || edgeOk();
      edge.value = chosen.edge;
      edge.toggleAttribute('aria-invalid', !ok);
      result.textContent = chosen.custom && ok ? `${Math.round(width * edgeValue() / long)} × ${Math.round(height * edgeValue() / long)}` : '';
      save.disabled = !ok;
    }
    sync();

    return new Promise((resolve) => {
      const done = (answer) => { close(); resolve(answer); };
      cancel.onclick = () => done(null);
      save.onclick = () => { if (!save.disabled) done({ format: chosen.format, quality: hasQuality() ? chosen.quality : null, longEdge: chosen.custom ? edgeValue() : null }); };
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); done(null); }
        else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); save.click(); }
        else if (e.key === 'Tab') loop(e, [...box.querySelectorAll('button, input')].filter((n) => !n.closest('[hidden]')));
      });
      save.focus();
    });
  }

  window.editorDialogs = { choose, saveCopy };
})();

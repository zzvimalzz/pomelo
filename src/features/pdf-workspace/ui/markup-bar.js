// SPDX-License-Identifier: AGPL-3.0-or-later
// The parts of the markup option bar that do not touch pdf.js: its buttons and groups, and the colours. Each colour row shows three colours
// and a fourth button that opens a panel of the whole palette. A classic script that adds window.workspaceMarkupBar.
(() => {
  const { el, icon } = window.pomeloUi;

  const palette = (names, defaults) => ({ defaults: names.slice(0, defaults), all: names });
  const HIGHLIGHT = palette([
    ['Yellow', '#ffd84d'], ['Green', '#7ee08a'], ['Pink', '#ff9fc0'], ['Blue', '#7cc4ff'], ['Orange', '#ffb366'], ['Purple', '#c9a6ff'],
    ['Red', '#ff8a8a'], ['Teal', '#7fe3d4'], ['Lime', '#d4ee6a'], ['Lavender', '#b8b8ff'], ['Peach', '#ffcba4'], ['Mint', '#a8f0c6'],
    ['Sky', '#a5d8ff'], ['Rose', '#ffc2d9'], ['Gold', '#ffe066'], ['Coral', '#ff9f80'], ['Aqua', '#66e0ff'], ['Lilac', '#e0b3ff'],
    ['Grey', '#d0d0d4'], ['Brown', '#d9b38c'], ['Olive', '#c5d86d'], ['Magenta', '#ff7ad9'], ['Indigo', '#8fa0ff'], ['Sand', '#f0e0a0'],
  ], 3);
  const INK = palette([
    ['Black', '#1c1c1e'], ['Red', '#e84d6f'], ['Blue', '#2b6cd4'], ['White', '#ffffff'], ['Dark grey', '#4a4a50'], ['Grey', '#8e8e93'],
    ['Light grey', '#d1d1d6'], ['Maroon', '#8c1d2f'], ['Crimson', '#d6336c'], ['Orange', '#f76707'], ['Amber', '#f59f00'], ['Yellow', '#fcc419'],
    ['Lime', '#82c91e'], ['Green', '#1e9e5a'], ['Dark green', '#206a3d'], ['Teal', '#0ca678'], ['Cyan', '#15aabf'], ['Sky', '#4dabf7'],
    ['Navy', '#1b2a5c'], ['Indigo', '#4263eb'], ['Violet', '#7048e8'], ['Purple', '#ae3ec9'], ['Pink', '#f783ac'], ['Brown', '#8c5a2b'],
  ], 3);

  let open = null;

  function group(name, kind) {
    const span = el('span', kind);
    span.setAttribute('role', 'radiogroup');
    span.setAttribute('aria-label', name);
    return span;
  }

  function radio(cls, title, checked, pick) {
    const b = el('button', cls);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(checked));
    b.title = title;
    b.setAttribute('aria-label', title);
    b.onclick = pick;
    return b;
  }

  function option(name, title, pressed, pick) {
    const b = el('button', 'opt');
    b.type = 'button';
    b.innerHTML = icon(name);
    b.append(title);
    b.setAttribute('aria-pressed', String(pressed));
    b.onclick = pick;
    return b;
  }

  function action(name, title, run) {
    const b = el('button', 'sm');
    b.type = 'button';
    b.innerHTML = icon(name);
    b.title = title;
    b.setAttribute('aria-label', title);
    b.onclick = run;
    return b;
  }

  const swatch = (title, value, current, pick) => {
    const b = radio('sw', title, current === value, () => pick(value));
    b.style.background = value;
    return b;
  };

  // `name` tells the panels of different bars apart, `pick(colour)` is called for a choice, `redraw()` after the panel is opened or shut.
  function colours({ set, name, label, current, pick, redraw }) {
    const row = group(label, 'swatches');
    const inDefaults = set.defaults.some(([, value]) => value === current);
    for (const [title, value] of set.defaults) row.append(swatch(title, value, current, pick));
    const more = radio('sw more', 'More colours', !inDefaults, () => { open = open === name ? null : name; redraw(); });
    more.setAttribute('aria-haspopup', 'true');
    more.setAttribute('aria-expanded', String(open === name));
    if (!inDefaults) more.style.background = current;
    row.append(more);
    if (open === name) {
      const panel = el('div', 'menu palette');
      panel.setAttribute('role', 'radiogroup');
      panel.setAttribute('aria-label', 'More colours');
      for (const [title, value] of set.all) panel.append(swatch(title, value, current, pick));
      row.append(panel);
    }
    return row;
  }

  window.workspaceMarkupBar = {
    HIGHLIGHT, INK, group, radio, option, action, colours,
    panelUp: () => open !== null,
    closePanel: () => { open = null; },
  };
})();

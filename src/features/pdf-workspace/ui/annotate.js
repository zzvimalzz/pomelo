// SPDX-License-Identifier: AGPL-3.0-or-later
// The Highlight, Draw and Text tools: buttons in the dock, an option bar for the tool in use, and the pdf.js annotation editor that does the
// drawing. What the editor holds is not written to the file as it is made. Before Save, before the Pages grid and before a copy is made it is
// flushed: with the PDF engine each entry becomes an operation (annot.add) and the engine writes the next version; without it pdf.js saves
// the file itself, for files up to the save limit. A classic script that adds window.workspaceAnnotate.
(() => {
  const { el, icon } = window.pomeloUi;
  const { label, bind } = window.workspaceKeys;
  const HIGHLIGHTS = [['Yellow', '#ffd84d'], ['Green', '#7ee08a'], ['Blue', '#7cc4ff'], ['Pink', '#ff9fc0'], ['Orange', '#ffb366']];
  const INKS = [['Black', '#1c1c1e'], ['Red', '#e84d6f'], ['Blue', '#2b6cd4'], ['Green', '#1e9e5a']];
  const WIDTHS = [1, 2, 4];
  const MARKER_WIDTH = 6;
  const MARKER_OPACITY = 0.4;
  const SIZES = { min: 6, max: 72 };
  const TOO_LARGE = 'Saving changes to a file this large needs the PDF engine.';
  const TOOLS = [['highlight', 'Highlight', 'highlight'], ['draw', 'Draw', 'pen'], ['text', 'Text', 'type']];

  const options = { highlight: HIGHLIGHTS[0][1], kind: 'pen', ink: INKS[0][1], width: 2, size: 12 };
  const listeners = [];
  let tool = null;
  let tab = null;
  let viewer = null;
  let eventBus = null;
  let lib = null;
  let limit = Infinity;
  let undoable = false;
  let redoable = false;
  let setTool = () => {};
  let bar = null;

  // pdf.js names the colours of its highlight picker; the option is a list of name=colour.
  const colours = HIGHLIGHTS.map(([name, value]) => `${name.toLowerCase()}=${value}`).join(',');

  // The entries of the editor that are markup: a form field's value is in the same storage and is not ours to write.
  function entries(pdf) {
    const { map } = pdf.annotationStorage.serializable;
    return map ? [...map.values()].filter((entry) => typeof entry.annotationType === 'number') : [];
  }

  function count() {
    tab.edited = !!tab.pdf && entries(tab.pdf).length > 0;
    for (const fn of listeners) fn();
  }

  // Turns the entries of the editor into operations. pdf.js gives points in the page's own space, counted from the bottom left; the viewport
  // turns them into points of the page as it is shown, from the top left, which is what the engine takes.
  async function operations(pdf, list) {
    const kinds = lib.AnnotationEditorType;
    const pages = new Map();
    const ops = [];
    for (const entry of list) {
      if (!pages.has(entry.pageIndex)) pages.set(entry.pageIndex, await pdf.getPage(entry.pageIndex + 1));
      const page = pages.get(entry.pageIndex);
      const viewport = page.getViewport({ scale: 1 });
      const shown = (flat) => { const out = []; for (let i = 0; i < flat.length; i += 2) out.push(...viewport.convertToViewportPoint(flat[i], flat[i + 1])); return out; };
      const base = { op: 'annot.add', page: entry.pageIndex + 1, color: entry.color };
      if (entry.annotationType === kinds.HIGHLIGHT && entry.quadPoints) {
        const flat = Array.from(entry.quadPoints);
        ops.push({ ...base, type: 'highlight', opacity: entry.opacity, quads: Array.from({ length: flat.length / 8 }, (_, i) => shown(flat.slice(i * 8, i * 8 + 8))) });
      } else if (entry.annotationType === kinds.INK) {
        ops.push({ ...base, type: 'ink', opacity: entry.opacity, thickness: entry.thickness, paths: entry.paths.points.map((stroke) => shown(Array.from(stroke))) });
      } else if (entry.annotationType === kinds.FREETEXT) {
        if (page.userUnit !== 1) throw new Error('A text box cannot be saved on a page that has its own scale.');
        ops.push({ ...base, type: 'freetext', rect: shown(entry.rect), text: entry.value, size: entry.fontSize });
      } else {
        throw new Error('This kind of markup cannot be saved.');
      }
    }
    return ops;
  }

  function putDown() {
    if (!viewer || viewer.annotationEditorMode === lib.AnnotationEditorType.NONE) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { eventBus.off('annotationeditormodechanged', done); resolve(); };
      eventBus.on('annotationeditormodechanged', done);
      setTool(null);
      setTimeout(done, 400);
    });
  }

  // Makes what the editor holds a version of the document. Resolves true when nothing is left to write, false when it was not written (a card
  // or a notice says why) and the markup is still in the editor. A written version makes the page read the document again.
  async function flush(target) {
    if (!target?.pdf) return true;
    if (target === tab) await putDown();
    const list = entries(target.pdf);
    if (!list.length) return true;
    const { token, size } = target.doc;
    let result;
    if (await window.workspaceApi.engine()) {
      try {
        result = await window.workspaceApi.apply(token, await operations(target.pdf, list));
      } catch (e) {
        await window.workspaceDialogs.choose("Can't save this markup", e.message, [{ label: 'OK', value: true, primary: true }]);
        return false;
      }
      if (result?.stop === 'no-engine') await window.workspaceDialogs.engineCard();
    } else if (size > limit) {
      await window.workspaceDialogs.engineCard(TOO_LARGE);
    } else {
      result = await window.workspaceApi.putRevision(token, await target.pdf.saveDocument());
    }
    return !!result?.info;
  }

  function step(way) {
    if (way === 'undo' ? undoable : redoable) eventBus.dispatch('editingaction', { source: viewer, name: way });
    else if (tab?.doc[way === 'undo' ? 'canUndo' : 'canRedo']) window.workspaceApi[way](tab.doc.token);
  }

  const send = (type, value) => eventBus.dispatch('switchannotationeditorparams', { source: viewer, type, value });

  function apply() {
    const params = lib.AnnotationEditorParamsType;
    if (tool === 'highlight') send(params.HIGHLIGHT_COLOR, options.highlight);
    if (tool === 'text') { send(params.FREETEXT_COLOR, options.ink); send(params.FREETEXT_SIZE, options.size); }
    if (tool === 'draw') {
      const marker = options.kind === 'marker';
      send(params.INK_COLOR, options.ink);
      send(params.INK_OPACITY, marker ? MARKER_OPACITY : 1);
      send(params.INK_THICKNESS, marker ? options.width * MARKER_WIDTH : options.width);
    }
  }

  const choose = (key, value) => () => { options[key] = value; draw(); apply(); };

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

  function swatches(set, key, name) {
    const span = group(name, 'swatches');
    for (const [title, value] of set) {
      const b = radio('sw', title, options[key] === value, choose(key, value));
      b.style.background = value;
      span.append(b);
    }
    return span;
  }

  function option(name, title, key, value) {
    const b = el('button', 'opt');
    b.type = 'button';
    b.innerHTML = icon(name);
    b.append(title);
    b.setAttribute('aria-pressed', String(options[key] === value));
    b.onclick = choose(key, value);
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

  function draw() {
    const parts = [];
    if (tool === 'highlight') parts.push(swatches(HIGHLIGHTS, 'highlight', 'Highlight colour'));
    if (tool === 'draw') {
      const widths = group('Thickness', 'swatches');
      for (const width of WIDTHS) {
        const b = radio('thick', `${width} pt`, options.width === width, choose('width', width));
        const dot = el('i');
        dot.style.width = dot.style.height = `${width * 2 + 3}px`;
        b.append(dot);
        widths.append(b);
      }
      parts.push(option('pen', 'Pen', 'kind', 'pen'), option('marker', 'Marker', 'kind', 'marker'), el('span', 'sep'), swatches(INKS, 'ink', 'Ink colour'), el('span', 'sep'), widths);
    }
    if (tool === 'text') {
      const resize = (by) => () => { options.size = Math.min(SIZES.max, Math.max(SIZES.min, options.size + by)); draw(); apply(); };
      parts.push(action('minus', 'Smaller', resize(-1)), el('span', 'size', `${options.size} pt`), action('plus', 'Larger', resize(1)), el('span', 'sep'), swatches(INKS, 'ink', 'Text colour'));
    }
    const undo = action('undo', `Undo (${label('undo')})`, () => step('undo'));
    const redo = action('redo', `Redo (${label('redo')})`, () => step('redo'));
    undo.disabled = !undoable && !tab?.doc.canUndo;
    redo.disabled = !redoable && !tab?.doc.canRedo;
    bar.replaceChildren(...parts, el('span', 'sep'), undo, redo);
  }

  function watch(pdfViewer, bus, container, viewerLib) {
    viewer = pdfViewer;
    eventBus = bus;
    lib = viewerLib;
    const modes = { highlight: lib.AnnotationEditorType.HIGHLIGHT, draw: lib.AnnotationEditorType.INK, text: lib.AnnotationEditorType.FREETEXT };
    bar = el('div', 'optbar');
    bar.hidden = true;
    bar.addEventListener('mousedown', (e) => e.preventDefault());
    document.querySelector('.well').append(bar);
    const buttons = new Map();
    for (const [id, title, name] of TOOLS) {
      const b = el('button', 'tool');
      b.type = 'button';
      b.innerHTML = `${icon(name)}<span class="lbl">${title}</span>`;
      b.title = `${title} (${label(id)})`;
      b.setAttribute('aria-label', title);
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.onclick = () => setTool(tool === id ? null : id);
      buttons.set(id, b);
      bind(id, () => { if (!tab?.pdf) return false; setTool(tool === id ? null : id); });
    }
    document.querySelector('.dock .tools').prepend(...buttons.values(), el('span', 'sep'));

    setTool = (next) => {
      if (next && !tab?.pdf) return;
      if (next) window.workspaceOrganise.leave();
      tool = next;
      for (const [id, b] of buttons) {
        b.classList.toggle('on', id === tool);
        b.setAttribute('aria-pressed', String(id === tool));
      }
      document.body.classList.toggle('tooling', !!tool);
      bar.hidden = !tool;
      viewer.annotationEditorMode = { mode: tool ? modes[tool] : lib.AnnotationEditorType.NONE };
      if (tool) { apply(); draw(); } else container.focus();
    };
    bind('escape', () => { if (!tool) return false; setTool(null); });
    eventBus.on('editingstateschanged', ({ details }) => {
      undoable = !!details.hasSomethingToUndo;
      redoable = !!details.hasSomethingToRedo;
      if (tool) draw();
      setTimeout(() => { if (tab?.pdf) count(); });
    });
    // pdf.js puts the tool down when it loads another document.
    eventBus.on('pagesdestroy', () => {
      tool = null;
      undoable = redoable = false;
      for (const b of buttons.values()) { b.classList.remove('on'); b.setAttribute('aria-pressed', 'false'); }
      document.body.classList.remove('tooling');
      bar.hidden = true;
    });
  }

  window.workspaceAnnotate = {
    watch,
    colours,
    use: (next) => { tab = next; },
    setLimit: (bytes) => { limit = bytes; },
    pending: (target) => !!target?.edited,
    flush,
    listen: (fn) => listeners.push(fn),
  };
})();

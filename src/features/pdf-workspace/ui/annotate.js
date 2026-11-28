// SPDX-License-Identifier: AGPL-3.0-or-later
// The Select, Highlight, Draw and Text tools: buttons in the dock, an option bar for the tool in use, and the pdf.js annotation editor that
// does the drawing. What the editor holds is not written to the file as it is made. Before Save, before the Pages grid and before a copy is made it is
// flushed: with the PDF engine each entry becomes an operation (annot.add) and the engine writes the next version; without it pdf.js saves
// the file itself, for files up to the save limit. A classic script that adds window.workspaceAnnotate.
(() => {
  const { el, icon } = window.pomeloUi;
  const { label, bind } = window.workspaceKeys;
  const ui = window.workspaceMarkupBar;
  const { group, radio, option, action } = ui;
  const WIDTHS = [1, 2, 4];
  const MARKER_WIDTH = 6;
  const MARKER_OPACITY = 0.4;
  const SIZES = { min: 6, max: 72 };
  const FONTS = ['Helvetica', 'Times', 'Courier'];
  const TOO_LARGE = 'Saving changes to a file this large needs the PDF engine.';
  const TOOLS = [['select', 'Select', 'cursor'], ['highlight', 'Highlight', 'highlight'], ['draw', 'Draw', 'pen'], ['text', 'Text', 'type'], ['eraser', 'Eraser', 'eraser']];
  const EDITORS = '.inkEditor, .freeTextEditor, .highlightEditor';

  const options = { highlight: ui.HIGHLIGHT.defaults[0][1], kind: 'pen', ink: ui.INK.defaults[0][1], width: 2, size: 12, font: FONTS[0] };
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
  let manager = null;
  let drawing = false;
  let selecting = false;
  let erasing = false;
  let pill = null;
  let dot = null;
  let rubber = null;
  const fonts = new Map();

  // pdf.js names the colours of the picker of a selected highlight; the option is a list of name=colour.
  const colours = ui.HIGHLIGHT.all.slice(0, 8).map(([name, value]) => `${name.toLowerCase()}=${value}`).join(',');

  // The entries of the editor that are markup: a form field's value is in the same storage and is not ours to write. A text box carries
  // the font chosen for it, which pdf.js does not keep.
  function entries(pdf) {
    const { map } = pdf.annotationStorage.serializable;
    return map ? [...map].filter(([, entry]) => typeof entry.annotationType === 'number').map(([id, entry]) => ({ ...entry, font: fonts.get(id) ?? FONTS[0] })) : [];
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
      const stroke = (points) => points.map((line) => shown(Array.from(line)));
      if (entry.annotationType === kinds.HIGHLIGHT && entry.quadPoints) {
        const flat = Array.from(entry.quadPoints);
        ops.push({ ...base, type: 'highlight', opacity: entry.opacity, quads: Array.from({ length: flat.length / 8 }, (_, i) => shown(flat.slice(i * 8, i * 8 + 8))) });
      } else if (entry.annotationType === kinds.HIGHLIGHT && entry.outlines) {
        ops.push({ ...base, type: 'ink', opacity: entry.opacity, thickness: entry.thickness, paths: stroke(entry.outlines.points) });
      } else if (entry.annotationType === kinds.INK) {
        ops.push({ ...base, type: 'ink', opacity: entry.opacity, thickness: entry.thickness, paths: stroke(entry.paths.points) });
      } else if (entry.annotationType === kinds.FREETEXT) {
        if (page.userUnit !== 1) throw new Error('A text box cannot be saved on a page that has its own scale.');
        ops.push({ ...base, type: 'freetext', rect: shown(entry.rect), text: entry.value, size: entry.fontSize, font: entry.font });
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
  const dispatch = (name) => eventBus.dispatch('editingaction', { source: viewer, name });

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
    dot.style.background = options.highlight;
  }

  // A new choice is for the marks still to come. pdf.js applies it to the stroke being drawn and to the selected marks, so for Draw they
  // are let go first: the first call ends the stroke, which selects it, and the second lets it go.
  const choose = (key, value) => () => {
    options[key] = value;
    ui.closePanel();
    if (key === 'font') {
      for (const box of document.querySelectorAll('.freeTextEditor.selectedEditor')) { fonts.set(box.id, value); box.dataset.font = value; }
    } else if (tool === 'draw') { manager?.unselectAll(); manager?.unselectAll(); }
    draw();
    apply();
  };

  // The eraser takes the mark under the pointer. It goes through the editor's own delete, so Undo brings the mark back.
  function erase(box) {
    const editor = manager?.getEditor(box.id);
    if (!editor) return;
    manager.setSelected(editor);
    manager.delete();
  }

  function sync() {
    const grid = !tool && document.body.classList.contains('tooling');
    pill.hidden = !tab?.pdf || grid;
    pill.undo.disabled = !(undoable || tab?.doc.canUndo);
    pill.redo.disabled = !(redoable || tab?.doc.canRedo);
    pill.clear.disabled = !tab?.edited;
  }

  const colourRow = (set, key, label) => ui.colours({ set, name: tool, label, current: options[key], pick: (value) => choose(key, value)(), redraw: draw });

  const choice = (name, title, key, value) => option(name, title, options[key] === value, choose(key, value));

  function draw() {
    const parts = [];
    if (tool === 'highlight') parts.push(colourRow(ui.HIGHLIGHT, 'highlight', 'Highlight colour'));
    if (tool === 'draw') {
      const widths = group('Thickness', 'swatches');
      for (const width of WIDTHS) {
        const b = radio('thick', `${width} pt`, options.width === width, choose('width', width));
        const blob = el('i');
        blob.style.width = blob.style.height = `${width * 2 + 3}px`;
        b.append(blob);
        widths.append(b);
      }
      parts.push(choice('pen', 'Pen', 'kind', 'pen'), choice('marker', 'Marker', 'kind', 'marker'), el('span', 'sep'), colourRow(ui.INK, 'ink', 'Ink colour'), el('span', 'sep'), widths);
    }
    if (tool === 'text') {
      const resize = (by) => () => { options.size = Math.min(SIZES.max, Math.max(SIZES.min, options.size + by)); draw(); apply(); };
      const faces = group('Font', 'swatches');
      for (const name of FONTS) {
        const b = radio('face', name, options.font === name, choose('font', name));
        b.dataset.font = name;
        b.textContent = 'Aa';
        faces.append(b);
      }
      parts.push(action('minus', 'Smaller', resize(-1)), el('span', 'size', `${options.size} pt`), action('plus', 'Larger', resize(1)), el('span', 'sep'), colourRow(ui.INK, 'ink', 'Text colour'), el('span', 'sep'), faces);
    }
    bar.replaceChildren(...parts);
  }

  function watch(pdfViewer, bus, container, viewerLib) {
    viewer = pdfViewer;
    eventBus = bus;
    lib = viewerLib;
    const modes = { select: lib.AnnotationEditorType.STAMP, highlight: lib.AnnotationEditorType.HIGHLIGHT, draw: lib.AnnotationEditorType.INK, text: lib.AnnotationEditorType.FREETEXT, eraser: lib.AnnotationEditorType.STAMP };
    bar = el('div', 'optbar');
    bar.hidden = true;
    bar.addEventListener('mousedown', (e) => e.preventDefault());
    dot = el('div', 'hdot');
    dot.hidden = true;
    rubber = el('div', 'ecur');
    rubber.innerHTML = icon('eraser');
    rubber.hidden = true;
    pill = el('div', 'editpill');
    pill.hidden = true;
    pill.addEventListener('mousedown', (e) => e.preventDefault());
    const everything = () => { dispatch('selectAll'); dispatch('delete'); };
    for (const [way, name, text, run] of [['undo', 'undo', `Undo (${label('undo')})`, () => step('undo')], ['redo', 'redo', `Redo (${label('redo')})`, () => step('redo')], ['clear', 'trash', 'Clear all', everything]]) {
      pill[way] = action(name, text, run);
      pill.append(pill[way]);
    }
    document.querySelector('.well').append(bar, pill);
    document.body.append(dot, rubber);
    new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    const remember = ({ source }) => { if (typeof source?.unselectAll === 'function') manager = source; };
    eventBus.on('editingstateschanged', remember);
    eventBus.on('annotationeditorparamschanged', remember);

    // Over a page the highlighter is a dot of its colour, except over the words, where pdf.js's own cursor shows that a drag selects them.
    // A drag that began on the dot keeps it, wherever it goes, and a drag that began on a word keeps the words' cursor.
    container.addEventListener('pointermove', (e) => {
      const aim = tool === 'highlight' && !selecting && !!e.target.closest?.('.textLayer') && !e.target.closest('.textLayer span:not([role="img"])');
      dot.hidden = !(drawing || aim);
      if (!dot.hidden) dot.style.transform = `translate(${e.clientX - 9}px, ${e.clientY - 9}px)`;
    }, true);
    container.addEventListener('pointerleave', () => { if (!drawing) dot.hidden = true; });
    container.addEventListener('pointerdown', (e) => {
      const left = tool === 'highlight' && e.button === 0;
      drawing = left && !dot.hidden;
      selecting = left && !drawing && !!e.target.closest?.('.textLayer span:not([role="img"])');
      if (selecting) document.body.dataset.selecting = '';
    }, true);
    window.addEventListener('pointerup', () => { drawing = selecting = erasing = false; delete document.body.dataset.selecting; });
    container.addEventListener('pointerdown', (e) => {
      if (tool !== 'eraser' || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      erasing = true;
      const box = e.target.closest?.(EDITORS);
      if (box) erase(box);
    }, true);
    container.addEventListener('pointerleave', () => { rubber.hidden = true; });
    container.addEventListener('pointermove', (e) => {
      rubber.hidden = tool !== 'eraser';
      if (!rubber.hidden) rubber.style.transform = `translate(${e.clientX - 5}px, ${e.clientY - 25}px)`;
      const box = erasing && document.elementFromPoint(e.clientX, e.clientY)?.closest(EDITORS);
      if (box) erase(box);
    }, true);
    document.addEventListener('pointerdown', (e) => {
      if (ui.panelUp() && !e.target.closest('.palette, .sw.more')) { ui.closePanel(); draw(); }
    }, true);

    const tag = (node) => {
      if (node.nodeType !== 1) return;
      for (const box of node.matches(EDITORS) ? [node] : node.querySelectorAll(EDITORS)) {
        if (box.matches('.freeTextEditor')) {
          if (!fonts.has(box.id)) fonts.set(box.id, options.font);
          box.dataset.font = fonts.get(box.id);
        }
      }
      for (const remove of node.matches('.deleteButton') ? [node] : node.querySelectorAll('.deleteButton')) remove.innerHTML = icon('trash');
    };
    new MutationObserver((records) => { for (const r of records) r.addedNodes.forEach(tag); }).observe(container, { childList: true, subtree: true });
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
      drawing = selecting = erasing = false;
      delete document.body.dataset.selecting;
      rubber.hidden = true;
      dot.hidden = true;
      ui.closePanel();
      for (const [id, b] of buttons) {
        b.classList.toggle('on', id === tool);
        b.setAttribute('aria-pressed', String(id === tool));
      }
      document.body.classList.toggle('tooling', !!tool);
      if (tool) document.body.dataset.tool = tool;
      else delete document.body.dataset.tool;
      viewer.annotationEditorMode = { mode: tool ? modes[tool] : lib.AnnotationEditorType.NONE };
      if (tool === 'eraser') manager?.unselectAll();
      if (tool) { apply(); draw(); } else container.focus();
      bar.hidden = !tool || !bar.children.length;
    };
    bind('escape', () => {
      if (ui.panelUp()) { ui.closePanel(); draw(); return; }
      if (!tool) return false;
      setTool(null);
    });
    eventBus.on('editingstateschanged', ({ details }) => {
      undoable = !!details.hasSomethingToUndo;
      redoable = !!details.hasSomethingToRedo;
      if (details.hasSelectedEditor && tool === 'highlight') manager?.unselectAll();
      sync();
      setTimeout(() => { if (tab?.pdf) count(); });
    });
    // pdf.js puts the tool down when it loads another document.
    eventBus.on('pagesdestroy', () => {
      tool = null;
      erasing = selecting = false;
      delete document.body.dataset.selecting;
      undoable = redoable = false;
      fonts.clear();
      ui.closePanel();
      for (const b of buttons.values()) { b.classList.remove('on'); b.setAttribute('aria-pressed', 'false'); }
      document.body.classList.remove('tooling');
      delete document.body.dataset.tool;
      dot.hidden = rubber.hidden = true;
      bar.hidden = true;
      sync();
    });
  }

  window.workspaceAnnotate = {
    watch,
    colours,
    use: (next) => { tab = next; sync(); },
    sync,
    setLimit: (bytes) => { limit = bytes; },
    pending: (target) => !!target?.edited,
    flush,
    listen: (fn) => listeners.push(fn),
  };
})();

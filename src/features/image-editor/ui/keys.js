// SPDX-License-Identifier: AGPL-3.0-or-later
// Every keyboard shortcut of the editor in one table, so a tooltip and the key that does the job cannot drift apart. A classic script
// that adds window.editorKeys: label(id) for tooltips and bind(id, fn) to give a shortcut its action.
(() => {
  const TABLE = {
    redo: { keys: ['Ctrl+y', 'Ctrl+Y', 'Ctrl+Shift+Z'], label: 'Ctrl+Y' },
    undo: { keys: ['Ctrl+z', 'Ctrl+Z'], label: 'Ctrl+Z' },
    saveCopy: { keys: ['Ctrl+Shift+S'], label: 'Ctrl+Shift+S' },
    save: { keys: ['Ctrl+s', 'Ctrl+S'], label: 'Ctrl+S' },
    compare: { keys: ['\\'], label: '\\' },
    rotateLeft: { keys: ['Shift+R'], label: 'Shift+R' },
    rotateRight: { keys: ['r', 'R'], label: 'R' },
    fit: { keys: ['Ctrl+0'], label: 'Ctrl+0' },
    actualSize: { keys: ['Ctrl+1'], label: 'Ctrl+1' },
    zoomIn: { keys: ['Ctrl+=', 'Ctrl++'], label: 'Ctrl+=' },
    zoomOut: { keys: ['Ctrl+-'], label: 'Ctrl+-' },
    adjust: { keys: ['a', 'A'], label: 'A' },
    presets: { keys: ['p', 'P'], label: 'P' },
    crop: { keys: ['c', 'C'], label: 'C' },
    panel: { keys: ['Ctrl+b', 'Ctrl+B'], label: 'Ctrl+B' },
    fullScreen: { keys: ['F11'], label: 'F11' },
    escape: { keys: ['Escape'], label: 'Esc' },
  };
  const actions = {};

  const label = (id) => TABLE[id].label;
  const matches = (e, combo) => {
    const [, modifiers, key] = /^((?:(?:Ctrl|Alt|Shift)\+)*)(.+)$/.exec(combo);
    const wants = (modifier) => modifiers.includes(`${modifier}+`);
    return e.ctrlKey === wants('Ctrl') && e.altKey === wants('Alt') && (!wants('Shift') || e.shiftKey) && !e.metaKey && e.key === key;
  };

  function bind(id, fn) {
    (actions[id] ??= []).push(fn);
  }

  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return;
    if (window.pomeloCard.isOpen()) return;
    const id = Object.keys(TABLE).find((k) => TABLE[k].keys.some((combo) => matches(e, combo)));
    if (!id || (!e.ctrlKey && e.target.closest?.('input, textarea, select'))) return;
    if (actions[id]?.some((fn) => fn(e) !== false)) e.preventDefault();
  });

  window.editorKeys = { label, bind };
})();

// SPDX-License-Identifier: AGPL-3.0-or-later
// Every keyboard shortcut of the workspace in one table, so a tooltip and the key that does the job cannot drift apart. A classic
// script that adds window.workspaceKeys: label(id) for tooltips and bind(id, fn) to give a shortcut its action.
(() => {
  const TABLE = {
    fitWidth: { keys: ['Ctrl+0'], label: 'Ctrl+0' },
    actualSize: { keys: ['Ctrl+1'], label: 'Ctrl+1' },
    zoomIn: { keys: ['Ctrl+=', 'Ctrl++'], label: 'Ctrl+=' },
    zoomOut: { keys: ['Ctrl+-'], label: 'Ctrl+−' },
    nextPage: { keys: ['PageDown', 'ArrowRight', 'ArrowDown'], label: 'Page Down' },
    previousPage: { keys: ['PageUp', 'ArrowLeft', 'ArrowUp'], label: 'Page Up' },
    focusReading: { keys: ['F11'], label: 'F11' },
    pages: { keys: ['p', 'P'], label: 'P' },
    find: { keys: ['Ctrl+f', 'Ctrl+F'], label: 'Ctrl+F' },
    documentPanel: { keys: ['Ctrl+d', 'Ctrl+D'], label: 'Ctrl+D' },
    saveCopy: { keys: ['Ctrl+Shift+S'], label: 'Ctrl+Shift+S' },
    save: { keys: ['Ctrl+s', 'Ctrl+S'], label: 'Ctrl+S' },
    redo: { keys: ['Ctrl+y', 'Ctrl+Y', 'Ctrl+Shift+Z'], label: 'Ctrl+Y' },
    undo: { keys: ['Ctrl+z', 'Ctrl+Z'], label: 'Ctrl+Z' },
    deletePages: { keys: ['Delete'], label: 'Del' },
    back: { keys: ['Alt+ArrowLeft'], label: 'Alt+Left' },
    forward: { keys: ['Alt+ArrowRight'], label: 'Alt+Right' },
    escape: { keys: ['Escape'], label: 'Esc' },
  };
  const actions = {};

  const label = (id) => TABLE[id].label;
  const matches = (e, combo) => {
    const [, modifiers, key] = /^((?:(?:Ctrl|Alt|Shift)\+)*)(.+)$/.exec(combo);
    const wants = (modifier) => modifiers.includes(`${modifier}+`);
    return e.ctrlKey === wants('Ctrl') && e.altKey === wants('Alt') && (!wants('Shift') || e.shiftKey) && !e.metaKey && e.key === key;
  };
  const typing = (e) => e.target.closest('input, textarea, [contenteditable="true"]');

  function bind(id, fn) {
    (actions[id] ??= []).push(fn);
  }

  // On window, so a card or a field that closes itself on Esc has already used the key by the time it gets here.
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return;
    const id = Object.keys(TABLE).find((k) => TABLE[k].keys.some((combo) => matches(e, combo)));
    if (!id || !actions[id] || (id !== 'escape' && window.workspaceDialogs.isOpen())) return;
    if (typing(e) && id !== 'focusReading' && (!e.ctrlKey || id === 'undo' || id === 'redo')) return;
    if (actions[id].some((fn) => fn(e) !== false)) e.preventDefault();
  });

  window.workspaceKeys = { label, bind };
})();

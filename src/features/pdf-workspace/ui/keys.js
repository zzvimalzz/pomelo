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
    find: { keys: ['Ctrl+f', 'Ctrl+F'], label: 'Ctrl+F' },
    back: { keys: ['Alt+ArrowLeft'], label: 'Alt+Left' },
    forward: { keys: ['Alt+ArrowRight'], label: 'Alt+Right' },
    escape: { keys: ['Escape'], label: 'Esc' },
  };
  const actions = {};

  const label = (id) => TABLE[id].label;
  const matches = (e, combo) => {
    const [, modifier, key] = /^(?:(Ctrl|Alt)\+)?(.+)$/.exec(combo);
    return e.ctrlKey === (modifier === 'Ctrl') && e.altKey === (modifier === 'Alt') && !e.metaKey && e.key === key;
  };
  const typing = (e) => e.target.closest('input, textarea, [contenteditable="true"]');

  function bind(id, fn) {
    (actions[id] ??= []).push(fn);
  }

  // On window, so a card or a field that closes itself on Esc has already used the key by the time it gets here.
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return;
    const id = Object.keys(TABLE).find((k) => TABLE[k].keys.some((combo) => matches(e, combo)));
    if (!id || !actions[id]) return;
    if (typing(e) && id !== 'focusReading' && !e.ctrlKey) return;
    if (actions[id].some((fn) => fn(e) !== false)) e.preventDefault();
  });

  window.workspaceKeys = { label, bind };
})();

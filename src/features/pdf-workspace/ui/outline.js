// SPDX-License-Identifier: AGPL-3.0-or-later
// The Outline tab: the document's bookmarks as a tree that folds. A click goes to the bookmark's page, a chevron or the arrow keys fold
// and unfold. Titles are text from the file and only ever go in as text. A classic script that adds window.workspaceOutline.
(() => {
  const { el, icon } = window.pomeloUi;

  async function fill(list, pdf, linkService, container) {
    const outline = await pdf.getOutline().catch(() => null);
    if (!outline || !outline.length) {
      list.replaceChildren(el('p', 'empty', 'This document has no bookmarks'));
      return;
    }
    const tree = el('ul', 'tree');
    tree.setAttribute('role', 'tree');
    const state = new WeakMap();
    let rover = null;

    function group(items) {
      const ul = el('ul');
      ul.setAttribute('role', 'group');
      ul.append(...items.map(node));
      return ul;
    }

    // Children are built the first time their parent is unfolded, so a long outline costs only what is shown.
    function fold(li, on = li.getAttribute('aria-expanded') !== 'true') {
      const s = state.get(li);
      if (on && !s.group) {
        s.group = group(s.item.items);
        li.append(s.group);
      }
      if (s.group) s.group.hidden = !on;
      li.setAttribute('aria-expanded', String(on));
    }

    function node(item) {
      const li = el('li');
      li.setAttribute('role', 'treeitem');
      state.set(li, { item, group: null });
      const row = el('div', `orow${item.bold ? ' obold' : ''}${item.italic ? ' oital' : ''}`);
      row.tabIndex = -1;
      const chevron = el('span', 'otog');
      if (item.items.length) chevron.innerHTML = icon('right');
      row.append(chevron, el('span', '', item.title));
      li.append(row);
      if (item.items.length) fold(li, !(item.count < 0));
      return li;
    }

    // A bookmark that links to a web page or runs an action has no destination here, so it is shown and does nothing.
    function activate(row, onChevron) {
      const li = row.parentElement;
      const { item } = state.get(li);
      if (item.items.length && (onChevron || !item.dest)) fold(li);
      else if (item.dest) {
        linkService.goToDestination(item.dest);
        container.focus();
      }
    }

    tree.addEventListener('click', (e) => {
      const row = e.target.closest('.orow');
      if (row) activate(row, !!e.target.closest('.otog'));
    });
    tree.addEventListener('focusin', (e) => {
      const row = e.target.closest('.orow');
      if (!row || row === rover) return;
      rover.tabIndex = -1;
      row.tabIndex = 0;
      rover = row;
    });
    tree.addEventListener('keydown', (e) => {
      const row = e.target.closest('.orow');
      if (!row) return;
      const li = row.parentElement;
      const parent = li.parentElement.closest('li');
      const open = li.getAttribute('aria-expanded') === 'true';
      const rows = [...tree.querySelectorAll('.orow')].filter((r) => !r.closest('[hidden]'));
      const next = rows[rows.indexOf(row) + 1];
      if (e.key === 'ArrowDown') next?.focus();
      else if (e.key === 'ArrowUp') rows[rows.indexOf(row) - 1]?.focus();
      else if (e.key === 'ArrowRight' && li.hasAttribute('aria-expanded')) { if (open) next.focus(); else fold(li, true); }
      else if (e.key === 'ArrowLeft') { if (open) fold(li, false); else parent?.firstChild.focus(); }
      else if (e.key === 'Enter' || e.key === ' ') activate(row, false);
      else return;
      e.preventDefault();
    });

    tree.append(...outline.map(node));
    rover = tree.querySelector('.orow');
    rover.tabIndex = 0;
    list.replaceChildren(tree);
  }

  window.workspaceOutline = { fill };
})();

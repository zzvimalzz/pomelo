// SPDX-License-Identifier: AGPL-3.0-or-later
// Find in the document: a bar at the top of the well, opened by the title row's button or Ctrl+F. pdf.js's find controller does the
// matching, the counting and the highlighting; this sends it the question and shows what it answers, and gives the list of hits in its
// own panel and the marks beside the scroll bar the same view of the matches. A classic script that adds window.workspaceSearch.
(() => {
  const { el, icon } = window.pomeloUi;
  const { label, bind } = window.workspaceKeys;
  const NOT_FOUND = 1;
  const button = document.getElementById('findbtn');
  let current = null;

  button.innerHTML = icon('search');
  button.title = `Find (${label('find')})`;
  button.setAttribute('aria-label', 'Find');

  function tool(cls, text, content) {
    const b = el('button', cls);
    b.type = 'button';
    b.title = text;
    b.setAttribute('aria-label', text);
    if (content.startsWith('<')) b.innerHTML = content; else b.textContent = content;
    return b;
  }

  function watch(pdf, viewer, eventBus, container) {
    const bar = el('div', 'findbar');
    bar.hidden = true;
    bar.setAttribute('role', 'search');
    const glass = el('span', 'lens');
    glass.innerHTML = icon('search');
    const input = el('input');
    input.placeholder = 'Find in document';
    input.setAttribute('aria-label', 'Find in document');
    input.spellcheck = false;
    const count = el('span', 'count');
    count.setAttribute('aria-live', 'polite');
    const matchCase = tool('opt', 'Match case', 'Aa');
    const wholeWords = tool('opt', 'Whole words', 'W');
    const listing = tool('sm', 'Show all results', icon('list'));
    const previous = tool('sm', 'Previous (Shift+Enter)', icon('up'));
    const next = tool('sm', 'Next (Enter)', icon('down'));
    const close = tool('sm', `Close (${label('escape')})`, icon('close'));
    bar.append(glass, input, count, matchCase, wholeWords, listing, previous, next, close);
    document.querySelector('.well').append(bar);

    const on = (b) => b.getAttribute('aria-pressed') === 'true';
    const ask = (type, backwards = false) => {
      if (type !== 'again') window.workspaceResults.reset();
      eventBus.dispatch('find', {
      source: bar, type, query: input.value.trim(), caseSensitive: on(matchCase), entireWord: on(wholeWords), highlightAll: true, findPrevious: backwards,
      });
    };

    // pdf.js keeps the place of every match on the controller, page by page and in order, and has no call to go to a given one, so the
    // list and the marks read what it keeps and a click on a row sets the match it would have stepped to. The version is pinned.
    let starts = [];
    let total = 0;
    let now = -1;
    let state = 0;
    const finder = viewer.findController;
    const hits = {
      count: () => total,
      current: () => now,
      locate(n) {
        let low = 0;
        let high = starts.length - 1;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          if (starts[mid] <= n) low = mid; else high = mid - 1;
        }
        return { page: low, index: n - starts[low] };
      },
      offset: (page, index) => finder.pageMatches[page][index],
      length: (page, index) => finder.pageMatchesLength[page][index],
      fraction: (page, index) => Math.min(1, finder.pageMatches[page][index] / Math.max(1, finder._pageContents[page]?.length ?? 1)),
      jump(n) {
        const { page, index } = hits.locate(n);
        Object.assign(finder.selected, { pageIdx: page, matchIdx: index });
        Object.assign(finder._offset, { pageIdx: page, matchIdx: index, wrapped: false });
        finder._scrollMatches = true;
        viewer.currentPageNumber = page + 1;
        eventBus.dispatch('updatetextlayermatches', { source: finder, pageIndex: -1 });
        now = n;
        count.textContent = `${n + 1} of ${total}`;
        refresh();
      },
    };
    let queued = false;
    function refresh() {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        starts = [];
        total = 0;
        for (let page = 0; page < viewer.pagesCount; page++) {
          starts.push(total);
          total += finder.pageMatches[page]?.length ?? 0;
        }
        if (bar.hidden) total = 0;
        window.workspaceResults.draw(state === NOT_FOUND && !!input.value.trim());
        window.workspaceTicks.draw();
      });
    }
    window.workspaceResults.watch(pdf, hits, container);
    window.workspaceTicks.watch(hits, viewer, container);
    window.workspaceResults.onchange = (on) => listing.setAttribute('aria-pressed', String(on));
    listing.setAttribute('aria-pressed', 'false');
    listing.onclick = () => window.workspaceResults.toggle();
    eventBus.on('scalechanging', refresh);
    eventBus.on('spreadmodechanged', refresh);

    const show = ({ current, total: all }) => {
      now = current - 1;
      if (all) count.textContent = `${current} of ${all}`;
      else count.textContent = state === NOT_FOUND && input.value.trim() ? 'No results' : '';
      refresh();
    };
    eventBus.on('updatefindmatchescount', ({ matchesCount }) => show(matchesCount));
    eventBus.on('updatefindcontrolstate', ({ state: found, matchesCount }) => { state = found; show(matchesCount); });

    function open() {
      bar.hidden = false;
      button.setAttribute('aria-pressed', 'true');
      input.focus();
      input.select();
      if (input.value.trim()) ask('');
    }
    function shut() {
      bar.hidden = true;
      window.workspaceResults.hide();
      refresh();
      button.setAttribute('aria-pressed', 'false');
      eventBus.dispatch('findbarclose', { source: bar });
      container.focus();
    }

    input.oninput = () => ask('');
    input.onkeydown = (e) => {
      if (e.key === 'Enter') ask('again', e.shiftKey);
      else if (e.key === 'Escape') shut();
      else return;
      e.preventDefault();
    };
    for (const b of [matchCase, wholeWords]) {
      b.setAttribute('aria-pressed', 'false');
      b.onclick = () => { b.setAttribute('aria-pressed', String(!on(b))); ask(b === matchCase ? 'casesensitivitychange' : 'entirewordchange'); input.focus(); };
    }
    previous.onclick = () => { ask('again', true); input.focus(); };
    next.onclick = () => { ask('again'); input.focus(); };
    close.onclick = shut;
    button.onclick = () => (bar.hidden ? open() : shut());
    // The focus stays where it is: a click on a button here must not take the keys from the field or the document.
    for (const part of [button, bar]) part.addEventListener('mousedown', (e) => { if (e.target !== input) e.preventDefault(); });
    eventBus.on('pagesinit', () => { button.disabled = false; });

    bind('find', () => open());
    current = { bar, shut };
  }

  // Bound when the page loads, ahead of focus reading's own Esc: the bar closes first.
  bind('escape', () => (current && !current.bar.hidden ? (current.shut(), true) : false));

  window.workspaceSearch = { watch };
})();

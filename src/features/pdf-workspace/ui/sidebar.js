// SPDX-License-Identifier: AGPL-3.0-or-later
// The left panel: a switch between the pages (a thumbnail for every page, the page in view outlined, a click goes to it) and the outline.
// The title row's button slides it open and shut; nothing is built or drawn until a tab is first shown. A classic script that adds
// window.workspaceSidebar.
(() => {
  const { el, icon } = window.pomeloUi;
  const SLIDE = 350;
  const panel = document.getElementById('rail');
  const inner = document.getElementById('railinner');
  const list = document.getElementById('thumbs');
  const outlineList = document.getElementById('outline');
  const tabs = { pages: document.getElementById('tabpages'), outline: document.getElementById('taboutline') };
  const button = document.getElementById('pagesbtn');

  button.innerHTML = icon('sidebar');
  button.title = 'Pages and outline';
  button.setAttribute('aria-label', 'Pages and outline');

  function watch(pdf, viewer, eventBus, container, linkService) {
    const thumbs = window.workspaceThumbs.create(pdf);
    const items = [];
    let open = false;
    let tab = 'pages';
    let outlined = false;
    let current = null;
    let closing = null;

    const size = (item, ratio) => {
      const [width, height] = window.workspaceThumbs.fit(ratio);
      item.sheet.style.width = `${width}px`;
      item.sheet.style.height = `${height}px`;
    };

    const seen = new IntersectionObserver((changes) => {
      for (const { target, isIntersecting } of changes) {
        const n = Number(target.dataset.n);
        const item = items[n - 1];
        if (!isIntersecting) {
          thumbs.drop(n);
          item.sheet.replaceChildren();
          continue;
        }
        thumbs.want(n, ({ bitmap, ratio }) => {
          const canvas = el('canvas');
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          canvas.getContext('2d').drawImage(bitmap, 0, 0);
          size(item, ratio);
          item.sheet.replaceChildren(canvas);
        });
      }
    }, { root: list, rootMargin: '300px 0px' });

    function mark(n, block) {
      if (!items.length) return;
      if (current) {
        current.button.classList.remove('on');
        current.button.tabIndex = -1;
        current.button.removeAttribute('aria-current');
      }
      current = items[n - 1];
      current.button.classList.add('on');
      current.button.tabIndex = 0;
      current.button.setAttribute('aria-current', 'page');
      if (open) current.button.scrollIntoView({ block });
    }

    function build() {
      const grid = el('div', 'thumbs');
      for (let n = 1; n <= viewer.pagesCount; n++) {
        const b = el('button', 'thumb');
        b.type = 'button';
        b.tabIndex = -1;
        b.dataset.n = String(n);
        b.setAttribute('aria-label', `Page ${n}`);
        const item = { button: b, sheet: el('span', 'sheet') };
        const view = viewer.getPageView(n - 1).viewport;
        size(item, view.height / view.width);
        b.append(item.sheet, String(n));
        items.push(item);
        grid.append(b);
        seen.observe(b);
      }
      list.replaceChildren(grid);
      // The focus stays in the document: a click here must not take the keys away from it.
      grid.addEventListener('mousedown', (e) => e.preventDefault());
      grid.addEventListener('click', (e) => {
        const b = e.target.closest('.thumb');
        if (!b) return;
        viewer.currentPageNumber = Number(b.dataset.n);
        container.focus();
      });
    }

    function show(name) {
      tab = name;
      for (const [id, b] of Object.entries(tabs)) b.setAttribute('aria-checked', String(id === name));
      list.hidden = name !== 'pages';
      outlineList.hidden = name !== 'outline';
      if (name === 'pages') {
        if (!items.length) build();
        mark(viewer.currentPageNumber, 'center');
      } else if (!outlined) {
        outlined = true;
        window.workspaceOutline.fill(outlineList, pdf, linkService, container);
      }
    }

    function setOpen(on) {
      open = on;
      clearTimeout(closing);
      if (on) {
        inner.hidden = false;
        show(tab);
      } else {
        closing = setTimeout(() => { inner.hidden = true; }, SLIDE);
      }
      panel.classList.toggle('open', on);
      button.setAttribute('aria-pressed', String(on));
    }

    button.onclick = () => setOpen(!open);
    for (const [name, b] of Object.entries(tabs)) b.onclick = () => show(name);
    button.addEventListener('mousedown', (e) => e.preventDefault());
    eventBus.on('pagesinit', () => { button.disabled = false; });
    eventBus.on('pagechanging', ({ pageNumber }) => mark(pageNumber, 'nearest'));
    window.workspaceViewer.restScrollbar(list);
    window.workspaceViewer.restScrollbar(outlineList);
    api.thumbs = thumbs;
  }

  const api = { watch, thumbs: null };
  window.workspaceSidebar = api;
})();

// SPDX-License-Identifier: AGPL-3.0-or-later
// The left panel: a thumbnail for every page with the page in view outlined, and a click goes to the page. The title row's button slides
// it open and shut; nothing is built or drawn until it is first opened. A classic script that adds window.workspaceSidebar.
(() => {
  const { el, icon } = window.pomeloUi;
  const SLIDE = 350;
  const panel = document.getElementById('rail');
  const list = document.getElementById('thumbs');
  const button = document.getElementById('pagesbtn');

  button.innerHTML = icon('sidebar');
  button.title = 'Pages';
  button.setAttribute('aria-label', 'Pages');

  function watch(pdf, viewer, eventBus, container) {
    const thumbs = window.workspaceThumbs.create(pdf);
    const items = [];
    let open = false;
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

    function setOpen(on) {
      open = on;
      clearTimeout(closing);
      if (on) {
        if (!items.length) build();
        list.hidden = false;
      } else {
        closing = setTimeout(() => { list.hidden = true; }, SLIDE);
      }
      panel.classList.toggle('open', on);
      button.setAttribute('aria-pressed', String(on));
      if (on) mark(viewer.currentPageNumber, 'center');
    }

    button.onclick = () => setOpen(!open);
    button.addEventListener('mousedown', (e) => e.preventDefault());
    eventBus.on('pagesinit', () => { button.disabled = false; });
    eventBus.on('pagechanging', ({ pageNumber }) => mark(pageNumber, 'nearest'));
    window.workspaceViewer.restScrollbar(list);
    api.thumbs = thumbs;
  }

  const api = { watch, thumbs: null };
  window.workspaceSidebar = api;
})();

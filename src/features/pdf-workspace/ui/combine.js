// SPDX-License-Identifier: AGPL-3.0-or-later
// The Combine files card: the open document and the PDFs added to it, in the order they will have in the new file. A classic script that
// adds window.workspaceCombine.
(() => {
  const { el, icon } = window.pomeloUi;
  const MAX_ADDED = 50;
  const BUTTONS = [['up', 'Move up'], ['down', 'Move down'], ['close', 'Remove']];

  // Resolves with the answer of the main process when the card is closed after a try, or null. `name` is the open document's name.
  function open(token, name) {
    const { box, close } = window.pomeloCard.frame(document.querySelector('.well'));
    const badge = el('i', 'badge');
    badge.innerHTML = icon('combine');
    const title = el('h3', '', 'Combine files');
    title.id = 'dialog-title';
    const head = el('div', 'uhead');
    head.append(badge, title);
    const list = el('ul', 'files scrolly');
    const add = el('button', 'addfiles', '+ Add files');
    add.type = 'button';
    const cancel = el('button', 'btn', 'Cancel');
    const go = el('button', 'btn primary', 'Combine');
    const row = el('div', 'row');
    row.append(cancel, go);
    box.dataset.drops = '';
    box.append(head, list, add, row);

    const files = [{ name, current: true }];
    let working = false;

    const move = (i, by) => { [files[i], files[i + by]] = [files[i + by], files[i]]; };

    function draw(focus) {
      list.replaceChildren(...files.map((file, i) => {
        const item = el('li', 'cfile');
        const mark = el('i', 'cicon');
        mark.innerHTML = icon('file');
        const label = el('span', 'cname', file.name);
        label.title = file.name;
        item.append(mark, label);
        for (const [act, words] of BUTTONS) {
          const b = el('button');
          b.type = 'button';
          b.dataset.act = act;
          b.title = words;
          b.setAttribute('aria-label', `${words}: ${file.name}`);
          b.innerHTML = icon(act);
          b.disabled = act === 'up' ? i === 0 : act === 'down' ? i === files.length - 1 : !!file.current;
          b.onclick = () => {
            if (act === 'close') files.splice(i, 1); else move(i, act === 'up' ? -1 : 1);
            draw({ at: act === 'close' ? Math.min(i, files.length - 1) : i + (act === 'up' ? -1 : 1), act });
          };
          item.append(b);
        }
        return item;
      }));
      if (focus) (list.children[focus.at].querySelector(`[data-act="${focus.act}"]:not(:disabled)`) ?? list.children[focus.at].querySelector('button:not(:disabled)') ?? add).focus();
      go.disabled = files.length < 2;
      add.disabled = files.length > MAX_ADDED;
    }

    function rest(on) {
      working = on;
      go.setAttribute('aria-busy', String(on));
      go.replaceChildren(on ? el('span', 'spin') : document.createTextNode('Combine'));
      if (on) { for (const b of box.querySelectorAll('button')) b.disabled = true; return; }
      cancel.disabled = false;
      draw();
    }

    async function take(found) {
      for (const source of found.filter((s) => s.kind === 'pdf').slice(0, MAX_ADDED + 1 - files.length)) {
        if (!source.locked || (await window.workspaceDialogs.askSource(source))) files.push(source);
      }
      draw();
    }

    return new Promise((resolve) => {
      const done = (answer) => {
        stopListening();
        close();
        document.getElementById('scroller').focus();
        resolve(answer);
      };
      add.onclick = async () => {
        await take(await window.workspaceApi.chooseSources('pdfs').catch(() => []));
        add.focus();
      };
      box.addEventListener('dragover', () => add.classList.add('over'));
      box.addEventListener('dragleave', (e) => { if (!box.contains(e.relatedTarget)) add.classList.remove('over'); });
      box.addEventListener('drop', () => add.classList.remove('over'));
      const stopListening = window.workspaceApi.onFilesDropped((found, into) => { if (into === 'combine' && !working) take(found); });
      go.onclick = async () => {
        rest(true);
        const result = await window.workspaceApi.combine(token, files.filter((f) => !f.current).map((f) => f.id), files.findIndex((f) => f.current)).catch(() => null);
        if (result?.stop === 'cancelled') { rest(false); go.focus(); return; }
        done(result);
      };
      cancel.onclick = () => done(null);
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); if (!working) done(null); }
        else if (e.key === 'Tab') window.pomeloCard.loop(e, [...box.querySelectorAll('button')]);
      });
      draw();
      add.focus();
    });
  }

  window.workspaceCombine = { open };
})();

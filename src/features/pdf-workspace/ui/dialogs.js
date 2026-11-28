// SPDX-License-Identifier: AGPL-3.0-or-later
// The workspace's dialogs: a card over a veil in the document area. A classic script that adds window.workspaceDialogs.
(() => {
  const { el, icon } = window.pomeloUi;
  const SWATCHES = { page: ['#ffffff', '#fdf6e3', '#eef3ea', '#e9eef6', '#1e1e20'], text: ['#1c1c1e', '#3b3b3b', '#4b3b25', '#1b3a8a', '#e8e8ea'] };
  let card = null;
  let linkOpen = false;
  let progress = null;
  window.workspaceApi.onInstallNote((p) => progress?.(p));

  const frame = () => window.pomeloCard.frame(document.querySelector('.well'));
  const { loop } = window.pomeloCard;

  function build() {
    const { box, close } = frame();
    const { svg } = window.pomeloWheelShapes;
    const file = svg('svg', { class: 'f', viewBox: '0 0 52 62', 'aria-hidden': 'true' });
    window.pomeloIcons.addDefs(svg, file);
    window.pomeloIcons.draw(svg, svg('g', { class: 'picon' }, file), { ext: 'pdf', group: 'pdf', count: 1 }, 26, 52);
    const lock = el('i', 'lk');
    lock.innerHTML = icon('lock');
    const picture = el('div', 'ico');
    picture.append(file, lock);
    const title = el('h3', '', 'Password protected');
    title.id = 'dialog-title';
    const fname = el('p', 'fname');
    fname.hidden = true;
    const words = el('div', 'uname');
    words.append(title, fname);
    const head = el('div', 'uhead');
    head.append(picture, words);
    const field = el('input', 'fld');
    field.type = 'password';
    field.placeholder = 'Password';
    field.autocomplete = 'off';
    field.setAttribute('aria-label', 'Password');
    const eye = el('button');
    eye.type = 'button';
    const reveal = (shown) => {
      field.type = shown ? 'text' : 'password';
      eye.innerHTML = icon(shown ? 'eye-off' : 'eye');
      eye.setAttribute('aria-label', shown ? 'Hide password' : 'Show password');
      eye.setAttribute('aria-pressed', String(shown));
    };
    reveal(false);
    eye.onclick = () => { reveal(field.type === 'password'); field.focus(); };
    const holder = el('div', 'pw');
    holder.append(field, eye);
    const message = el('p');
    message.setAttribute('role', 'alert');
    const inner = el('div');
    inner.append(message);
    const room = el('div', 'emsg');
    room.append(inner);
    const cancel = el('button', 'btn', 'Cancel');
    const submit = el('button', 'btn primary', 'Open');
    const row = el('div', 'row');
    row.append(cancel, submit);
    box.append(head, holder, room, row);

    const c = { close, field, eye, holder, message, room, cancel, submit, fname, pending: null, abort: null, busy: false };
    field.oninput = () => { submit.disabled = !field.value || c.busy; };
    submit.onclick = () => {
      if (submit.disabled || !c.pending) return;
      const answer = c.pending;
      c.pending = null;
      busy(c, true);
      answer(field.value);
    };
    cancel.onclick = () => {
      const answer = c.pending;
      c.pending = null;
      if (answer) answer(null); else c.abort?.();
    };
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cancel.click(); }
      else if (e.key === 'Enter' && e.target === field) { e.preventDefault(); submit.click(); }
      else if (e.key === 'Tab') loop(e, [field, eye, cancel, submit]);
    });
    return c;
  }

  function busy(c, on) {
    c.busy = on;
    c.field.disabled = on;
    c.eye.disabled = on;
    c.submit.disabled = on || !c.field.value;
    c.submit.setAttribute('aria-busy', String(on));
    c.submit.replaceChildren(on ? el('span', 'spin') : document.createTextNode(c.label));
    if (on) { c.holder.classList.remove('bad'); c.field.removeAttribute('aria-invalid'); c.room.classList.remove('on'); }
  }

  // Resolves with the password typed, or null when the user cancels. The card stays up while it is checked, so a wrong password is
  // answered where it was typed and can be corrected. `abort` is called when the user cancels during the check. `name` is the file the
  // password is for, shown under the title when it is not the document in the window.
  function askPassword(wrong, abort, name) {
    card ??= build();
    const c = card;
    c.abort = abort;
    c.fname.textContent = c.fname.title = name ?? '';
    c.fname.hidden = !name;
    c.label = wrong ? 'Try Again' : 'Open';
    busy(c, false);
    if (wrong) {
      c.message.textContent = 'Wrong Password';
      c.room.classList.add('on');
      c.holder.classList.add('bad', 'shake');
      c.field.setAttribute('aria-invalid', 'true');
      setTimeout(() => c.holder.classList.remove('shake'), 400);
    }
    c.field.focus();
    if (wrong) c.field.select();
    return new Promise((resolve) => { c.pending = resolve; });
  }

  // Asks for the password of a file to add until it is right. Resolves false when the user gives up.
  async function askSource(source) {
    let gaveUp = false;
    let wrong = false;
    for (;;) {
      const password = await askPassword(wrong, () => { gaveUp = true; closePassword(); }, source.name);
      if (password === null) { closePassword(); return false; }
      const right = await window.workspaceApi.unlockSource(source.id, password).catch(() => false);
      if (gaveUp) return false;
      if (right) { closePassword(); return true; }
      wrong = true;
    }
  }

  // The field is emptied before the card goes.
  function closePassword() {
    if (!card) return;
    card.field.value = '';
    card.close();
    card = null;
  }

  // Resolves with true when the user chooses to open the address, false otherwise. The address is shown whole: it is what the link
  // really opens, which the text over it may not say.
  function confirmLink(address) {
    if (linkOpen) return Promise.resolve(false);
    const { box, close } = frame();
    const badge = el('i', 'badge');
    badge.innerHTML = icon('external');
    const title = el('h3', '', 'Open this link?');
    title.id = 'dialog-title';
    const head = el('div', 'uhead');
    head.append(badge, title);
    const shown = el('p', 'addr', address);
    const cancel = el('button', 'btn', 'Cancel');
    const open = el('button', 'btn primary', 'Open');
    const copy = el('button', 'copy');
    copy.type = 'button';
    copy.title = 'Copy link';
    copy.setAttribute('aria-label', 'Copy link');
    copy.innerHTML = icon('copy');
    const tip = el('span', 'tip');
    tip.setAttribute('role', 'status');
    let fading = null;
    copy.onclick = async () => {
      await window.workspaceApi.copyLink(address);
      tip.textContent = 'Copied';
      tip.classList.add('on');
      clearTimeout(fading);
      fading = setTimeout(() => tip.classList.remove('on'), 1400);
    };
    const field = el('div', 'addrbox');
    field.append(shown, copy, tip);
    const row = el('div', 'row');
    row.append(cancel, open);
    box.append(head, field, row);
    linkOpen = true;
    return new Promise((resolve) => {
      const done = (answer) => {
        close();
        linkOpen = false;
        document.getElementById('scroller').focus();
        resolve(answer);
      };
      cancel.onclick = () => done(false);
      open.onclick = () => done(true);
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); done(false); }
        else if (e.key === 'Tab') loop(e, [copy, cancel, open]);
      });
      open.focus();
    });
  }

  // Resolves true once the PDF engine has been installed from the card, false when the user says Not now. While it installs the card
  // cannot be closed; a failed install says why in the card and the button offers Retry.
  function engineCard(heading = 'Editing needs the PDF engine') {
    const { box, close } = frame();
    const badge = el('i', 'badge');
    badge.innerHTML = icon('cpu');
    const title = el('h3', '', heading);
    title.id = 'dialog-title';
    const head = el('div', 'uhead');
    head.append(badge, title);
    const note = el('p', 'note', 'A one-time download. It runs on this PC and works offline.');
    const meter = el('div', 'meter');
    const line = el('i', 'scanline busy');
    meter.hidden = true;
    meter.append(line);
    const message = el('p');
    message.setAttribute('role', 'alert');
    const inner = el('div');
    inner.append(message);
    const room = el('div', 'emsg');
    room.append(inner);
    const later = el('button', 'btn', 'Not now');
    const install = el('button', 'btn primary', 'Install');
    const row = el('div', 'row');
    row.append(later, install);
    box.append(head, note, meter, room, row);
    let working = false;
    return new Promise((resolve) => {
      const done = (answer) => {
        progress = null;
        close();
        document.getElementById('scroller').focus();
        resolve(answer);
      };
      const rest = (on) => {
        working = on;
        later.disabled = on;
        install.disabled = on;
        install.replaceChildren(on ? el('span', 'spin') : document.createTextNode('Retry'));
        meter.hidden = !on;
      };
      install.onclick = async () => {
        room.classList.remove('on');
        rest(true);
        progress = ({ note: text, fraction }) => {
          note.textContent = text;
          line.classList.toggle('busy', typeof fraction !== 'number');
          if (typeof fraction === 'number') line.style.setProperty('--done', `${Math.round(fraction * 100)}%`);
        };
        const result = await window.workspaceApi.installEngine('pdf');
        if (result.ok) { done(true); return; }
        progress = null;
        rest(false);
        note.textContent = 'A one-time download. It runs on this PC and works offline.';
        message.textContent = result.message || 'The PDF engine could not be installed';
        room.classList.add('on');
        install.focus();
      };
      later.onclick = () => done(false);
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); if (!working) done(false); }
        else if (e.key === 'Tab') loop(e, [later, install]);
      });
      install.focus();
    });
  }

  // Asks a question with its answers as buttons, drawn left to right with the last one as the main one. title and detail are text.
  // Resolves with the value of the button chosen, or null on Esc.
  function choose(title, detail, buttons) {
    const { box, close } = frame();
    const heading = el('h3', '', title);
    heading.id = 'dialog-title';
    const head = el('div', 'uhead');
    head.append(heading);
    box.append(head);
    if (detail) box.append(el('p', 'note', detail));
    const row = el('div', 'row');
    const made = buttons.map(({ label, primary }) => el('button', primary ? 'btn primary' : 'btn', label));
    row.append(...made);
    box.append(row);
    return new Promise((resolve) => {
      const done = (answer) => {
        close();
        document.getElementById('scroller').focus();
        resolve(answer);
      };
      made.forEach((button, i) => { button.onclick = () => done(buttons[i].value); });
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); done(null); }
        else if (e.key === 'Tab') loop(e, made);
      });
      made[made.length - 1].focus();
    });
  }

  // Resolves with the id of the format the user picks from `targets` ({ id, ext, group, label }), or null on Cancel or Esc.
  function chooseFormat(targets) {
    const { box, close } = frame();
    const heading = el('h3', '', 'Convert to');
    heading.id = 'dialog-title';
    const head = el('div', 'uhead');
    head.append(heading);
    const grid = el('div', 'formats');
    const { svg } = window.pomeloWheelShapes;
    const defs = svg('svg', { class: 'defs', width: 0, height: 0, 'aria-hidden': 'true' });
    window.pomeloIcons.addDefs(svg, defs);
    const formats = targets.map(({ ext, group, label }) => {
      const b = el('button', 'btn conv');
      const art = svg('svg', { class: 'cicon', viewBox: '0 0 52 62', 'aria-hidden': 'true' });
      window.pomeloIcons.draw(svg, svg('g', { class: 'picon' }, art), { ext, group, count: 1 }, 26, 52);
      b.append(art, el('small', '', label));
      return b;
    });
    grid.append(...formats);
    const cancel = el('button', 'btn', 'Cancel');
    const row = el('div', 'row');
    row.append(cancel);
    box.append(defs, head, grid, row);
    return new Promise((resolve) => {
      const done = (answer) => {
        close();
        document.getElementById('scroller').focus();
        resolve(answer);
      };
      formats.forEach((b, i) => { b.onclick = () => done(targets[i].id); });
      cancel.onclick = () => done(null);
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); done(null); }
        else if (e.key === 'Tab') loop(e, [...formats, cancel]);
      });
      formats[0].focus();
    });
  }

  // Resolves with { page, text } as #rrggbb when the user applies a pair, or null when they cancel. `current` is the pair now in use,
  // if it is one the user chose.
  function chooseColours(current) {
    const { box, close } = frame();
    const badge = el('i', 'badge');
    badge.innerHTML = icon('eye');
    const title = el('h3', '', 'Page colours');
    title.id = 'dialog-title';
    const head = el('div', 'uhead');
    head.append(badge, title);
    const picked = { page: current?.page ?? SWATCHES.page[1], text: current?.text ?? SWATCHES.text[1] };
    const grid = el('div', 'kv');
    for (const [name, label] of [['page', 'Page'], ['text', 'Text']]) {
      const group = el('div', 'swrow');
      group.setAttribute('role', 'radiogroup');
      group.setAttribute('aria-label', `${label} colour`);
      const choose = (colour) => {
        picked[name] = colour;
        for (const b of group.children) {
          b.setAttribute('aria-checked', String(b.dataset.colour === colour));
          b.tabIndex = b.dataset.colour === colour ? 0 : -1;
        }
      };
      for (const colour of SWATCHES[name]) {
        const b = el('button', 'sw');
        b.type = 'button';
        b.dataset.colour = colour;
        b.title = colour;
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-label', colour);
        b.style.background = colour;
        b.onclick = () => choose(colour);
        group.append(b);
      }
      choose(picked[name]);
      if (!group.querySelector('[tabindex="0"]')) group.firstChild.tabIndex = 0;
      group.addEventListener('keydown', (e) => {
        const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
        if (!step) return;
        const all = [...group.children];
        const next = all[(all.indexOf(document.activeElement) + step + all.length) % all.length];
        choose(next.dataset.colour);
        next.focus();
        e.preventDefault();
      });
      grid.append(el('span', '', label), group);
    }
    const cancel = el('button', 'btn', 'Cancel');
    const apply = el('button', 'btn primary', 'Apply');
    const row = el('div', 'row');
    row.append(cancel, apply);
    box.append(head, grid, row);
    return new Promise((resolve) => {
      const done = (answer) => {
        close();
        document.getElementById('scroller').focus();
        resolve(answer);
      };
      cancel.onclick = () => done(null);
      apply.onclick = () => done({ page: picked.page, text: picked.text });
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); done(null); }
        else if (e.key === 'Tab') loop(e, [...box.querySelectorAll('button')].filter((b) => b.tabIndex === 0));
      });
      apply.focus();
    });
  }

  window.workspaceDialogs = { askPassword, askSource, closePassword, confirmLink, engineCard, choose, chooseFormat, chooseColours, isOpen: window.pomeloCard.isOpen };
})();

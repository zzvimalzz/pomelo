// SPDX-License-Identifier: AGPL-3.0-or-later
// The workspace's dialogs: a card over a veil in the document area. A classic script that adds window.workspaceDialogs.
(() => {
  const { el, icon } = window.pomeloUi;
  let card = null;

  function build(name) {
    const box = el('div', 'card');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'dialog-title');
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
    const words = el('div', 'ut');
    words.append(title, el('span', '', name));
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
    const veil = el('div', 'veil');
    veil.append(box);

    const c = { veil, field, eye, holder, message, room, cancel, submit, pending: null, abort: null, busy: false };
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
      else if (e.key === 'Tab') {
        const stops = [field, eye, cancel, submit].filter((s) => !s.disabled);
        const next = stops[(stops.indexOf(document.activeElement) + (e.shiftKey ? -1 : 1) + stops.length) % stops.length];
        e.preventDefault();
        next.focus();
      }
    });
    document.querySelector('.well').append(veil);
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
  // answered where it was typed and can be corrected. `abort` is called when the user cancels during the check.
  function askPassword(name, wrong, abort) {
    card ??= build(name);
    const c = card;
    c.abort = abort;
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

  // The field is emptied before the card goes.
  function closePassword() {
    if (!card) return;
    card.field.value = '';
    card.veil.remove();
    card = null;
  }

  window.workspaceDialogs = { askPassword, closePassword };
})();

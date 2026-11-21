// SPDX-License-Identifier: AGPL-3.0-or-later
// The workspace's dialogs: a card over a veil in the document area. A classic script that adds window.workspaceDialogs.
(() => {
  const { el, icon } = window.pomeloUi;

  // Resolves with the password typed, or null when the user cancels. The field is emptied before the card goes.
  function askPassword(wrong) {
    return new Promise((resolve) => {
      const card = el('div', 'card');
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-modal', 'true');
      card.setAttribute('aria-labelledby', 'dialog-title');
      const badge = el('div', 'badge');
      badge.innerHTML = icon('lock');
      const title = el('h3', '', 'This file is password-protected');
      title.id = 'dialog-title';
      const field = el('input', 'fld');
      field.type = 'password';
      field.placeholder = 'Password';
      field.autocomplete = 'off';
      field.setAttribute('aria-label', 'Password');
      const cancel = el('button', 'btn', 'Cancel');
      const submit = el('button', 'btn primary', 'Open');
      const row = el('div', 'row');
      row.append(cancel, submit);
      card.append(badge, title, field);
      if (wrong) card.append(el('small', 'bad', 'Wrong password'));
      card.append(row);
      const veil = el('div', 'veil');
      veil.append(card);

      const done = (value) => { field.value = ''; veil.remove(); resolve(value); };
      cancel.onclick = () => done(null);
      submit.onclick = () => { if (field.value) done(field.value); else field.focus(); };
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); done(null); }
        else if (e.key === 'Enter' && e.target === field) submit.click();
        else if (e.key === 'Tab') {
          const stops = [field, cancel, submit];
          const next = stops[(stops.indexOf(document.activeElement) + (e.shiftKey ? -1 : 1) + stops.length) % stops.length];
          e.preventDefault();
          next.focus();
        }
      });
      document.querySelector('.well').append(veil);
      field.focus();
    });
  }

  window.workspaceDialogs = { askPassword };
})();

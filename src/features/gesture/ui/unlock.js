// SPDX-License-Identifier: AGPL-3.0-or-later
// The password card. When a dropped file needs a password the wheel folds into this card where it stood: the segments shrink into
// the centre, the file's icon travels into the card and the card scales up. Several protected files get a tray of tiles and a
// "Same for all" switch. The main process checks every password; this page only asks and shows the answer.
window.pomeloCard = (() => {
  const api = window.pomelo;
  const { svg } = window.pomeloWheelShapes;
  const { el } = window.pomeloUi;
  const icon = window.pomeloUi.icon;
  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const host = $('card');
  const SPRING = 'cubic-bezier(0.2, 0.9, 0.25, 1.12)';
  const NO_ENTER_MS = 300;
  const NAME_MAX = 30;
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const shorten = (s) => (s.length <= NAME_MAX ? s : `${s.slice(0, Math.ceil((NAME_MAX - 1) * 0.6))}…${s.slice(s.length - (NAME_MAX - 1 - Math.ceil((NAME_MAX - 1) * 0.6)))}`);
  const LINES = { odt: "OpenDocument passwords aren't supported", ods: "OpenDocument passwords aren't supported", rar: "RAR passwords aren't supported" };

  let S = null;
  let timers = [];
  let openedAt = 0;
  const later = (fn, ms) => { timers.push(setTimeout(fn, ms)); };

  const pending = () => S.files.filter((f) => f.status === 'locked');
  const asking = () => S.files.filter((f) => f.status === 'locked' && f.kind === 'needed');
  const active = () => S.files[S.active];
  const refuses = () => active().kind !== 'needed';
  const line = (f) => f.message || (f.kind === 'engine' ? 'Needs the PDF components, which can be installed in Settings' : LINES[f.ext] || "This protection isn't supported");

  function fileSvg(f) {
    const s = svg('svg', { class: 'f', viewBox: '0 0 52 64', 'aria-hidden': 'true' });
    window.pomeloIcons.draw(svg, svg('g', { class: 'picon' }, s), { ext: f.ext, group: f.group, count: 1 }, 26, 52);
    return s;
  }

  function badge(f, cls) {
    const b = el('i', `lk ${cls || ''}`.trim());
    b.innerHTML = icon(cls === 'ban' ? 'ban' : cls === 'ok' ? 'check' : 'lock');
    return b;
  }

  function tray() {
    const all = S.files.filter((f) => f.status !== 'gone');
    const shown = all.slice(0, all.length > 5 ? 4 : 5);
    const box = el('div', 'tray');
    for (const f of shown) {
      const tile = el('div', f === active() ? 'tile on' : 'tile');
      tile.title = f.name;
      tile.append(fileSvg(f), badge(f, f.status === 'done' ? 'ok' : ''));
      box.append(tile);
    }
    if (all.length > shown.length) box.append(el('div', 'tile more', `+${all.length - shown.length}`));
    return box;
  }

  function button(label, cls, onClick) {
    const b = el('button', `btn ${cls || ''}`.trim());
    b.type = 'button';
    if (typeof label === 'string') b.textContent = label; else b.append(label);
    b.addEventListener('click', onClick);
    return b;
  }

  // The main process lets clicks through everywhere but over the card, so it needs to know where the card is. The box is taken from its
  // layout size and centre, which the entrance animation does not change.
  const watch = new ResizeObserver(() => {
    const card = $('ucard');
    if (!card) return;
    const r = card.getBoundingClientRect();
    api.card({ x: r.left + (r.width - card.offsetWidth) / 2, y: r.top + (r.height - card.offsetHeight) / 2, width: card.offsetWidth, height: card.offsetHeight });
  });

  function render(focus = true) {
    watch.disconnect();
    if (!S) { host.replaceChildren(); return; }
    const f = active();
    const refused = refuses();
    const tiled = !refused && S.files.length > 1;
    const card = el('div', 'ucard');
    card.id = 'ucard';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'ut');
    if (tiled) card.append(tray());
    const head = el('div', 'uhead');
    if (!tiled) {
      const ico = el('div', 'ico');
      ico.id = 'ico';
      ico.append(fileSvg(f), badge(f, refused && f.kind !== 'engine' ? 'ban' : ''));
      head.append(ico);
    }
    const title = el('div', 'ut');
    const heading = el('b', '', refused ? "Can't open this file" : 'Password protected');
    heading.id = 'ut';
    const name = el('span', '', shorten(f.name));
    name.title = f.name;
    title.append(heading, name);
    head.append(title);
    card.append(head);

    const row = el('div', 'urow');
    let field = null;
    if (refused) {
      const msg = el('div', 'emsg on');
      msg.append(el('div'));
      msg.firstChild.append(el('p', 'plain', line(f)));
      card.append(msg);
      row.append(button('OK', 'primary', dismiss));
    } else {
      const wrap = el('div', S.error ? 'fwrap bad' : 'fwrap');
      wrap.id = 'fwrap';
      field = el('input', 'fld');
      field.id = 'pw';
      field.type = S.show ? 'text' : 'password';
      field.placeholder = 'Password';
      field.autocomplete = 'off';
      field.spellcheck = false;
      field.maxLength = 4096;
      field.value = S.value;
      field.disabled = S.busy;
      field.setAttribute('aria-label', 'Password');
      if (S.error) field.setAttribute('aria-invalid', 'true');
      const eye = el('button', 'eye');
      eye.type = 'button';
      eye.id = 'eye';
      eye.disabled = S.busy;
      eye.setAttribute('aria-label', S.show ? 'Hide password' : 'Show password');
      eye.innerHTML = icon(S.show ? 'eye-off' : 'eye');
      eye.addEventListener('click', () => { S.value = field.value; S.show = !S.show; render(); });
      wrap.append(field, eye);
      const msg = el('div', S.error ? 'emsg on' : 'emsg');
      const alert = el('p', '', S.error || '');
      alert.setAttribute('role', 'alert');
      msg.append(el('div'));
      msg.firstChild.append(alert);
      card.append(wrap, msg);
      if (asking().length > 1) {
        const sw = el('button', 'sw');
        sw.type = 'button';
        sw.setAttribute('role', 'switch');
        sw.setAttribute('aria-checked', String(S.all));
        sw.append(el('span', 'track'), 'Same for all');
        sw.addEventListener('click', () => { S.all = !S.all; sw.setAttribute('aria-checked', String(S.all)); });
        row.append(sw);
      }
      const go = button(S.busy ? el('span', 'spin2') : S.errorKind === 'wrong' ? 'Try Again' : 'Convert', 'primary', submit);
      go.id = 'go';
      go.disabled = S.busy || !S.value;
      field.addEventListener('input', () => { S.value = field.value; go.disabled = !field.value; });
      row.append(button('Cancel', '', cancel), go);
    }
    card.append(row);
    host.replaceChildren(card);
    watch.observe(card);
    if (field && focus && !S.busy) {
      field.focus({ preventScroll: true });
      if (S.error) field.select(); else field.setSelectionRange(field.value.length, field.value.length);
    }
    if (field && S.errorKind === 'wrong' && S.shake) {
      S.shake = false;
      const wrap = $('fwrap');
      if (!reduced()) { wrap.classList.add('shake'); later(() => wrap.classList.remove('shake'), 400); }
    }
  }

  // The wheel folds into the card: segments and plate shrink toward the centre, the file icon from the wheel's centre travels to the
  // card's icon slot, the card scales up. With reduced motion the wheel cross-fades into the card.
  function morph() {
    const card = $('ucard');
    const slot = document.querySelector('.tile.on') || $('ico');
    const centre = document.querySelector('#center .doc');
    if (reduced()) {
      card.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, fill: 'backwards' });
      $('wheel').animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' });
      later(() => stage.classList.add('asking'), 170);
      return;
    }
    const from = centre.getBoundingClientRect();
    const to = slot.getBoundingClientRect();
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    document.querySelectorAll('#segments .spin').forEach((s, i) => s.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.6)' }], { duration: 260, delay: i * 12, easing: 'cubic-bezier(0.4, 0, 0.7, 0.2)', fill: 'forwards' }));
    $('plate').animate([{ r: 170, opacity: 1 }, { r: 120, opacity: 0 }], { duration: 300, easing: 'cubic-bezier(0.4, 0, 0.6, 1)', fill: 'forwards' });
    document.querySelector('#center .disc').animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' });
    document.querySelector('#center .name').animate([{ opacity: 1 }, { opacity: 0 }], { duration: 100, fill: 'forwards' });
    centre.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 1, delay: 40, fill: 'forwards' });
    card.animate([{ opacity: 0, transform: 'scale(0.6)' }, { opacity: 1, transform: 'none' }], { duration: 380, delay: 70, easing: SPRING, fill: 'backwards' });
    slot.animate([{ transform: `translate(${dx}px, ${dy}px) scale(1.04)` }, { transform: 'none' }], { duration: 420, delay: 40, easing: SPRING, fill: 'backwards' });
    card.querySelectorAll('.ut, .fwrap, .urow, .tray').forEach((n, i) => n.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 260, delay: 170 + i * 40, easing: 'ease-out', fill: 'backwards' }));
    later(() => stage.classList.add('asking'), 500);
  }

  function show(files) {
    reset();
    const order = [...files].sort((a, b) => (a.kind !== 'needed') - (b.kind !== 'needed'));
    S = { files: order.map((f) => ({ ...f, status: 'locked' })), active: 0, value: '', show: false, all: true, busy: false, error: '', errorKind: '', shake: false };
    openedAt = Date.now();
    render(false);
    morph();
    const pw = $('pw');
    if (pw) pw.focus({ preventScroll: true });
  }

  function reset() {
    timers.forEach(clearTimeout);
    timers = [];
    S = null;
    host.replaceChildren();
    stage.classList.remove('asking');
  }

  function close() {
    const card = $('ucard');
    if (card) card.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: 'forwards' });
    timers.forEach(clearTimeout);
    timers = [];
    S = null;
  }

  const cancel = () => api.cancel();

  function next() {
    const left = pending();
    if (!left.length) { cancel(); return; }
    S.files.forEach((f) => { if (f.status === 'done') f.status = 'gone'; });
    S.active = S.files.indexOf(left[0]);
    render();
  }

  function dismiss() {
    active().status = 'gone';
    next();
  }

  async function submit() {
    if (S.busy || !S.value) return;
    const f = active();
    S.busy = true;
    S.error = '';
    S.errorKind = '';
    render(false);
    let r;
    try { r = await api.unlock({ token: f.token, password: S.value, all: S.all && asking().length > 1 }); } catch { r = { state: 'cannot', token: f.token, message: "Pomelo couldn't check this password" }; }
    if (!S) return;
    S.busy = false;
    if (r.state === 'closed') { cancel(); return; }
    if (r.state === 'wrong') {
      S.error = r.message || 'Wrong Password';
      S.errorKind = 'wrong';
      S.shake = true;
      render();
    } else if (r.state === 'cannot') {
      const bad = S.files.find((x) => x.token === r.token) || f;
      bad.kind = 'refused';
      bad.message = r.message;
      S.value = '';
      render();
    } else {
      for (const file of S.files) if (r.done.includes(file.token)) file.status = 'done';
      S.value = '';
      S.error = r.mismatch ? 'Different password needed' : '';
      S.errorKind = r.mismatch ? 'diff' : '';
      render(false);
      document.querySelectorAll('.tile .lk.ok').forEach((n) => n.parentElement.classList.add('pulse'));
      const lock = document.querySelector('.ico .lk');
      if (lock) { lock.classList.add('ok'); lock.innerHTML = icon('check'); }
      later(next, pending().length ? 560 : 520);
    }
  }

  window.addEventListener('keydown', (e) => {
    if (!S) return;
    if (e.key === 'Escape') { e.preventDefault(); cancel(); return; }
    if (e.key === 'Enter' && e.target === $('pw')) {
      e.preventDefault();
      if (Date.now() - openedAt >= NO_ENTER_MS && $('go') && !$('go').disabled) submit();
    } else if (e.key === 'Tab') {
      const stops = [...$('ucard').querySelectorAll('input, button, [role="switch"]')].filter((x) => !x.disabled);
      if (!stops.length) return;
      e.preventDefault();
      stops[(stops.indexOf(document.activeElement) + (e.shiftKey ? -1 : 1) + stops.length) % stops.length].focus();
    }
  });

  return { show, reset, close, isOpen: () => !!S };
})();

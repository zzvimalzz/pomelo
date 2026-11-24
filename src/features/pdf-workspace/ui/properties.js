// SPDX-License-Identifier: AGPL-3.0-or-later
// The Document panel on the right: the file's name, folder, size and date, the document information a person can edit, and what the PDF
// engine reports about the pages, the security, the signatures and the fonts. Everything that comes from a file goes in as text. A
// classic script that adds window.workspaceProperties.
(() => {
  const { el, icon } = window.pomeloUi;
  const SLIDE = 350;
  const FIELDS = [['title', 'Title'], ['author', 'Author'], ['subject', 'Subject'], ['keywords', 'Keywords']];
  const NOT_ALLOWED = {
    print: 'printing', printHighQuality: 'high quality printing', modify: 'changing the document', copy: 'copying text',
    annotate: 'comments', fillForms: 'filling in forms', accessibility: 'reading aloud', assemble: 'changing pages',
  };
  const CERTIFIED = { 1: 'no changes allowed', 2: 'form filling and signing allowed', 3: 'form filling, signing and comments allowed' };
  const RENAME_STOPS = {
    invalid: "That name can't be used", exists: 'A file with that name is already there', open: 'That file is open in another tab',
    'in-use': 'Windows would not rename the file', changed: 'The file is no longer there',
  };
  const PAPERS = [['A3', 297, 420], ['A4', 210, 297], ['A5', 148, 210], ['Letter', 216, 279], ['Legal', 216, 356]];
  const MAX_SHOWN = 10;
  const panel = document.getElementById('docpanel');
  const inner = document.getElementById('docinner');
  const body = document.getElementById('docbody');
  const closer = document.getElementById('docclose');
  const button = document.getElementById('docbtn');
  const loading = document.getElementById('docloading');
  const api = window.workspaceApi;
  let tab = null;
  let open = false;
  let turn = 0;
  let closing = null;
  let justRenamed = false;

  button.innerHTML = icon('info');
  button.title = `Document info (${window.workspaceKeys.label('documentPanel')})`;
  button.setAttribute('aria-label', 'Document info');
  closer.innerHTML = icon('close');
  closer.title = 'Hide panel';
  closer.setAttribute('aria-label', 'Hide panel');

  const size = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(n > 10485760 ? 0 : 1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);
  const day = (when) => { const d = new Date(when); return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(undefined, { dateStyle: 'medium' }); };
  const moment = (when) => { const d = new Date(when); return Number.isNaN(d.getTime()) ? null : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); };

  function pageSize(pages) {
    const mm = (p) => [p.width, p.height].map((v) => Math.round((v * 25.4) / 72));
    const [w, h] = mm(pages[0]);
    if (pages.some((p) => Math.abs(p.width - pages[0].width) > 1 || Math.abs(p.height - pages[0].height) > 1)) return 'Varies';
    const paper = PAPERS.find(([, a, b]) => Math.abs(a - Math.min(w, h)) <= 1 && Math.abs(b - Math.max(w, h)) <= 1);
    return `${paper ? `${paper[0]} · ` : ''}${w} × ${h} mm`;
  }

  const row = (label, value) => [el('span', '', label), value instanceof Node ? value : el('span', '', value)];
  const facts = (rows) => { const grid = el('div', 'facts'); for (const [label, value] of rows) grid.append(...row(label, value)); return grid; };
  const card = (title, ...parts) => { const s = el('section'); s.append(el('h4', '', title), ...parts); return s; };
  const lines = (texts) => { const box = el('div', 'stack'); for (const text of texts) box.append(el('div', '', text)); return box; };

  function fileCard(doc, details) {
    const ext = /\.[^.]*$/.exec(doc.name)?.[0] ?? '';
    const base = doc.name.slice(0, doc.name.length - ext.length);
    const input = el('input');
    input.value = base;
    input.spellcheck = false;
    input.maxLength = 200;
    input.setAttribute('aria-label', 'File name');
    const go = el('button', '', 'Rename');
    go.type = 'button';
    go.hidden = true;
    const field = el('div', 'namefld');
    field.append(input, el('span', '', ext), go);
    const typedName = () => input.value.replace(/\.pdf$/i, '').trim();
    const hint = el('p', 'hintline');
    hint.setAttribute('role', 'status');
    const say = (text, bad) => {
      hint.textContent = text;
      hint.classList.toggle('bad', !!bad);
      hint.classList.toggle('ok', !bad);
      clearTimeout(say.timer);
      if (!bad) say.timer = setTimeout(() => say(''), 1600);
    };
    async function rename() {
      const typed = typedName();
      if (typed === base) { input.blur(); return; }
      justRenamed = true;
      const result = await api.rename(doc.token, typed);
      if (result?.info) { input.blur(); return; }
      justRenamed = false;
      say(RENAME_STOPS[result?.stop] ?? "Couldn't rename the file", true);
    }
    input.addEventListener('input', () => { say(''); go.hidden = typedName() === base; });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { input.value = base; go.hidden = true; say(''); input.blur(); e.preventDefault(); return; }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      rename();
    });
    go.onclick = rename;
    if (justRenamed) { justRenamed = false; say('Renamed'); }
    const show = el('button', 'pillbtn', 'Show');
    show.type = 'button';
    show.onclick = () => api.showInFolder(doc.token);
    const folders = details?.folders ?? [];
    const folder = el('span', 'folder', folders.join(' › '));
    folder.title = folder.textContent;
    const where = el('span', 'where');
    where.append(folder, show);
    const modified = details?.modified ? moment(details.modified) : null;
    const section = card('File', field, hint, facts([['Location', where], ['Size', size(doc.size)], ['Modified', modified ?? 'Unknown']]));
    section.input = input;
    // A place too long for its three lines would lose the folder that holds the file, so the outer folder then gets one line and the
    // inner one the other two. Measured once the card is in the panel.
    section.fitPlace = () => {
      if (folders.length < 2 || folder.scrollHeight <= folder.clientHeight + 1) return;
      folder.classList.add('split');
      folder.replaceChildren(el('span', '', `${folders[0]} › `), el('span', '', folders[1]));
    };
    return section;
  }

  function descriptionCard(doc, values, editable) {
    const inputs = {};
    const read = () => Object.fromEntries(FIELDS.map(([key]) => [key, inputs[key].value]));
    const rows = FIELDS.map(([key, label]) => {
      const value = values[key] ?? '';
      if (!editable) return [label, value || el('span', 'unset', 'Not set')];
      const input = el('input', 'fld');
      input.value = value;
      input.maxLength = 1000;
      input.spellcheck = false;
      input.setAttribute('aria-label', label);
      inputs[key] = input;
      return [label, input];
    });
    if (editable) {
      let saved = read();
      for (const [key, input] of Object.entries(inputs)) {
        input.addEventListener('keydown', (e) => {
          if (e.key !== 'Escape') return;
          input.value = saved[key];
          input.blur();
          e.preventDefault();
        });
        input.addEventListener('change', async () => {
          const now = read();
          const result = await api.apply(doc.token, [{ op: 'meta.set', ...now }]).catch(() => null);
          if (result?.info) { saved = now; return; }
          for (const [name] of FIELDS) if (inputs[name].value === now[name]) inputs[name].value = saved[name];
        });
      }
    }
    return card('Description', facts(rows));
  }

  function signatureBlock({ fields, changedAfterSigning, certification }) {
    if (!fields.length) return el('span', '', 'None');
    const texts = fields.slice(0, MAX_SHOWN).map((f) => {
      if (!f.signed) return `Not signed yet: ${f.name}`;
      const when = f.time && moment(f.time);
      return `${f.signer || f.name}${when ? ` · ${when}` : ''}${f.intact ? '' : ' · The signed part was rewritten'}`;
    });
    if (fields.length > MAX_SHOWN) texts.push(`and ${fields.length - MAX_SHOWN} more`);
    if (certification) texts.push(`Certified: ${CERTIFIED[certification] ?? 'some changes allowed'}`);
    const locks = new Set();
    for (const { lock } of fields) {
      if (!lock) continue;
      const names = lock.fields.join(', ');
      locks.add(lock.action === 'All' ? 'Locks all fields' : lock.action === 'Exclude' ? `Locks all fields except ${names}` : `Locks ${names}`);
    }
    texts.push(...locks);
    if (fields.some((f) => f.signed)) texts.push(changedAfterSigning ? 'Changed after signing' : 'Nothing added after signing');
    const box = lines(texts);
    box.append(el('small', '', 'Pomelo does not check signatures'));
    return box;
  }

  function permissionsText(permissions) {
    const refused = Object.keys(NOT_ALLOWED).filter((key) => permissions[key] === false).map((key) => NOT_ALLOWED[key]);
    return refused.length ? `Not allowed: ${refused.join(', ')}` : 'Everything allowed';
  }

  function fontsCard(fonts) {
    const missing = fonts.filter((f) => !f.embedded).length;
    const summary = !fonts.length ? 'No fonts' : `${fonts.length} ${fonts.length === 1 ? 'font' : 'fonts'}, ${missing ? `${missing} not embedded` : fonts.length === 1 ? 'embedded' : 'all embedded'}`;
    const list = el('ul', 'fonts');
    for (const f of fonts) list.append(el('li', f.embedded ? '' : 'no', f.name || 'Unnamed'));
    const details = el('details');
    details.append(el('summary', '', summary), list);
    return card('Fonts', details);
  }

  function factCards(f) {
    const made = f.information.creator || f.information.producer;
    const created = f.information.created && day(f.information.created);
    return [
      card('Document', facts([
        ['Pages', String(f.pageCount)], ['Page size', pageSize(f.pages)], ['PDF version', (f.version ?? '').replace(/^PDF /, '') || 'Unknown'],
        ['Created', [created, made].filter(Boolean).join(' · ') || 'Unknown'],
      ])),
      card('Security', facts([
        ['Password', !f.encryption ? 'None' : f.needsPassword ? 'Needed to open' : 'Only to change permissions'],
        ['Permissions', permissionsText(f.permissions)],
        ['Signatures', signatureBlock(f.signatures)],
      ])),
      fontsCard(f.fonts),
    ];
  }

  // The engine's facts and the document's own information, asked for again only when the pages or the revision changed.
  function load(t) {
    if (t.loaded?.pdf !== t.pdf || t.loaded.size !== t.doc.size) {
      const promise = Promise.all([api.properties(t.doc.token), t.pdf.getMetadata()]).catch(() => null);
      t.loaded = { pdf: t.pdf, size: t.doc.size, promise };
    }
    return t.loaded.promise;
  }

  async function render(rename) {
    if (!open || !tab) return;
    const mine = ++turn;
    const { doc, pdf } = tab;
    const slow = setTimeout(() => { if (mine === turn) loading.hidden = false; }, 300);
    const [loaded, details] = await Promise.all([load(tab), api.details(doc.token).catch(() => null)]);
    clearTimeout(slow);
    if (mine !== turn) return;
    loading.hidden = true;
    const file = fileCard(doc, details);
    const cards = [file];
    if (loaded) {
      const [props, { info }] = loaded;
      const values = props.facts ? props.facts.information : Object.fromEntries(FIELDS.map(([key]) => [key, info[key[0].toUpperCase() + key.slice(1)]]));
      const editable = !!props.facts;
      const kept = body.children[1];
      const same = kept?.token === doc.token && kept.pdf === pdf && kept.editable === editable;
      const description = same ? kept : Object.assign(descriptionCard(doc, values, editable), { token: doc.token, pdf, editable });
      cards.push(description, ...(editable ? factCards(props.facts) : []));
    }
    // Moving a node blurs it, so a Description card that is kept stays where it is and only the cards round it change: a change made
    // in one field must not take the focus or the half typed text from the next.
    if (cards[1] && cards[1] === body.children[1]) {
      body.children[0].replaceWith(file);
      while (cards[1].nextSibling) cards[1].nextSibling.remove();
      cards[1].after(...cards.slice(2));
    } else body.replaceChildren(...cards);
    file.fitPlace();
    if (rename) { file.input.focus(); file.input.select(); }
  }

  function setOpen(on, rename) {
    if (on && !tab) return;
    clearTimeout(closing);
    if (on === open) { if (on) render(rename); return; }
    open = on;
    if (on) {
      for (const name of ['search', 'links']) window.workspaceSide.shutTab(name);
      inner.hidden = false;
      render(rename);
    } else {
      turn++;
      loading.hidden = true;
      closing = setTimeout(() => { inner.hidden = true; body.replaceChildren(); }, SLIDE);
    }
    panel.classList.toggle('open', on);
    button.setAttribute('aria-pressed', String(on));
  }

  // next: { doc, pdf } of the tab on show, or null while there is nothing to describe. An open panel stays open and empties.
  function show(next) {
    tab = next;
    button.disabled = !next;
    if (next && open) render();
    else if (next) load(next);
    else { turn++; loading.hidden = true; body.replaceChildren(); }
  }

  button.onclick = () => setOpen(!open);
  closer.onclick = () => setOpen(false);
  for (const b of [button, closer]) b.addEventListener('mousedown', (e) => e.preventDefault());
  window.workspaceKeys.bind('documentPanel', () => { if (!tab) return false; setOpen(!open); });
  window.workspaceKeys.bind('escape', () => {
    if (!open || !panel.contains(document.activeElement)) return false;
    setOpen(false);
    document.getElementById('scroller').focus();
    return true;
  });
  window.workspaceSide.onchange((sideOpen) => { if (sideOpen) setOpen(false); });
  window.workspaceViewer.restScrollbar(body);

  window.workspaceProperties = { show, open: () => setOpen(true, true) };
})();

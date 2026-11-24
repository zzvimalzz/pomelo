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
    const field = el('div', 'namefld');
    field.append(input, el('span', '', ext));
    const hint = el('p', 'hintline');
    hint.setAttribute('role', 'status');
    const say = (text, bad) => {
      hint.textContent = text;
      hint.classList.toggle('bad', !!bad);
      hint.classList.toggle('ok', !bad);
      clearTimeout(say.timer);
      if (!bad) say.timer = setTimeout(() => say(''), 1600);
    };
    input.addEventListener('input', () => say(''));
    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Escape') { input.value = base; say(''); input.blur(); e.preventDefault(); return; }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const typed = input.value.replace(/\.pdf$/i, '').trim();
      if (typed === base) { input.blur(); return; }
      justRenamed = true;
      const result = await api.rename(doc.token, typed);
      if (result?.info) { input.blur(); return; }
      justRenamed = false;
      say(RENAME_STOPS[result?.stop] ?? "Couldn't rename the file", true);
    });
    if (justRenamed) { justRenamed = false; say('Renamed'); }
    const show = el('button', 'pillbtn', 'Show');
    show.type = 'button';
    show.onclick = () => api.showInFolder(doc.token);
    const where = el('span', 'where');
    where.append(el('span', 'folder', details?.folder ?? ''), show);
    const modified = details?.modified ? moment(details.modified) : null;
    const section = card('File', field, hint, facts([['Location', where], ['Size', size(doc.size)], ['Modified', modified ?? 'Unknown']]));
    section.input = input;
    return section;
  }

  function descriptionCard(doc, info, editable) {
    const inputs = {};
    const read = () => Object.fromEntries(FIELDS.map(([key]) => [key, inputs[key].value]));
    const rows = FIELDS.map(([key, label]) => {
      const value = info[key[0].toUpperCase() + key.slice(1)] ?? '';
      if (!editable) return [label, value || 'Not set'];
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
      for (const input of Object.values(inputs)) {
        input.addEventListener('change', async () => {
          const now = read();
          const result = await api.apply(doc.token, [{ op: 'meta.set', ...now }]);
          if (result?.info) { saved = now; return; }
          for (const [key] of FIELDS) inputs[key].value = saved[key];
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

  async function render(rename) {
    if (!open || !tab) return;
    const mine = ++turn;
    const { doc, pdf } = tab;
    const loaded = Promise.all([api.properties(doc.token), pdf.getMetadata()]);
    loaded.catch(() => {});
    const details = await api.details(doc.token).catch(() => null);
    if (mine !== turn) return;
    const file = fileCard(doc, details);
    body.replaceChildren(file);
    if (rename) { file.input.focus(); file.input.select(); }
    let result;
    try { result = await loaded; } catch { return; }
    if (mine !== turn) return;
    const [props, { info }] = result;
    body.append(descriptionCard(doc, info, !!props.facts), ...(props.facts ? factCards(props.facts) : []));
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
    else if (!next) { turn++; body.replaceChildren(); }
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

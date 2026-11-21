// SPDX-License-Identifier: AGPL-3.0-or-later
// Opens the real workspace window on PDFs drawn here: the window's size, place and look in both themes (glass and the opaque
// window of Windows 10), the options pdf.js is given, how many bytes a 40 MB, 3 000-page file costs to show its first page, while
// idle and after scrolling 50 pages, the comments a file holds as markers beside the page, the scroll bars, a password-protected
// file, a file that is not a PDF, a file that is not there, and that the page is cut off from the network. Saves screenshots.
//   npx electron test/ui/workspace-shot.js
const { app, BrowserWindow, ipcMain, nativeTheme, screen } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument, PDFName, PDFRawStream, PDFString, PDFHexString, StandardFonts, rgb } = require('pdf-lib');
const { createWorkspace } = require('../../src/features/pdf-workspace');
const { expect: check, failed } = require('../support/expect');
const { encryptedPdf } = require('../support/encrypted-pdf');
const finish = require('../support/finish');
const { dir: tmpDir } = require('../support/tmp');

app.on('window-all-closed', () => {});
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const asset = (n) => path.join(__dirname, '..', '..', 'assets', n);
const out = path.join(__dirname, '..', 'shots');
const root = tmpDir('workspace');
const glassHere = Number(os.release().split('.')[2]) >= 22621;

let settings = { pdfView: { window: null } };
const notices = [];
const errors = [];
const calls = [];
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, fn) => handle(channel, (event, ...args) => { calls.push({ channel, args }); return fn(event, ...args); });
const setSettings = (patch) => { settings = { ...settings, ...patch }; };

// One workspace per scenario: the IPC handlers belong to one at a time.
const fresh = (options = {}) => {
  for (const channel of ['pdfws:state', 'pdfws:read', 'pdfws:unlock']) ipcMain.removeHandler(channel);
  const workspace = createWorkspace({ asset, getSettings: () => settings, setSettings, notify: (m) => notices.push(m), log: () => {}, ...options });
  workspace.registerIpc();
  return workspace;
};
const js = (win, code) => win.webContents.executeJavaScript(code);
const shot = async (win, name) => fs.writeFileSync(path.join(out, name), (await win.webContents.capturePage()).toPNG());
const until = async (what, fn, ms = 20000) => {
  for (let waited = 0; waited < ms; waited += 100) { if (await fn()) return true; await sleep(100); }
  console.log(`  (gave up waiting for ${what})`);
  return false;
};

async function makePdf(name, pages, { extraBytes = 0 } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= pages; n++) {
    const page = doc.addPage([595, 842]);
    page.drawRectangle({ x: 50, y: 700, width: 495, height: 60, color: rgb(0.9, 0.3, 0.44) });
    page.drawText(`Pomelo test page ${n} of ${pages}`, { x: 60, y: 720, size: 22, font, color: rgb(0, 0, 0) });
  }
  if (extraBytes) doc.context.register(PDFRawStream.of(doc.context.obj({}), crypto.randomBytes(extraBytes)));
  const file = path.join(root, name);
  fs.writeFileSync(file, await doc.save({ useObjectStreams: false }));
  return file;
}

// Opens `file` in a new window and waits until the first page is drawn (or the failure is shown).
async function openAndWait(workspace, file) {
  await workspace.open([file]);
  const win = workspace.getWindow();
  win?.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
  if (win) await until('the first page', () => js(win, `!!document.querySelector('.page[data-loaded="true"] canvas') || !document.getElementById('failure').hidden`));
  return win;
}

// Two pages. On the first: a note, a highlight with no opacity and a highlight with a comment, all three with text, and a highlight
// with none. Heights are PDF points from the bottom of an 842 pt page.
async function makeCommentsPdf(name) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const first = doc.addPage([595, 842]);
  doc.addPage([595, 842]);
  for (const [y, text] of [[705, 'Quarterly figures'], [505, 'Check this figure'], [405, 'No comment here']]) first.drawText(text, { x: 100, y, size: 14, font });
  const annotation = (fields) => doc.context.register(doc.context.obj({ Type: 'Annot', F: 4, ...fields }));
  const highlight = (rect, extra) => annotation({ Subtype: 'Highlight', Rect: rect, QuadPoints: [rect[0], rect[3], rect[2], rect[3], rect[0], rect[1], rect[2], rect[1]], C: [1, 1, 0], ...extra });
  first.node.set(PDFName.of('Annots'), doc.context.obj([
    annotation({ Subtype: 'Text', Name: 'Comment', Rect: [60, 700, 82, 722], Contents: PDFHexString.fromText('A note from Sam'), T: PDFHexString.fromText('Sam'), M: PDFString.of('D:20260105103000Z') }),
    highlight([100, 704, 260, 722], { CA: 0, Contents: PDFHexString.fromText('Said before the meeting') }),
    highlight([100, 500, 260, 520], { CA: 0.4, Contents: PDFHexString.fromText('Check this figure\nwith the team') }),
    highlight([100, 400, 260, 420], { CA: 0.4 }),
  ]));
  const file = path.join(root, name);
  fs.writeFileSync(file, await doc.save({ useObjectStreams: false }));
  return file;
}

const inkOnFirstPage = (win) => js(win, `(() => { const c = document.querySelector('.page canvas'); if (!c) return -1; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let dark = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 100 && d[i + 1] < 100 && d[i + 2] < 100) dark++; return dark; })()`);
const closeAndWait = async (win) => { win.close(); await sleep(500); };

app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  const small = await makePdf('Small.pdf', 3);
  const workArea = screen.getPrimaryDisplay().workArea;
  const size = { width: Math.min(1200, workArea.width), height: Math.min(800, workArea.height) };
  const atDefault = (b) => b.width === size.width && b.height === size.height && Math.abs(b.x - (workArea.x + (workArea.width - size.width) / 2)) <= 1 && Math.abs(b.y - (workArea.y + (workArea.height - size.height) / 2)) <= 1;

  console.log('the window opens on a PDF: size, place, title and page');
  for (const theme of ['light', 'dark']) {
    nativeTheme.themeSource = theme;
    settings = { pdfView: { window: null } };
    const workspace = fresh();
    const win = await openAndWait(workspace, small);
    const b = win.getBounds();
    check(`${theme}: it opens at 1200 x 800 in the middle of the main screen, or fills a screen that is smaller`, atDefault(b), JSON.stringify([b, workArea]));
    check(`${theme}: it is resizable down to 900 x 600 and shows the file's name`, win.isResizable() && win.getMinimumSize().join('x') === '900x600' && win.getTitle() === 'Small.pdf - Pomelo' && win.isVisible(), `${win.getMinimumSize()} ${win.getTitle()}`);
    const ui = await js(win, `({ name: document.getElementById('docname').textContent, failure: document.getElementById('failure').hidden, pages: document.querySelectorAll('.page').length,
      text: document.querySelector('.textLayer')?.textContent || '', solid: document.documentElement.classList.contains('solid'), glass: getComputedStyle(document.querySelector('.window')).backgroundColor,
      fit: (() => { const p = document.querySelector('.page').getBoundingClientRect(); const s = document.getElementById('scroller').getBoundingClientRect(); return p.top >= s.top - 1 && p.bottom <= s.bottom + 1; })() })`);
    check(`${theme}: the title row names the file, there is no failure, and the document has its three pages`, ui.name === 'Small.pdf' && ui.failure && ui.pages === 3, JSON.stringify(ui));
    check(`${theme}: the first page is drawn with ink on it, its text is selectable, and it fits the window`, (await inkOnFirstPage(win)) > 100 && /Pomelo test page 1 of 3/.test(ui.text) && ui.fit, `${await inkOnFirstPage(win)} ${ui.text} fit ${ui.fit}`);
    if (glassHere) check(`${theme}: on Windows 11 the window is glass, tinted with the wheel's plate colour`, !ui.solid && ui.glass === (theme === 'light' ? 'rgba(255, 255, 255, 0.55)' : 'rgba(28, 28, 30, 0.5)'), `${ui.solid} ${ui.glass}`);
    else console.log('  skip the glass window: this PC has no acrylic');
    await shot(win, `workspace-${theme}.png`);
    await closeAndWait(win);
  }

  console.log('the opaque window that Windows 10 gets');
  for (const theme of ['light', 'dark']) {
    nativeTheme.themeSource = theme;
    settings = { pdfView: { window: null } };
    const win = await openAndWait(fresh({ solid: true }), small);
    const ui = await js(win, `({ solid: document.documentElement.classList.contains('solid'), background: getComputedStyle(document.querySelector('.window')).backgroundColor })`);
    check(`${theme}: the solid switch gives an opaque window in the colour of Settings' title bar`, ui.solid && ui.background === (theme === 'light' ? 'rgb(239, 236, 232)' : 'rgb(36, 36, 39)') && win.getBackgroundColor().toLowerCase() === (theme === 'light' ? '#efece8' : '#242427'), `${ui.background} ${win.getBackgroundColor()}`);
    check(`${theme}: and still shows the page`, (await inkOnFirstPage(win)) > 100);
    await shot(win, `workspace-solid-${theme}.png`);
    await closeAndWait(win);
  }
  nativeTheme.themeSource = 'light';

  console.log('what pdf.js is given');
  {
    const win = await openAndWait(fresh(), small);
    const o = await js(win, `(() => { const o = workspaceViewer.loadOptions('the transport'); const { range, ...rest } = o; return { range, rest }; })()`);
    const want = { rangeChunkSize: 65536, disableAutoFetch: true, disableStream: true, disableRange: false, enableScripting: false, isEvalSupported: false, useWorkerFetch: true, cMapPacked: true };
    check('bytes come through the transport, in 64 KiB chunks, with no automatic fetch, no stream and no scripting', o.range === 'the transport' && Object.entries(want).every(([k, v]) => o.rest[k] === v), JSON.stringify(o.rest));
    const urls = ['cMapUrl', 'standardFontDataUrl', 'wasmUrl', 'iccUrl'].map((k) => o.rest[k]);
    const folder = (f) => `/node_modules/pdfjs-dist/${f}/`;
    check('every asset is a local folder of pdfjs-dist, loaded by file URL', urls.every((u, i) => u.startsWith('file:///') && u.endsWith(folder(['cmaps', 'standard_fonts', 'wasm', 'iccs'][i]))) && urls.every((u) => fs.existsSync(new URL(u))), urls.join(' '));
    check('the console of every window so far has no error, so the page broke none of its content security rules', errors.length === 0, errors.join(' | '));

    console.log('cut off from the network, and from paths');
    const refusal = await win.webContents.session.fetch('https://pomelo-offline-check.invalid/').then(() => 'answered', (e) => e.message);
    check('the window session cancels a request to the web', /ERR_BLOCKED_BY_CLIENT/.test(refusal), refusal);
    check('the page cannot fetch the web either', (await js(win, `fetch('https://pomelo-offline-check.invalid/').then(() => 'answered', () => 'refused')`)) === 'refused');
    const state = await js(win, `workspaceApi.state().then((s) => JSON.stringify(s))`);
    check('the page is given a token, a name and a size, and no path', Object.keys(JSON.parse(state).documents[0]).sort().join() === 'name,size,token' && !state.includes(root.replace(/\\/g, '\\\\')) && !/[A-Za-z]:\\\\/.test(state), state);
    check('the page cannot read with a token it was not given', (await js(win, `workspaceApi.read('0'.repeat(64), 0, 10).then(() => 'read', () => 'refused')`)) === 'refused');
    check('the page cannot read more than 4 MiB in one call', (await js(win, `workspaceApi.state().then((s) => workspaceApi.read(s.documents[0].token, 0, 4 * 1048576 + 1)).then(() => 'read', () => 'refused')`)) === 'refused');
    await closeAndWait(win);
  }

  console.log('a second start while the window is open');
  {
    const workspace = fresh();
    const win = await openAndWait(workspace, small);
    const other = await makePdf('Other.pdf', 1);
    win.minimize();
    await workspace.open([other]);
    check('it brings the same window to the front and opens nothing else', workspace.getWindow() === win && !win.isMinimized() && BrowserWindow.getAllWindows().length === 1 && (await js(win, `document.getElementById('docname').textContent`)) === 'Small.pdf');
    await closeAndWait(win);
  }

  console.log('the place of the window is remembered');
  {
    settings = { pdfView: { window: null } };
    let workspace = fresh();
    let win = await openAndWait(workspace, small);
    win.setBounds({ x: workArea.x + 100, y: workArea.y + 80, width: 1000, height: 700 });
    await sleep(800);
    const moved = win.getBounds();
    check('moving and resizing stores the place, once the user pauses', JSON.stringify(settings.pdfView.window) === JSON.stringify({ ...win.getNormalBounds(), maximised: false }) && moved.width === 1000, JSON.stringify(settings.pdfView.window));
    await closeAndWait(win);
    workspace = fresh();
    win = await openAndWait(workspace, small);
    const again = win.getBounds();
    check('the next window opens where the last one was', again.x === moved.x && again.y === moved.y && again.width === moved.width && again.height === moved.height, JSON.stringify([moved, again]));
    win.maximize();
    await sleep(800);
    const kept = settings.pdfView.window;
    check('maximised is stored with the place it returns to', kept.maximised === true && kept.width === 1000 && kept.x === moved.x, JSON.stringify(kept));
    await closeAndWait(win);
    win = await openAndWait(fresh(), small);
    check('and the window opens maximised', win.isMaximized());
    await closeAndWait(win);
    settings = { pdfView: { window: { x: 90000, y: 90000, width: 1000, height: 700, maximised: false } } };
    win = await openAndWait(fresh(), small);
    const lost = win.getBounds();
    check('a saved place that is on no screen opens in the middle of the main screen at the default size', atDefault(lost) && !win.isMaximized(), JSON.stringify(lost));
    await closeAndWait(win);
    settings = { pdfView: 'not a place' };
    win = await openAndWait(fresh(), small);
    check('a stored value that is not a place is ignored', atDefault(win.getBounds()), JSON.stringify(win.getBounds()));
    await closeAndWait(win);
  }

  console.log('comments a file already holds are markers beside the page');
  for (const theme of ['light', 'dark']) {
    nativeTheme.themeSource = theme;
    const win = await openAndWait(fresh(), await makeCommentsPdf('Comments.pdf'));
    await sleep(800);
    const look = () => js(win, `(() => {
      const page = document.querySelector('.page[data-page-number="1"]'); const p = page.getBoundingClientRect();
      const box = (n) => { const r = n.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height }; };
      return { page: box(page), marks: [...page.querySelectorAll('.cmark')].map(box), others: document.querySelectorAll('.page:not([data-page-number="1"]) .cmark').length,
        sections: document.querySelectorAll('.annotationLayer section').length,
        shown: [...document.querySelectorAll('.textAnnotation, .popupAnnotation')].filter((n) => getComputedStyle(n).display !== 'none').length };
    })()`);
    const centreOf = (v, pdfY) => v.page.top + ((842 - pdfY) / 842) * v.page.height;
    const v = await look();
    check(`${theme}: pdf.js draws its annotation layer, and no note icon or popup of its own is shown`, v.sections > 0 && v.shown === 0, JSON.stringify([v.sections, v.shown]));
    check(`${theme}: three comments give three markers on the first page and none elsewhere`, v.marks.length === 3 && v.others === 0, JSON.stringify([v.marks.length, v.others]));
    check(`${theme}: the markers sit outside the right edge of the page`, v.marks.every((m) => m.left >= v.page.right + 8 && m.right <= v.page.right + 40), JSON.stringify(v.marks.map((m) => [m.left, v.page.right])));
    const [note, quiet, said] = v.marks;
    check(`${theme}: the marker of the commented highlight is level with it`, Math.abs((said.top + said.bottom) / 2 - centreOf(v, 510)) < 1.5, `${(said.top + said.bottom) / 2} vs ${centreOf(v, 510)}`);
    check(`${theme}: the note and the invisible highlight are almost at the same height, yet their markers do not overlap, the higher one level with its item`,
      Math.abs(note.top - quiet.top) >= 27 && Math.abs((quiet.top + quiet.bottom) / 2 - centreOf(v, 713)) < 1.5, JSON.stringify([note.top, quiet.top, centreOf(v, 713)]));
    const cardState = () => js(win, `({ cards: [...document.querySelectorAll('.ccard')].map((c) => c.textContent), on: document.querySelectorAll('.cmark.on').length,
      lit: [...document.querySelectorAll('.clight')].filter((n) => getComputedStyle(n).opacity === '1').length })`);
    await js(win, `document.querySelectorAll('.page[data-page-number="1"] .cmark')[2].click()`);
    await sleep(400);
    let c = await cardState();
    const light = await js(win, `(() => { const r = document.querySelector('.clight.on').getBoundingClientRect(); return { left: r.left, width: r.width, top: r.top, height: r.height }; })()`);
    check(`${theme}: opening a marker shows its comment, tints the marker and lights what the comment is about`, c.cards.length === 1 && c.cards[0] === 'Check this figure\nwith the team' && c.on === 1 && c.lit === 1
      && Math.abs(light.left - (v.page.left + (100 / 595) * (v.page.right - v.page.left))) < 1.5 && Math.abs(light.width - (160 / 595) * (v.page.right - v.page.left)) < 1.5 && Math.abs(light.top - centreOf(v, 520)) < 1.5, JSON.stringify([c, light]));
    await shot(win, `workspace-comment-${theme}.png`);
    win.webContents.focus();
    for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Escape' });
    await sleep(400);
    c = await cardState();
    check(`${theme}: Esc closes the card and clears the light`, c.cards.length === 0 && c.on === 0 && c.lit === 0, JSON.stringify(c));
    await js(win, `document.querySelectorAll('.page[data-page-number="1"] .cmark')[0].click()`);
    await sleep(300);
    c = await cardState();
    check(`${theme}: a note shows who wrote it and when`, c.cards.length === 1 && c.cards[0] === 'Sam · 5 Jan 2026A note from Sam', JSON.stringify(c.cards));
    await js(win, `document.querySelectorAll('.page[data-page-number="1"] .cmark')[1].click()`);
    await sleep(300);
    c = await cardState();
    check(`${theme}: opening another marker closes the first`, c.cards.length === 1 && c.cards[0] === 'Said before the meeting' && c.on === 1, JSON.stringify(c));
    await js(win, `document.querySelector('.page canvas').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
    await sleep(300);
    check(`${theme}: a click anywhere else closes it`, (await cardState()).cards.length === 0);
    await js(win, `document.querySelectorAll('.page[data-page-number="1"] .cmark')[2].click()`);
    await js(win, `document.querySelectorAll('.page[data-page-number="1"] .cmark')[2].click()`);
    check(`${theme}: a second click on the same marker closes it`, (await cardState()).cards.length === 0);

    if (theme === 'light') {
      await js(win, 'workspaceViewer.viewer.spreadMode = 1');
      await sleep(900);
      const two = await look();
      check('in two-page view the left page has its markers on its left, outside it or, on a small screen, just inside its edge', two.marks.length === 3 && two.marks.every((m) => (m.left + m.right) / 2 < two.page.left + 30), JSON.stringify([two.marks.map((m) => m.right), two.page.left]));
      await js(win, 'workspaceViewer.viewer.spreadMode = 0');
      await sleep(900);
      await js(win, `workspaceViewer.viewer.currentScaleValue = 'page-width'`);
      await sleep(1200);
      const wide = await look();
      check('with no room beside the page the markers move just inside its edge', wide.marks.length === 3 && wide.marks.every((m) => m.right <= wide.page.right && m.left >= wide.page.left), JSON.stringify([wide.marks.map((m) => [m.left, m.right]), wide.page]));
      await js(win, `workspaceViewer.viewer.currentScaleValue = 'page-fit'`);
      await sleep(900);

      console.log('scroll bars');
      // The pointer may be over the window, which would show the thumb, so the colours are read from a scroller it cannot reach.
      const probe = await js(win, `(async () => { const n = document.createElement('div'); n.className = 'scroller'; n.style.pointerEvents = 'none'; document.querySelector('.well').append(n);
        const colour = () => getComputedStyle(n).scrollbarColor; const rest = colour(); n.classList.add('scrolling'); await new Promise((r) => setTimeout(r, 600)); const scrolling = colour(); n.remove(); return { rest, scrolling }; })()`);
      check('at rest the scroll bar thumb is transparent, and while the area scrolls it shows', /^rgba\(0, 0, 0, 0\) rgba\(0, 0, 0, 0\)$/.test(probe.rest) && !probe.scrolling.startsWith('rgba(0, 0, 0, 0)'), JSON.stringify(probe));
      await js(win, `document.getElementById('scroller').scrollTop = 120`);
      await sleep(300);
      const marked = await js(win, `document.getElementById('scroller').classList.contains('scrolling')`);
      await sleep(1500);
      check('scrolling the document marks it, and the mark is gone 0.9 s after it stops', marked && !(await js(win, `document.getElementById('scroller').classList.contains('scrolling')`)));
    }
    await closeAndWait(win);
  }
  nativeTheme.themeSource = 'light';

  console.log('a password-protected file');
  {
    const secret = `Pw-${crypto.randomBytes(6).toString('hex')}`;
    const locked = path.join(root, 'Locked.pdf');
    fs.writeFileSync(locked, encryptedPdf(secret));
    const askedFor = (win) => until('the password dialog', () => js(win, `!!document.querySelector('.veil input') && !document.querySelector('.veil input').disabled`));
    const submit = (win, text) => js(win, `(() => { const f = document.querySelector('.veil input'); f.value = ${JSON.stringify(text)}; f.dispatchEvent(new Event('input')); document.querySelector('.veil .primary').click(); })()`);

    let workspace = fresh();
    calls.length = 0;
    await workspace.open([locked]);
    let win = workspace.getWindow();
    win.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
    await askedFor(win);
    const dialog = await js(win, `({ title: document.querySelector('.veil h3').textContent, type: document.querySelector('.veil input').type, hint: document.querySelector('.veil input').placeholder,
      buttons: [...document.querySelectorAll('.veil .btn')].map((b) => b.textContent), focused: document.activeElement === document.querySelector('.veil input'), pages: document.querySelectorAll('.page').length })`);
    check('a protected file asks for its password, in a field that hides what is typed, and shows no page yet', dialog.title === 'Password protected' && dialog.type === 'password' && dialog.hint === 'Password' && dialog.buttons.join() === 'Cancel,Open' && dialog.focused && dialog.pages === 0, JSON.stringify(dialog));
    await sleep(500);
    await shot(win, 'workspace-password.png');
    const head = await js(win, `({ badge: document.querySelector('.veil .ico svg.f text.badge')?.textContent, lock: !!document.querySelector('.veil .ico .lk svg'), labelled: document.querySelector('.veil [role=dialog]').getAttribute('aria-labelledby') })`);
    check('the card shows the file as a PDF icon with a lock on it', head.badge === 'PDF' && head.lock && head.labelled === 'dialog-title', JSON.stringify(head));
    const primary = () => js(win, `document.querySelector('.veil .primary').disabled`);
    const emptyDisabled = await primary();
    await js(win, `(() => { const f = document.querySelector('.veil input'); f.value = 'x'; f.dispatchEvent(new Event('input')); })()`);
    const typedEnabled = !(await primary());
    await js(win, `(() => { const f = document.querySelector('.veil input'); f.value = ''; f.dispatchEvent(new Event('input')); })()`);
    check('the Open button is off until something is typed, and off again when the field is emptied', emptyDisabled && typedEnabled && (await primary()));
    const eye = () => js(win, `(() => { const f = document.querySelector('.veil input'); const b = document.querySelector('.veil .pw button'); return { type: f.type, label: b.getAttribute('aria-label'), pressed: b.getAttribute('aria-pressed'), value: f.value, focused: document.activeElement === f, drawn: !!b.querySelector('svg') }; })()`);
    const before = await eye();
    await js(win, `(() => { document.querySelector('.veil input').value = 'typed text'; document.querySelector('.veil .pw button').click(); })()`);
    const shown = await eye();
    await shot(win, 'workspace-password-shown.png');
    await js(win, `document.querySelector('.veil .pw button').click()`);
    const hidden = await eye();
    check('an eye button in the field shows what was typed and hides it again, keeping the text and the focus', before.type === 'password' && before.label === 'Show password' && before.pressed === 'false' && before.drawn
      && shown.type === 'text' && shown.label === 'Hide password' && shown.pressed === 'true' && shown.value === 'typed text' && shown.focused && hidden.type === 'password' && hidden.label === 'Show password' && hidden.value === 'typed text', JSON.stringify([before, shown, hidden]));
    await js(win, `window.firstCard = document.querySelector('.veil')`);
    await submit(win, 'not the password');
    await until('the second ask', () => js(win, `!!document.querySelector('.veil .emsg.on') && !document.querySelector('.veil input').disabled`));
    const wrong = await js(win, `(() => { const f = document.querySelector('.veil input'); return { same: document.querySelector('.veil') === window.firstCard, message: document.querySelector('.veil .emsg p').textContent, button: document.querySelector('.veil .primary').textContent,
      value: f.value, selected: f.selectionStart === 0 && f.selectionEnd === f.value.length, invalid: f.getAttribute('aria-invalid'), red: document.querySelector('.veil .pw').classList.contains('bad'), focused: document.activeElement === f, enabled: !document.querySelector('.veil .primary').disabled }; })()`);
    await sleep(450);
    await shot(win, 'workspace-password-wrong.png');
    check('a wrong password is answered in the same card: the field turns red, says Wrong Password, keeps what was typed selected, and the button reads Try Again',
      wrong.same && wrong.message === 'Wrong Password' && wrong.button === 'Try Again' && wrong.value === 'not the password' && wrong.selected && wrong.invalid === 'true' && wrong.red && wrong.focused && wrong.enabled, JSON.stringify(wrong));
    await js(win, `window.keep = document.querySelector('.veil input')`);
    await submit(win, secret);
    await until('the first page', () => js(win, `!!document.querySelector('.page[data-loaded="true"] canvas')`));
    check('the right password opens the file, and the field was emptied and removed', (await js(win, `({ veil: !!document.querySelector('.veil'), field: window.keep.value, failure: document.getElementById('failure').hidden })`)).veil === false
      && (await js(win, `window.keep.value`)) === '' && (await inkOnFirstPage(win)) > 100);
    const sent = calls.filter((call) => JSON.stringify(call.args).includes(secret));
    check('the password reached the main process once, through the unlock call only, and the wrong one never did', sent.length === 1 && sent[0].channel === 'pdfws:unlock' && sent[0].args[1] === secret && !JSON.stringify(calls).includes('not the password'), JSON.stringify(calls.map((c) => c.channel)));
    check('the window title does not carry it', !win.getTitle().includes(secret));
    await closeAndWait(win);

    workspace = fresh();
    calls.length = 0;
    await workspace.open([locked]);
    win = workspace.getWindow();
    await askedFor(win);
    await js(win, `document.querySelector('.veil .btn:not(.primary)').click()`);
    await until('the failure', () => js(win, `!document.getElementById('failure').hidden`));
    const panel = () => js(win, `({ text: document.getElementById('failure').firstChild.textContent, button: document.querySelector('#failure button')?.textContent || '' })`);
    check('cancelling shows that the file is password-protected with an Unlock button, and the main process was told nothing', JSON.stringify(await panel()) === '{"text":"This file is password-protected","button":"Unlock"}' && !calls.some((c) => c.channel === 'pdfws:unlock'));
    await shot(win, 'workspace-locked.png');
    await js(win, `document.querySelector('#failure button').click()`);
    await askedFor(win);
    check('Unlock asks for the password again, from the start', (await js(win, `({ panel: document.getElementById('failure').hidden, error: !!document.querySelector('.veil .bad'), submit: document.querySelector('.veil .primary').textContent })`)).submit === 'Open'
      && (await js(win, `document.getElementById('failure').hidden && !document.querySelector('.veil .bad')`)));
    await submit(win, secret);
    await until('the first page', () => js(win, `!!document.querySelector('.page[data-loaded="true"] canvas')`));
    check('and the right password then opens the file', (await inkOnFirstPage(win)) > 100 && (await js(win, `document.getElementById('failure').hidden`)) && calls.filter((c) => c.channel === 'pdfws:unlock').length === 1);
    await closeAndWait(win);

    workspace = fresh();
    calls.length = 0;
    await workspace.open([locked]);
    win = workspace.getWindow();
    for (let attempt = 1; attempt <= 5; attempt++) {
      await askedFor(win);
      if (attempt > 1) check(`after ${attempt - 1} wrong passwords the question is still there`, (await js(win, `!!document.querySelector('.veil .bad')`)));
      await submit(win, `wrong ${attempt}`);
      await sleep(300);
    }
    await until('the failure', () => js(win, `!document.getElementById('failure').hidden`));
    check('five wrong passwords end in the same message and Unlock button, with no further question', JSON.stringify(await panel()) === '{"text":"This file is password-protected","button":"Unlock"}' && (await js(win, `!document.querySelector('.veil')`)) && !calls.some((c) => c.channel === 'pdfws:unlock'));
    await js(win, `document.querySelector('#failure button').click()`);
    await askedFor(win);
    check('Unlock after that asks again with a fresh count', !(await js(win, `!!document.querySelector('.veil .bad')`)));
    await closeAndWait(win);
  }

  console.log('the password card while a password is checked');
  {
    const win = await openAndWait(fresh(), small);
    const state = await js(win, `(async () => {
      let aborted = 0;
      const ask = workspaceDialogs.askPassword(false, () => { aborted++; });
      const field = document.querySelector('.veil input');
      field.value = 'x'; field.dispatchEvent(new Event('input'));
      document.querySelector('.veil .primary').click();
      const typed = await ask;
      const primary = document.querySelector('.veil .primary');
      const busy = { typed, field: field.disabled, eye: document.querySelector('.veil .pw button').disabled, primary: primary.disabled, aria: primary.getAttribute('aria-busy'), spinner: !!primary.querySelector('.spin'), label: primary.textContent, cancel: !document.querySelector('.veil .btn:not(.primary)').disabled };
      document.querySelector('.veil .btn:not(.primary)').click();
      workspaceDialogs.closePassword();
      return { busy, aborted, gone: !document.querySelector('.veil') };
    })()`);
    check('while the password is checked the field and the button rest with a spinner, and Cancel still works and stops the check', state.busy.typed === 'x' && state.busy.field && state.busy.eye && state.busy.primary && state.busy.aria === 'true' && state.busy.spinner && state.busy.label === '' && state.busy.cancel && state.aborted === 1 && state.gone, JSON.stringify(state));
    await closeAndWait(win);
  }

  console.log('a big file costs nothing until it is read');
  {
    const big = await makePdf('Big.pdf', 3000, { extraBytes: 40 * 1048576 });
    const size = fs.statSync(big).size;
    const workspace = fresh();
    const win = await openAndWait(workspace, big);
    await sleep(500);
    const first = workspace.served();
    const canvases = await js(win, `document.querySelectorAll('.page canvas').length`);
    check(`opening ${Math.round(size / 1048576)} MB with 3 000 pages serves under 4 MB to draw the first page (${(first / 1048576).toFixed(2)} MB)`, first > 0 && first < 4 * 1048576, String(first));
    check('the document has 3 000 pages and fewer than 20 of them are drawn', (await js(win, `document.querySelectorAll('.page').length`)) === 3000 && canvases > 0 && canvases < 20, String(canvases));
    await sleep(5000);
    check('five idle seconds later nothing more has been read', workspace.served() === first, `${first} -> ${workspace.served()}`);
    const reach = await js(win, `document.querySelectorAll('.page')[50].getBoundingClientRect().top - document.getElementById('scroller').getBoundingClientRect().top + document.getElementById('scroller').scrollTop`);
    for (let step = 1; step <= 10; step++) { await js(win, `document.getElementById('scroller').scrollTop = ${(reach * step) / 10}`); await sleep(250); }
    await sleep(1500);
    const scrolled = await js(win, `({ canvases: document.querySelectorAll('.page canvas').length, page: workspaceViewer.viewer.currentPageNumber })`);
    check('after scrolling 50 pages the view is at page 51, fewer than 20 pages are drawn and under 5 % of the file was read', scrolled.page === 51 && scrolled.canvases > 0 && scrolled.canvases < 20 && workspace.served() < size * 0.05, `${JSON.stringify(scrolled)} ${workspace.served()} of ${size}`);
    await closeAndWait(win);
    check('closing the window closes the file', workspace.served() === 0 && (() => { try { fs.rmSync(big); return true; } catch { return false; } })());
  }

  console.log('a file that cannot be shown');
  {
    const notPdf = path.join(root, 'Notes.pdf');
    fs.writeFileSync(notPdf, 'This is a text file with a .pdf name.');
    const win = await openAndWait(fresh(), notPdf);
    const ui = await js(win, `({ failure: document.getElementById('failure').hidden ? '' : document.getElementById('failure').textContent, pages: document.querySelectorAll('.page').length })`);
    check('a text file with a .pdf name says it is damaged or not a PDF', ui.failure === 'This file is damaged or is not a PDF' && ui.pages === 0, JSON.stringify(ui));
    await shot(win, 'workspace-failure.png');
    await closeAndWait(win);
    const workspace = fresh();
    await workspace.open([path.join(root, 'nope.pdf')]);
    check('a file that is not there opens no window and says so in the corner notice', workspace.getWindow() === null && BrowserWindow.getAllWindows().length === 0 && notices.length === 1 && notices[0].title === "Can't open this file" && notices[0].detail === 'The file is no longer there.', JSON.stringify(notices));
  }

  console.log(failed() ? `\n${failed()} failed` : '\nall passed');
  finish();
}).catch((e) => { console.error(e); finish(2); });

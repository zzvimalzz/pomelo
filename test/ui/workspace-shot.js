// SPDX-License-Identifier: AGPL-3.0-or-later
// Opens the real workspace window on PDFs drawn here: the window's size, place and look in both themes (glass and the opaque
// window of Windows 10), the options pdf.js is given, how many bytes a 40 MB, 3 000-page file costs to show its first page, while
// idle and after scrolling 50 pages, the comments a file holds as markers beside the page, the scroll bars, the pages panel and its outline, a password-protected
// file, a file that is not a PDF, a file that is not there, and that the page is cut off from the network. Saves screenshots.
//   npx electron test/ui/workspace-shot.js
const { app, BrowserWindow, clipboard, ipcMain, nativeTheme, screen } = require('electron');
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
const opened = [];
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, fn) => handle(channel, (event, ...args) => { calls.push({ channel, args }); return fn(event, ...args); });
const setSettings = (patch) => { settings = { ...settings, ...patch }; };

// One workspace per scenario: the IPC handlers belong to one at a time.
const fresh = (options = {}) => {
  for (const channel of ['pdfws:state', 'pdfws:read', 'pdfws:unlock', 'pdfws:focus', 'pdfws:dock', 'pdfws:check-link', 'pdfws:open-link']) ipcMain.removeHandler(channel);
  const workspace = createWorkspace({ asset, getSettings: () => settings, setSettings, notify: (m) => notices.push(m), log: () => {}, openExternal: (url) => { opened.push(url); return Promise.resolve(); }, ...options });
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

// Page 1 has a line of text under each link, from the top: a web page, a mail address, a file, a script, an ftp address, page 3, an
// action that goes to the next page, a link to another file and a program to launch. Pages 2 and 3 say which they are.
async function makeLinksPdf(name) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const [first, second, third] = [doc.addPage([595, 842]), doc.addPage([595, 842]), doc.addPage([595, 842])];
  second.drawText('Page two', { x: 80, y: 700, size: 20, font });
  third.drawText('Page three', { x: 80, y: 700, size: 20, font });
  const actions = [
    ['Web page', { S: 'URI', URI: PDFString.of('HTTPS://Example.COM/Docs?a=1#top') }],
    ['Mail', { S: 'URI', URI: PDFString.of('mailto:team@example.com') }],
    ['File', { S: 'URI', URI: PDFString.of('file:///C:/Windows/System32/calc.exe') }],
    ['Script', { S: 'URI', URI: PDFString.of('javascript:alert(1)') }],
    ['Ftp', { S: 'URI', URI: PDFString.of('ftp://example.com/x') }],
    ['Go to page 3', { S: 'GoTo', D: [third.ref, 'Fit'] }],
    ['Next page', { S: 'Named', N: 'NextPage' }],
    ['Another file', { S: 'GoToR', F: PDFString.of('other.pdf'), D: [0, 'Fit'] }],
    ['Launch', { S: 'Launch', F: PDFString.of('calc.exe') }],
  ];
  const links = actions.map(([text, A], i) => {
    const y = 760 - i * 40;
    first.drawText(text, { x: 80, y, size: 16, font });
    return doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [70, y - 6, 260, y + 20], Border: [0, 0, 0], F: 4, A }));
  });
  first.node.set(PDFName.of('Annots'), doc.context.obj(links));
  const file = path.join(root, name);
  fs.writeFileSync(file, await doc.save({ useObjectStreams: false }));
  return file;
}

// "delivery" is on every page: with a capital on the first, plainly on the second, and twice on the third, once inside "redelivery".
// A phrase breaks over two lines on the second.
async function makeSearchPdf(name) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = [['Delivery of the goods', 'will happen on Monday.'], ['The quick brown', 'fox jumps over the lazy dog.', null, 'You can ask for delivery here.'], ['Delivery', 'redelivery']];
  for (const lines of pages) {
    const page = doc.addPage([595, 842]);
    lines.forEach((line, i) => { if (line) page.drawText(line, { x: 80, y: 700 - i * 20, size: 14, font }); });
  }
  const file = path.join(root, name);
  fs.writeFileSync(file, await doc.save({ useObjectStreams: false }));
  return file;
}

// Two pages of forty lines, each line six times 'alpha'.
async function makeManyPdf(name) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 0; n < 2; n++) {
    const page = doc.addPage([595, 842]);
    for (let line = 0; line < 40; line++) page.drawText('alpha alpha alpha alpha alpha alpha', { x: 60, y: 800 - line * 18, size: 12, font });
  }
  const file = path.join(root, name);
  fs.writeFileSync(file, await doc.save({ useObjectStreams: false }));
  return file;
}

async function makeOutlinePdf(name) {
  const doc = await PDFDocument.create();
  for (let n = 1; n <= 5; n++) doc.addPage([595, 842]).drawText(`Outline test page ${n}`, { x: 60, y: 700, size: 22 });
  const tree = [
    { title: 'Chapter 1', page: 1, items: [{ title: 'Section 1.1', page: 2 }, { title: 'Section 1.2', page: 3 }] },
    { title: 'Chapter 2', page: 4, closed: true, items: [{ title: 'Hidden child', page: 5 }] },
    { title: '<b>Bold?</b> & more', page: 2 },
    { title: 'Appendix' },
  ];
  const build = (list, parent) => {
    const refs = list.map(() => doc.context.nextRef());
    list.forEach((item, i) => {
      const dict = { Title: PDFHexString.fromText(item.title), Parent: parent };
      if (item.page) dict.Dest = [doc.getPage(item.page - 1).ref, 'Fit'];
      if (i > 0) dict.Prev = refs[i - 1];
      if (i < list.length - 1) dict.Next = refs[i + 1];
      if (item.items) {
        const kids = build(item.items, refs[i]);
        Object.assign(dict, { First: kids.first, Last: kids.last, Count: item.closed ? -kids.count : kids.count });
      }
      doc.context.assign(refs[i], doc.context.obj(dict));
    });
    return { first: refs[0], last: refs[list.length - 1], count: list.length };
  };
  const outlines = doc.context.nextRef();
  const top = build(tree, outlines);
  doc.context.assign(outlines, doc.context.obj({ Type: 'Outlines', First: top.first, Last: top.last, Count: top.count }));
  doc.catalog.set(PDFName.of('Outlines'), outlines);
  const file = path.join(root, name);
  fs.writeFileSync(file, await doc.save({ useObjectStreams: false }));
  return file;
}

const inkOnFirstPage = (win) => js(win, `(() => { const c = document.querySelector('.page canvas'); if (!c) return -1; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let dark = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 100 && d[i + 1] < 100 && d[i + 2] < 100) dark++; return dark; })()`);
const closeAndWait = async (win) => { win.close(); await sleep(500); };
const press = async (win, keyCode, modifiers = []) => {
  win.webContents.focus();
  for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode, modifiers });
  await sleep(300);
};
const DOCK_IN_VIEW = `(() => { const r = document.querySelector('.dock').getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth ? 1 : 0; })()`;
const dockState = (win) => js(win, `(() => { const d = document.querySelector('.dock'); const own = [...d.querySelectorAll('button:not(.mi)')];
  return { titles: own.map((b) => b.title), page: d.querySelector('.pageno').value, count: d.querySelector('.pagecount').textContent, zoom: d.querySelector('.zoom').textContent,
    folded: d.classList.contains('folded'), opacity: getComputedStyle(d).opacity, current: workspaceViewer.viewer.currentPageNumber, scale: workspaceViewer.viewer.currentScaleValue,
    menu: !d.querySelector('.menu').hidden, layout: workspaceViewer.viewer.spreadMode, full: document.body.classList.contains('focus') }; })()`);

const panelState = (win) => js(win, `(() => { const p = document.getElementById('rail'); const b = document.getElementById('pagesbtn'); const w = document.querySelector('.well').getBoundingClientRect(); const items = [...document.querySelectorAll('.thumb')];
  return { width: p.getBoundingClientRect().width, display: getComputedStyle(p).display, hidden: document.getElementById('railinner').hidden, title: b.title, label: b.getAttribute('aria-label'), pressed: b.getAttribute('aria-pressed'), disabled: b.disabled,
    wellLeft: w.left, wellWidth: w.width, items: items.length, canvases: document.querySelectorAll('.thumb canvas').length, on: items.filter((i) => i.classList.contains('on')).map((i) => i.dataset.n).join(),
    labels: items.slice(0, 3).map((i) => i.getAttribute('aria-label')).join(), kept: window.workspaceSidebar.thumbs ? window.workspaceSidebar.thumbs.kept() : -1, current: workspaceViewer.viewer.currentPageNumber, page: document.querySelector('.pageno').value }; })()`);
const outlineState = (win) => js(win, `(() => { const rows = [...document.querySelectorAll('#outline .orow')].filter((r) => !r.closest('[hidden]'));
  const folds = {}; for (const r of document.querySelectorAll('#outline .orow')) if (r.parentElement.hasAttribute('aria-expanded')) folds[r.textContent] = r.parentElement.getAttribute('aria-expanded');
  return { checked: [...document.querySelectorAll('.seg3 button')].map((b) => b.textContent + '=' + b.getAttribute('aria-checked')).join(), thumbsHidden: document.getElementById('thumbs').hidden, outlineHidden: document.getElementById('outline').hidden,
    rows: rows.map((r) => r.textContent).join('|'), folds: JSON.stringify(folds), empty: document.querySelector('#outline .empty')?.textContent ?? '', trees: document.querySelectorAll('#outline .tree').length, markup: document.querySelectorAll('#outline b').length,
    tabstops: document.querySelectorAll('#outline .orow[tabindex="0"]').length, focused: document.activeElement.classList.contains('orow') ? document.activeElement.textContent : document.activeElement.id, current: workspaceViewer.viewer.currentPageNumber, canvases: document.querySelectorAll('.thumb canvas').length, inScroller: document.getElementById('scroller').contains(document.activeElement) }; })()`);
const clickRow = (win, title, part = 'span:last-child') => js(win, `[...document.querySelectorAll('#outline .orow')].find((r) => r.textContent === ${JSON.stringify(title)}).querySelector('${part}').click()`);
const clickPagesButton = async (win) => { await js(win, `document.getElementById('pagesbtn').click()`); await sleep(900); };
const barState = (win) => js(win, `(() => { const s = document.querySelector('.findbar'); const b = document.getElementById('findbtn'); const q = s.querySelector('input'); const hits = [...document.querySelectorAll('.textLayer .highlight')];
  return { hidden: s.hidden, count: s.querySelector('.count').textContent, query: q.value, focused: document.activeElement === q, pressed: b.getAttribute('aria-pressed'), title: b.title, hits: hits.length, selected: hits.filter((h) => h.classList.contains('selected')).length,
    page: workspaceViewer.viewer.currentPageNumber, opts: [...s.querySelectorAll('.opt')].map((o) => o.title + '=' + o.getAttribute('aria-pressed')).join(), inScroller: document.getElementById('scroller').contains(document.activeElement), disabled: b.disabled,
    tips: [...s.querySelectorAll('.sm')].map((o) => o.title).join(), placeholder: q.placeholder, titleLeft: [...document.querySelector('.titleleft').children].map((c) => c.id).join() }; })()`);
const typeInto = async (win, text) => {
  for (const ch of text) for (const type of ['keyDown', 'char', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: ch });
  await sleep(600);
};
const countIs = (win, what) => until(String(what), async () => { const c = (await barState(win)).count; return what instanceof RegExp ? what.test(c) : c === what; }, 8000);

app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  const small = await makePdf('Small.pdf', 3);
  const twelve = await makePdf('Twelve.pdf', 12);
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
    check('moving and resizing stores the place and the time, once the user pauses', JSON.stringify({ ...settings.pdfView.window, savedAt: 0 }) === JSON.stringify({ ...win.getNormalBounds(), maximised: false, savedAt: 0 }) && Math.abs(Date.now() - settings.pdfView.window.savedAt) < 5000 && moved.width === 1000, JSON.stringify(settings.pdfView.window));
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
    settings = { pdfView: { window: { ...moved, x: workArea.x + 100, y: workArea.y + 80, width: 1000, height: 700, maximised: true, savedAt: Date.now() - 25 * 3600 * 1000 } } };
    win = await openAndWait(fresh(), small);
    check('a place saved more than 24 hours ago is forgotten: the window opens at the default size, not maximised', atDefault(win.getBounds()) && !win.isMaximized(), JSON.stringify(win.getBounds()));
    await closeAndWait(win);
    settings = { pdfView: { window: { x: 90000, y: 90000, width: 1000, height: 700, maximised: false, savedAt: Date.now() } } };
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

  console.log('the dock: pages, zoom and the View menu');
  for (const theme of ['light', 'dark']) {
    nativeTheme.themeSource = theme;
    const win = await openAndWait(fresh(), twelve);
    await sleep(900);
    let d = await dockState(win);
    check(`${theme}: the dock holds the page group and the zoom group and nothing else`, d.titles.join('|') === 'Drag to move|Previous page (Page Up)|Next page (Page Down)|Zoom out (Ctrl+−)|View options|Zoom in (Ctrl+=)'
      && d.page === '1' && d.count === '/ 12' && d.zoom === 'Fit page' && d.opacity === '1', JSON.stringify(d));
    await js(win, `document.querySelector('.dock [aria-label="Next page"]').click()`);
    await sleep(400);
    d = await dockState(win);
    check(`${theme}: Next goes to page 2, the page box follows and the dock stays`, d.current === 2 && d.page === '2' && !d.folded, JSON.stringify(d));
    const typeInBox = (text) => js(win, `(() => { const f = document.querySelector('.pageno'); f.focus(); f.value = ${JSON.stringify(text)}; f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    await typeInBox('7');
    await sleep(400);
    d = await dockState(win);
    check(`${theme}: a number and Enter in the page box goes to that page, and the focus returns to the document`, d.current === 7 && d.page === '7' && !d.folded && (await js(win, `document.activeElement === document.getElementById('scroller')`)), JSON.stringify(d));
    await typeInBox('99');
    await sleep(400);
    check(`${theme}: a number past the end goes to the last page`, (await dockState(win)).current === 12);
    await typeInBox('abc');
    await sleep(300);
    d = await dockState(win);
    check(`${theme}: text that is not a number changes nothing and the box shows the page again`, d.current === 12 && d.page === '12', JSON.stringify(d));
    await shot(win, `workspace-dock-${theme}.png`);

    await press(win, '=', ['control']);
    d = await dockState(win);
    check(`${theme}: Ctrl+= zooms in from Fit page to a percentage`, /^\d+%$/.test(d.zoom), JSON.stringify(d));
    await press(win, '0', ['control']);
    check(`${theme}: Ctrl+0 fits the width`, (await dockState(win)).zoom === 'Fit width');
    await press(win, '1', ['control']);
    check(`${theme}: Ctrl+1 is actual size`, (await dockState(win)).zoom === '100%');
    await press(win, '-', ['control']);
    check(`${theme}: Ctrl+minus zooms out`, (await dockState(win)).zoom === '90%');
    await press(win, '+', ['control', 'shift']);
    check(`${theme}: Ctrl+plus with Shift zooms in`, (await dockState(win)).zoom === '100%');
    await js(win, `document.querySelector('.dock [aria-label="Zoom in"]').click()`);
    await sleep(300);
    const zoomedIn = (await dockState(win)).zoom;
    await js(win, `document.querySelector('.dock [aria-label="Zoom out"]').click()`);
    await sleep(300);
    check(`${theme}: the plus and minus buttons zoom in and out`, zoomedIn === '110%' && (await dockState(win)).zoom === '100%', zoomedIn);

    await js(win, `document.querySelector('.dock .zoom').click()`);
    await sleep(500);
    const menu = await js(win, `(() => { const m = document.querySelector('.menu'); return { shown: !m.hidden, caps: [...m.querySelectorAll('.cap')].map((n) => n.textContent), items: [...m.querySelectorAll('.mi')].map((n) => n.firstChild.textContent),
      keys: [...m.querySelectorAll('kbd')].map((n) => n.textContent), expanded: document.querySelector('.dock .zoom').getAttribute('aria-expanded') }; })()`);
    check(`${theme}: the zoom value opens the View menu with Zoom and Layout and no page colours`, menu.shown && menu.expanded === 'true' && menu.caps.join() === 'Zoom,Layout'
      && menu.items.join() === 'Fit width,Fit page,Actual size,Continuous,Two pages side by side' && menu.keys.join() === 'Ctrl+0,Ctrl+1', JSON.stringify(menu));
    await shot(win, `workspace-menu-${theme}.png`);
    await press(win, 'Escape');
    check(`${theme}: Esc closes the menu`, !(await dockState(win)).menu);
    await js(win, `document.querySelector('.dock .zoom').click()`);
    await js(win, `[...document.querySelectorAll('.menu .mi')].find((n) => n.textContent.startsWith('Two pages')).click()`);
    await sleep(500);
    d = await dockState(win);
    check(`${theme}: choosing Two pages side by side lays the pages out in pairs and closes the menu`, d.layout === 1 && !d.menu, JSON.stringify(d));
    await js(win, `document.querySelector('.dock .zoom').click()`);
    check(`${theme}: the menu marks the layout in use`, (await js(win, `[...document.querySelectorAll('.menu .mi.on')].map((n) => n.firstChild.textContent).join()`)) === 'Two pages side by side');
    await js(win, `document.querySelector('.page canvas').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
    check(`${theme}: a click elsewhere closes it`, !(await dockState(win)).menu);
    await js(win, `document.querySelector('.dock .zoom').click()`);
    await js(win, `[...document.querySelectorAll('.menu .mi')].find((n) => n.textContent.startsWith('Continuous')).click()`);
    await js(win, `document.querySelector('.dock .zoom').click()`);
    await js(win, `[...document.querySelectorAll('.menu .mi')].find((n) => n.textContent.startsWith('Fit width')).click()`);
    await sleep(500);
    d = await dockState(win);
    check(`${theme}: Continuous and Fit width from the menu are applied`, d.layout === 0 && d.zoom === 'Fit width' && !d.menu, JSON.stringify(d));

    if (theme === 'light') {
      await js(win, `workspaceViewer.viewer.currentScaleValue = 'page-fit'`);
      await sleep(400);
      const scaleOf = () => js(win, `workspaceViewer.viewer.currentScale`);
      const fitScale = await scaleOf();
      win.setBounds({ ...win.getBounds(), width: 900, height: 600 });
      await sleep(900);
      check('a fit follows the window as it is resized', Math.abs((await scaleOf()) - fitScale) > 0.01, `${fitScale} -> ${await scaleOf()}`);
      await js(win, `workspaceViewer.viewer.currentScaleValue = '1.5'`);
      await sleep(300);
      win.setBounds({ ...win.getBounds(), width: 1100, height: 760 });
      await sleep(900);
      check('a zoom the user chose stays as it is when the window is resized', (await scaleOf()) === 1.5, String(await scaleOf()));
      win.setBounds({ ...win.getBounds(), width: 900, height: 600 });
      await sleep(900);
      const fits = await js(win, `(() => { const r = document.querySelector('.dock').getBoundingClientRect(); const w = document.querySelector('.well').getBoundingClientRect(); return r.left >= w.left && r.right <= w.right && r.top >= w.top && r.bottom <= w.bottom; })()`);
      check('in a window of the smallest size the dock is inside the document area', fits);
      win.setBounds({ ...win.getBounds(), width: size.width, height: size.height });
      await sleep(600);

      console.log('zoom keeps the point under the pointer');
      await js(win, `workspaceViewer.viewer.currentScaleValue = '2.5'`);
      await sleep(800);
      const at = await js(win, `(async () => { const s = document.getElementById('scroller'); const scaleBefore = workspaceViewer.viewer.currentScale; s.scrollLeft = 400; s.scrollTop = document.querySelector('.page[data-page-number="2"]').offsetTop + 300;
        await new Promise((r) => setTimeout(r, 400)); const c = s.getBoundingClientRect(); const x = c.left + 500; const y = c.top + 300;
        const page = [...document.querySelectorAll('.page')].find((p) => { const r = p.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; }); const r = page.getBoundingClientRect();
        window.probe = { n: page.dataset.pageNumber, x, y, fx: (x - r.left) / r.width, fy: (y - r.top) / r.height };
        s.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -100, clientX: x, clientY: y, bubbles: true, cancelable: true })); return { scale: scaleBefore, ...window.probe }; })()`);
      await sleep(900);
      const after = await js(win, `(() => { const p = window.probe; const r = document.querySelector('.page[data-page-number="' + p.n + '"]').getBoundingClientRect(); return { scale: workspaceViewer.viewer.currentScale, x: r.left + p.fx * r.width, y: r.top + p.fy * r.height }; })()`);
      check('Ctrl and the wheel zoom one step and the spot under the pointer stays under it', after.scale > at.scale && Math.abs(after.x - at.x) < 3 && Math.abs(after.y - at.y) < 3, JSON.stringify([at, after]));
      await js(win, `workspaceViewer.viewer.currentScaleValue = 'page-fit'`);
      await sleep(600);

      console.log('scrolling leaves the dock alone, and a round button folds it away and back');
      const scrollTo = async (top) => { await js(win, `document.getElementById('scroller').scrollTop = ${top}`); await sleep(500); };
      const foldState = () => js(win, `(() => { const d = document.querySelector('.dock'); const f = document.querySelector('.fold'); const dr = document.querySelector('.dockwrap').getBoundingClientRect(); const fr = f.getBoundingClientRect(); const br = d.getBoundingClientRect();
        const p = document.querySelector('.dock .zoom').getBoundingClientRect(); const hit = document.elementFromPoint((p.left + p.right) / 2, (p.top + p.bottom) / 2);
        return { folded: d.classList.contains('folded'), opacity: getComputedStyle(d).opacity, inert: d.inert, title: f.title, label: f.getAttribute('aria-label'), fx: (fr.left + fr.right) / 2 - (dr.left + dr.right) / 2,
          fy: (fr.top + fr.bottom) / 2 - (dr.top + dr.bottom) / 2, gap: fr.left - dr.right, button: getComputedStyle(f).opacity, reachable: !!hit && !!hit.closest('.dock'), away: br.top >= document.querySelector('.well').getBoundingClientRect().bottom, round: getComputedStyle(f).borderRadius,
          select: getComputedStyle(d).userSelect, alpha: Number(getComputedStyle(d).backgroundColor.match(/[0-9.]+/g)[3] ?? 1) }; })()`);
      await scrollTo(0);
      await scrollTo(300);
      let f = await foldState();
      check('scrolling down leaves the dock where it is', !f.folded && f.opacity === '1' && f.reachable, JSON.stringify(f));
      await scrollTo(600);
      await scrollTo(100);
      check('so does scrolling back up', (await foldState()).opacity === '1');
      check('a round button stands just past the end of the dock, level with it, and offers to hide it', Math.abs(f.fy) < 2 && f.gap > 6 && f.gap < 14 && f.title === 'Hide controls' && f.label === 'Hide controls' && f.round === '50%', JSON.stringify(f));
      check('the dock is opaque enough that text under it does not show through, and cannot be selected from it', f.alpha >= 0.95 && f.select === 'none', JSON.stringify(f));
      await js(win, `document.querySelector('.fold').click()`);
      await sleep(700);
      f = await foldState();
      check('the button slides the dock off the bottom edge, and then the button takes the middle of where the dock was', f.folded && f.away && f.opacity === '1' && f.inert && !f.reachable && f.button === '1' && Math.abs(f.fx) < 2 && Math.abs(f.fy) < 2 && f.title === 'Show controls' && f.label === 'Show controls', JSON.stringify(f));
      await shot(win, `workspace-dock-folded-${theme}.png`);
      await js(win, `workspaceViewer.viewer.currentPageNumber = 5`);
      await sleep(300);
      check('a folded dock still shows the page for a moment when it changes', await js(win, `(() => { const n = document.querySelector('.flash'); return n.classList.contains('show') && n.textContent === '5 / 12'; })()`));
      await scrollTo(400);
      check('scrolling does not bring it back', (await foldState()).folded);
      await js(win, `document.querySelector('.fold').click()`);
      await sleep(700);
      f = await foldState();
      check('pressing the button again brings the dock back, and the button returns beside it', !f.folded && !f.away && f.opacity === '1' && !f.inert && f.reachable && f.gap > 6 && f.gap < 14 && Math.abs(f.fy) < 2 && f.title === 'Hide controls', JSON.stringify(f));
      await js(win, `workspaceViewer.viewer.currentPageNumber = 1`);
    }
    await closeAndWait(win);
  }
  nativeTheme.themeSource = 'light';

  console.log('Ctrl and the wheel zoom anywhere in the window');
  {
    const win = await openAndWait(fresh(), twelve);
    await sleep(900);
    const height = await js(win, 'innerHeight');
    const percent = async () => Number.parseInt(await js(win, `document.querySelector('.zoom').textContent`), 10);
    const wheel = async (x, y, ticks) => {
      win.webContents.focus();
      for (let i = 0; i < Math.abs(ticks); i++) win.webContents.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: 0, deltaY: ticks > 0 ? 100 : -100, wheelTicksY: ticks > 0 ? 1 : -1, modifiers: ['control'] });
      await sleep(500);
    };
    for (const [name, x, y] of [['the page', 600, 300], ['the dock', 600, height - 40], ['the title row', 600, 20]]) {
      await press(win, '1', ['control']);
      await wheel(x, y, 1);
      const one = await percent();
      await press(win, '1', ['control']);
      await wheel(x, y, 3);
      const three = await percent();
      await wheel(x, y, -3);
      const back = await percent();
      check(`over ${name}: Ctrl and the wheel zoom in, and three quick turns go further than one`, one > 100 && three > one, `${one} ${three}`);
      check(`over ${name}: and the wheel the other way zooms out`, back < three, `${three} -> ${back}`);
    }
    await wheel(600, 300, -3);
    const small = await percent();
    check('the page is not scrolled by it and the browser does not zoom either', (await js(win, `document.getElementById('scroller').scrollTop`)) < 50 && win.webContents.getZoomFactor() === 1 && small > 0, String(small));
    await closeAndWait(win);
  }

  console.log('the dock can stand at the bottom, top, left or right, and stays there');
  {
    settings = { pdfView: { window: null } };
    calls.length = 0;
    const workspace = fresh();
    const win = await openAndWait(workspace, twelve);
    await sleep(900);
    const where = () => js(win, `(() => { const dock = document.querySelector('.dock'); const w = document.querySelector('.well').getBoundingClientRect(); const d = dock.getBoundingClientRect();
      return { side: document.querySelector('.well').dataset.dock, left: d.left - w.left, right: w.right - d.right, top: d.top - w.top, bottom: w.bottom - d.bottom, cx: (d.left + d.right) / 2 - (w.left + w.right) / 2, cy: (d.top + d.bottom) / 2 - (w.top + w.bottom) / 2,
        column: getComputedStyle(dock).flexDirection === 'column', dragging: document.querySelector('.dockwrap').classList.contains('dragging'), on: [...document.querySelectorAll('.snap.on')].map((n) => n.className.replace('snap ', '').replace(' on', '')), ghosts: document.querySelectorAll('.snap').length,
        opacity: getComputedStyle(dock).opacity, inside: d.left >= w.left && d.right <= w.right && d.top >= w.top && d.bottom <= w.bottom }; })()`);
    const grip = () => js(win, `(() => { const r = document.querySelector('.grip').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    const mouse = (type, x, y) => win.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1, modifiers: type === 'mouseUp' ? [] : ['leftButtonDown'] });
    const box = await js(win, `(() => { const r = document.querySelector('.well').getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; })()`);
    const dragTo = async (x, y, hold = false) => {
      win.webContents.focus();
      const g = await grip();
      mouse('mouseDown', g.x, g.y);
      for (let i = 1; i <= 8; i++) { mouse('mouseMove', g.x + ((x - g.x) * i) / 8, g.y + ((y - g.y) * i) / 8); await sleep(30); }
      await sleep(200);
      if (hold) return;
      mouse('mouseUp', x, y);
      await sleep(800);
    };
    const edges = { left: [box.l + 24, box.t + box.h / 2], right: [box.l + box.w - 24, box.t + box.h / 2], top: [box.l + box.w / 2, box.t + 24], bottom: [box.l + box.w / 2, box.t + box.h - 24] };

    const pager = () => js(win, `(() => { const d = document.querySelector('.dock'); const [prev, next] = [...d.querySelectorAll('.step')]; const no = document.querySelector('.pageno'); const count = document.querySelector('.pagecount');
      const turned = (b) => { const m = new DOMMatrixReadOnly(getComputedStyle(b.querySelector('.i')).transform); return Math.round(Math.atan2(m.b, m.a) * 180 / Math.PI); };
      const cs = getComputedStyle(no); const inset = parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth);
      const mid = (r) => (r.left + r.right) / 2; const dr = d.getBoundingClientRect(); const n = no.getBoundingClientRect(); const c = count.getBoundingClientRect(); const p = prev.getBoundingClientRect(); const x = next.getBoundingClientRect();
      return { prev: turned(prev), next: turned(next), before: n.left + inset - p.right, after: x.left - c.right, noX: mid(n) - mid(dr), countX: mid(c) - mid(dr), slash: getComputedStyle(count.querySelector('.of')).display, text: count.textContent,
        stacked: p.bottom <= n.top && n.bottom <= c.top + 1 && c.bottom <= x.top }; })()`);

    let v = await where();
    let pg = await pager();
    check('in a row the arrows point left and right and the page number sits in the middle between them', pg.prev === 0 && pg.next === 0 && Math.abs(pg.before - pg.after) < 1.5 && pg.slash !== 'none' && pg.text === '/ 12', JSON.stringify(pg));
    const ink = async (selector) => {
      const r = await js(win, `(() => { const b = document.querySelector('${selector}').getBoundingClientRect(); return [b.left + 3, b.top, b.right - 3, b.bottom]; })()`);
      const img = await win.webContents.capturePage();
      const k = img.getSize().width / win.getContentSize()[0];
      const bm = img.toBitmap();
      const px = (x, y) => { const o = (y * img.getSize().width + x) * 4; return (bm[o] + bm[o + 1] + bm[o + 2]) / 3; };
      const bg = px(Math.floor(r[0] * k), Math.floor(r[1] * k) + 1);
      let top = Infinity; let bottom = -1;
      for (let y = Math.floor(r[1] * k); y < Math.ceil(r[3] * k); y++) for (let x = Math.floor(r[0] * k); x < Math.ceil(r[2] * k); x++) if (Math.abs(px(x, y) - bg) > 70) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
      return { top: top / k, bottom: bottom / k };
    };
    const [digit, total] = [await ink('.pageno'), await ink('.pagecount')];
    check('the page number and the total stand on the same line', Math.abs(digit.top - total.top) <= 1 && Math.abs(digit.bottom - total.bottom) <= 1, JSON.stringify([digit, total]));
    check('the dock starts at the bottom middle, 16 px up, in a row', v.side === 'bottom' && Math.abs(v.cx) < 2 && Math.abs(v.bottom - 16) < 2 && !v.column, JSON.stringify(v));
    check('a grip leads the dock, ahead of the page buttons, with a tooltip', (await js(win, `(() => { const g = document.querySelector('.dock').firstElementChild; return g.className === 'grip' && g.title === 'Drag to move' && g.getAttribute('aria-label') === 'Drag to move'; })()`)));
    await dragTo(...edges.left, true);
    v = await where();
    check('while it is dragged the dock follows the pointer and four places are marked, the nearest in the accent', v.dragging && v.ghosts === 4 && v.on.join() === 'left' && v.left < 120, JSON.stringify(v));
    await shot(win, 'workspace-dock-dragging.png');
    mouse('mouseUp', ...edges.left);
    await sleep(800);
    v = await where();
    check('dropped near the left edge it stands at the left middle, as a column', v.side === 'left' && v.column && Math.abs(v.left - 16) < 2 && Math.abs(v.cy) < 2 && v.ghosts === 0 && !v.dragging && v.opacity === '1' && v.inside, JSON.stringify(v));
    check('and the main process was told once, with the side', JSON.stringify(calls.filter((c) => c.channel === 'pdfws:dock').map((c) => c.args)) === '[["left"]]' && settings.pdfView.dock === 'left');
    pg = await pager();
    check('in a column the arrows point up and down, and the page and the total are stacked in the middle without the slash', pg.prev === 90 && pg.next === 90 && pg.slash === 'none' && pg.text === '/ 12' && pg.stacked && Math.abs(pg.noX) < 1.5 && Math.abs(pg.countX) < 1.5, JSON.stringify(pg));
    await shot(win, 'workspace-dock-left.png');

    const menuBeside = async (side) => {
      await js(win, `document.querySelector('.dock .zoom').click()`);
      await sleep(500);
      const m = await js(win, `(() => { const r = document.querySelector('.menu').getBoundingClientRect(); const d = document.querySelector('.dock').getBoundingClientRect(); const w = document.querySelector('.well').getBoundingClientRect();
        return { menu: { l: r.left, r: r.right, t: r.top, b: r.bottom }, dock: { l: d.left, r: d.right, t: d.top, b: d.bottom }, well: { l: w.left, r: w.right, t: w.top, b: w.bottom } }; })()`);
      if (side === 'left') return m.menu.l >= m.dock.r + 8 && m.menu.r <= m.well.r && m.menu.t >= m.well.t && m.menu.b <= m.well.b;
      if (side === 'right') return m.menu.r <= m.dock.l - 8 && m.menu.l >= m.well.l && m.menu.t >= m.well.t && m.menu.b <= m.well.b;
      if (side === 'top') return m.menu.t >= m.dock.b + 8 && m.menu.b <= m.well.b && m.menu.l >= m.well.l && m.menu.r <= m.well.r;
      return m.menu.b <= m.dock.t - 8 && m.menu.t >= m.well.t && m.menu.l >= m.well.l && m.menu.r <= m.well.r;
    };
    const closeMenu = () => press(win, 'Escape');
    check('at the left the View menu opens beside the dock, inside the window', await menuBeside('left'));
    await shot(win, 'workspace-dock-left-menu.png');
    await closeMenu();

    await dragTo(...edges.right);
    v = await where();
    check('dragged to the right edge it stands at the right middle', v.side === 'right' && v.column && Math.abs(v.right - 16) < 2 && Math.abs(v.cy) < 2 && v.inside, JSON.stringify(v));
    check('at the right the View menu opens to the dock\'s left', await menuBeside('right'));
    await closeMenu();
    await shot(win, 'workspace-dock-right.png');

    await dragTo(...edges.top);
    v = await where();
    check('dragged to the top edge it stands at the top middle, as a row', v.side === 'top' && !v.column && Math.abs(v.top - 16) < 2 && Math.abs(v.cx) < 2 && v.inside, JSON.stringify(v));
    check('at the top the View menu opens below the dock', await menuBeside('top'));
    await closeMenu();
    await shot(win, 'workspace-dock-top.png');

    await dragTo(...edges.bottom);
    v = await where();
    check('dragged back to the bottom edge it stands at the bottom middle again', v.side === 'bottom' && !v.column && Math.abs(v.bottom - 16) < 2 && Math.abs(v.cx) < 2, JSON.stringify(v));
    await js(win, `workspaceViewer.viewer.currentPageNumber = 10`);
    await sleep(500);
    pg = await pager();
    check('and with two digits the page number is still in the middle between the arrows', await js(win, `document.querySelector('.pageno').value`) === '10' && pg.prev === 0 && Math.abs(pg.before - pg.after) < 1.5, JSON.stringify(pg));
    await js(win, `workspaceViewer.viewer.currentPageNumber = 1`);
    check('at the bottom the View menu opens above it', await menuBeside('bottom'));
    await closeMenu();

    const stored = calls.filter((c) => c.channel === 'pdfws:dock').length;
    const g = await grip();
    win.webContents.focus();
    mouse('mouseDown', g.x, g.y);
    mouse('mouseUp', g.x, g.y);
    await sleep(700);
    v = await where();
    check('a click on the grip without a drag changes nothing and sends nothing', v.side === 'bottom' && !v.dragging && v.ghosts === 0 && calls.filter((c) => c.channel === 'pdfws:dock').length === stored, JSON.stringify(v));

    await js(win, `document.querySelector('.grip').focus()`);
    await press(win, 'Left');
    await sleep(500);
    check('with the grip focused the arrow keys move the dock: Left', (await where()).side === 'left');
    await press(win, 'Up');
    await sleep(400);
    check('Up', (await where()).side === 'top');
    await press(win, 'Right');
    await sleep(400);
    check('Right', (await where()).side === 'right');
    await press(win, 'Down');
    await sleep(400);
    check('and Down brings it back to the bottom, without turning a page', (await where()).side === 'bottom' && (await js(win, 'workspaceViewer.viewer.currentPageNumber')) === 1);

    const before = settings.pdfView.dock;
    for (const bad of ['elsewhere', 5, null, {}, 'LEFT', ['left']]) await js(win, `workspaceApi.setDock(${JSON.stringify(bad)})`);
    check('the page cannot store a place that is not one of the four', settings.pdfView.dock === before, `${before} -> ${settings.pdfView.dock}`);

    await dragTo(...edges.left);
    check('the window kept its own stored place beside the dock\'s', settings.pdfView.dock === 'left' && !!settings.pdfView.window && settings.pdfView.window.width > 0, JSON.stringify(settings.pdfView));

    console.log('reading with the dock at the side');
    win.webContents.sendInputEvent({ type: 'mouseMove', x: box.l + box.w / 2, y: box.t + 200 });
    await js(win, `document.getElementById('scroller').focus()`);
    await js(win, `document.getElementById('scroller').scrollTop = 0`);
    await sleep(400);
    await js(win, `document.getElementById('scroller').scrollTop = 400`);
    await sleep(600);
    v = await where();
    check('scrolling down leaves a dock at the left where it is', v.opacity === '1' && Math.abs(v.left - 16) < 2, JSON.stringify(v));
    const column = () => js(win, `(() => { const d = document.querySelector('.dockwrap').getBoundingClientRect(); const b = document.querySelector('.dock').getBoundingClientRect(); const f = document.querySelector('.fold').getBoundingClientRect(); return { fx: (f.left + f.right) / 2 - (d.left + d.right) / 2, fy: (f.top + f.bottom) / 2 - (d.top + d.bottom) / 2, below: f.top - d.bottom, folded: document.querySelector('.dock').classList.contains('folded'), away: b.right <= document.querySelector('.well').getBoundingClientRect().left }; })()`);
    let col = await column();
    check('its round button is centred just below the column', Math.abs(col.fx) < 2 && col.below > 6 && col.below < 14, JSON.stringify(col));
    await js(win, `document.querySelector('.fold').click()`);
    await sleep(700);
    col = await column();
    check('folded, the column has slid off the left edge and the button is in the middle of its place', col.folded && col.away && Math.abs(col.fx) < 2 && Math.abs(col.fy) < 2, JSON.stringify(col));
    await js(win, `document.querySelector('.fold').click()`);
    await sleep(700);
    check('and it comes back', !(await column()).folded);
    await js(win, `document.getElementById('scroller').scrollTop = 100`);
    await sleep(600);
    win.setBounds({ ...win.getBounds(), width: 900, height: 600 });
    await sleep(900);
    check('at the smallest window a column dock is inside the document area', (await where()).inside);
    win.setBounds({ ...win.getBounds(), width: size.width, height: size.height });
    await sleep(600);
    await closeAndWait(win);

    const again = await openAndWait(fresh(), twelve);
    await sleep(900);
    check('the next window opens with the dock where it was left', (await js(again, `document.querySelector('.well').dataset.dock`)) === 'left');
    await closeAndWait(again);
    settings = { pdfView: { window: null, dock: 'diagonal' } };
    const odd = await openAndWait(fresh(), twelve);
    check('a stored place that is not one of the four is ignored: the dock is at the bottom', (await js(odd, `document.querySelector('.well').dataset.dock`)) === 'bottom');
    await closeAndWait(odd);
    settings = { pdfView: { window: null, dock: 'top' } };
    const top = await openAndWait(fresh(), twelve);
    await sleep(900);
    await js(top, `document.getElementById('focus').click()`);
    await until('full screen', () => top.isFullScreen());
    await sleep(1000);
    const dockVisible = () => js(top, DOCK_IN_VIEW);
    check('in focus reading a dock at the top is hidden until the pointer is near the top', (await dockVisible()) === 0);
    await js(top, `document.getElementById('scroller').dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 600, clientY: 90 }))`);
    await sleep(600);
    const topFocus = await js(top, `(() => { const d = document.querySelector('.dock').getBoundingClientRect(); const t = document.querySelector('.titlerow').getBoundingClientRect(); return { dock: Number(${DOCK_IN_VIEW}), clear: d.top >= t.bottom }; })()`);
    check('and then shows, below the title row', topFocus.dock === 1, JSON.stringify(topFocus));
    await shot(top, 'workspace-focus-dock-top.png');
    await press(top, 'Escape');
    await until('windowed', () => !top.isFullScreen());
    await closeAndWait(top);
    settings = { pdfView: { window: null } };
  }

  console.log('focus reading');
  {
    settings = { pdfView: { window: null } };
    const workspace = fresh();
    const win = await openAndWait(workspace, twelve);
    await sleep(900);
    const placed = JSON.stringify(settings.pdfView.window);
    await js(win, `workspaceViewer.viewer.currentScaleValue = '1.5'`);
    const look = () => js(win, `(() => { const t = document.querySelector('.titlerow').getBoundingClientRect(); const dock = getComputedStyle(document.querySelector('.dock'));
      const b = document.getElementById('focus'); return { full: document.body.classList.contains('focus'), title: b.title, label: b.getAttribute('aria-label'), pressed: b.getAttribute('aria-pressed'),
        titleBottom: t.bottom, dock: ${DOCK_IN_VIEW}, dockClick: dock.pointerEvents, hint: Number(getComputedStyle(document.querySelector('.edgehint')).opacity), scale: workspaceViewer.viewer.currentScaleValue,
        page: workspaceViewer.viewer.currentPageNumber, pill: document.querySelector('.flash').classList.contains('show'), pillText: document.querySelector('.flash').textContent }; })()`);
    let v = await look();
    check('the title row has a Focus reading button with its shortcut', v.title === 'Focus reading (F11)' && v.label === 'Focus reading' && v.pressed === 'false' && !v.full && v.titleBottom > 40, JSON.stringify(v));
    await js(win, `document.getElementById('focus').click()`);
    check('the button puts the window full screen', await until('full screen', () => win.isFullScreen()));
    await sleep(900);
    v = await look();
    check('in focus reading the title row and the dock are out of sight, a handle hints at the dock, and the zoom is Fit page', v.full && v.titleBottom <= 0 && v.dock === 0 && v.dockClick === 'none' && v.hint > 0.4 && v.scale === 'page-fit', JSON.stringify(v));
    check('the button now leaves focus reading', v.title === 'Leave focus reading (Esc)' && v.label === 'Leave focus reading' && v.pressed === 'true', JSON.stringify(v));
    await shot(win, 'workspace-focus.png');
    const at = (x, y) => js(win, `document.getElementById('scroller').dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: ${x}, clientY: ${y} }))`);
    await at(300, 20);
    await sleep(500);
    check('the pointer at the top edge brings the title row back', (await look()).titleBottom >= 40);
    await shot(win, 'workspace-focus-title.png');
    await at(300, 400);
    await sleep(500);
    check('and it goes away with the pointer', (await look()).titleBottom <= 0);
    await at(300, await js(win, 'innerHeight - 40'));
    await sleep(600);
    v = await look();
    check('the pointer near the bottom edge brings the dock back', v.dock === 1 && v.dockClick !== 'none' && v.hint === 0, JSON.stringify(v));
    await shot(win, 'workspace-focus-dock.png');
    await at(300, 300);
    await sleep(500);
    check('and it goes away with the pointer', (await look()).dock === 0);
    await js(win, `document.querySelector('.dock .sm').focus()`);
    await sleep(500);
    check('Tab brings the dock back and keeps it while the focus is inside it', (await look()).dock === 1);
    await js(win, `document.getElementById('scroller').focus()`);
    await sleep(500);

    console.log('focus reading keeps the bar and its button in step, open or folded');
    const spacing = () => js(win, `(() => { const d = document.querySelector('.dockwrap').getBoundingClientRect(); const b = document.querySelector('.dock').getBoundingClientRect(); const f = document.querySelector('.fold').getBoundingClientRect(); const full = document.body.classList.contains('focus');
      const w = full ? { l: 0, r: innerWidth, b: innerHeight } : (() => { const r = document.querySelector('.well').getBoundingClientRect(); return { l: r.left, r: r.right, b: r.bottom }; })();
      return { gap: f.left - d.right, fx: (f.left + f.right) / 2 - (d.left + d.right) / 2, fy: (f.top + f.bottom) / 2 - (d.top + d.bottom) / 2, cx: (d.left + d.right) / 2 - (w.l + w.r) / 2, bottom: w.b - d.bottom, seen: ${DOCK_IN_VIEW},
        away: b.top >= w.b, button: getComputedStyle(document.querySelector('.fold')).pointerEvents }; })()`);
    await at(300, await js(win, 'innerHeight - 40'));
    await sleep(900);
    let sp = await spacing();
    check('in focus reading the open bar is centred 16 px above the bottom edge with its button 10 px beside it', Math.abs(sp.cx) < 2 && Math.abs(sp.bottom - 16) < 2 && Math.abs(sp.gap - 10) < 2 && Math.abs(sp.fy) < 2 && sp.button !== 'none', JSON.stringify(sp));
    await js(win, `document.querySelector('.fold').click()`);
    await sleep(1000);
    sp = await spacing();
    check('folded, the bar is off the edge and the button is in the middle of its place', sp.away && Math.abs(sp.fx) < 2 && Math.abs(sp.fy) < 2 && Math.abs(sp.cx) < 2 && sp.button !== 'none', JSON.stringify(sp));
    await shot(win, 'workspace-focus-folded.png');
    await at(300, 300);
    await sleep(900);
    sp = await spacing();
    check('moving the pointer away takes the folded button off the screen with it', sp.button === 'none' && (await js(win, `(() => { const r = document.querySelector('.fold').getBoundingClientRect(); return r.top >= innerHeight; })()`)), JSON.stringify(sp));
    await at(300, await js(win, 'innerHeight - 40'));
    await sleep(900);
    sp = await spacing();
    check('and the edge brings it back in the same place', sp.away && Math.abs(sp.fx) < 2 && Math.abs(sp.fy) < 2 && Math.abs(sp.cx) < 2 && sp.button !== 'none', JSON.stringify(sp));
    await js(win, `document.getElementById('focus').click()`);
    check('leaving focus reading with the bar folded', await until('windowed', () => !win.isFullScreen()));
    await sleep(1200);
    sp = await spacing();
    check('keeps the button in the middle of the bar\'s place, inside the document area', sp.away && Math.abs(sp.fx) < 2 && Math.abs(sp.fy) < 2 && Math.abs(sp.cx) < 2 && Math.abs(sp.bottom - 16) < 2, JSON.stringify(sp));
    await js(win, `document.querySelector('.fold').click()`);
    await sleep(1000);
    sp = await spacing();
    check('and unfolded, the bar and the button are as they were before focus reading', !sp.away && Math.abs(sp.cx) < 2 && Math.abs(sp.bottom - 16) < 2 && Math.abs(sp.gap - 10) < 2 && Math.abs(sp.fy) < 2, JSON.stringify(sp));
    await js(win, `document.getElementById('focus').click()`);
    check('focus reading again', await until('full screen', () => win.isFullScreen()));
    await sleep(1000);
    await js(win, `document.getElementById('scroller').focus()`);

    const page = (await look()).page;
    await press(win, 'PageDown');
    v = await look();
    check('Page Down turns to the next page and a small pill says which', v.page === page + 1 && v.pill && v.pillText === `${page + 1} / 12`, JSON.stringify(v));
    await press(win, 'Right');
    check('the right arrow turns to the next page too', (await look()).page === page + 2);
    await press(win, 'PageUp');
    await press(win, 'Left');
    check('Page Up and the left arrow turn back', (await look()).page === page);
    await sleep(1000);
    check('the pill goes after a moment', !(await look()).pill);

    await press(win, 'F11');
    check('F11 leaves focus reading', await until('windowed', () => !win.isFullScreen()));
    await sleep(900);
    v = await look();
    check('and the zoom the user had comes back', !v.full && v.scale === '1.5' && v.title === 'Focus reading (F11)' && v.titleBottom > 40, JSON.stringify(v));
    const place = (w) => JSON.stringify({ ...w, savedAt: 0 });
    check('entering and leaving full screen did not change the saved place', place(settings.pdfView.window) === place(JSON.parse(placed)), `${placed} vs ${JSON.stringify(settings.pdfView.window)}`);
    await press(win, 'F11');
    check('F11 enters it', await until('full screen', () => win.isFullScreen()));
    await sleep(900);
    await press(win, 'Escape');
    check('Esc leaves it', await until('windowed', () => !win.isFullScreen()));
    await sleep(600);
    await press(win, 'Escape');
    check('Esc in the window does nothing else', !win.isFullScreen() && !(await look()).full);
    await closeAndWait(win);

    const commented = await openAndWait(fresh(), await makeCommentsPdf('CommentsFocus.pdf'));
    await sleep(800);
    await js(commented, `document.getElementById('focus').click()`);
    await until('full screen', () => commented.isFullScreen());
    await sleep(1500);
    await js(commented, `document.querySelectorAll('.page[data-page-number="1"] .cmark')[2].click()`);
    await sleep(400);
    check('a comment opens in focus reading', (await js(commented, `document.querySelectorAll('.ccard').length`)) === 1);
    await press(commented, 'Escape');
    check('Esc closes an open comment first and stays in focus reading', commented.isFullScreen() && (await js(commented, `document.querySelectorAll('.ccard').length`)) === 0);
    await press(commented, 'Escape');
    check('the next Esc leaves focus reading', await until('windowed', () => !commented.isFullScreen()));
    await closeAndWait(commented);
  }

  console.log('the pages panel');
  for (const theme of ['light', 'dark']) {
    nativeTheme.themeSource = theme;
    const win = await openAndWait(fresh(), twelve);
    await sleep(800);
    let v = await panelState(win);
    check(`${theme}: the title row has a Pages button, and the panel is shut with nothing built or drawn`, v.title === 'Pages and outline' && v.label === 'Pages and outline' && v.pressed === 'false' && !v.disabled && v.width === 0 && v.hidden && v.items === 0 && v.canvases === 0 && v.kept === 0, JSON.stringify(v));
    const closedWidth = v.wellWidth;
    await clickPagesButton(win);
    v = await panelState(win);
    check(`${theme}: it slides a 214 px panel in beside the pages, and the document area gives up that room`, v.width === 214 && v.pressed === 'true' && !v.hidden && Math.abs(closedWidth - v.wellWidth - 206) <= 1, JSON.stringify(v));
    check(`${theme}: every page has an entry, named by its number, and the page in view is the one outlined`, v.items === 12 && v.labels === 'Page 1,Page 2,Page 3' && v.on === '1', JSON.stringify(v));
    await until('thumbnails', async () => (await panelState(win)).canvases >= 3);
    const thumb = await js(win, `(() => { const c = document.querySelector('.thumb[data-n="1"] canvas'); const r = document.querySelector('.thumb[data-n="1"] .sheet').getBoundingClientRect(); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let pink = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] < 150 && d[i + 2] < 180) pink++; return { w: c.width, h: c.height, cssW: r.width, cssH: r.height, pink, canvases: document.querySelectorAll('.thumb canvas').length, dpr: devicePixelRatio }; })()`);
    check(`${theme}: the visible pages are drawn as thumbnails 120 px wide in the page's proportions, not all twelve at once`, thumb.pink > 20 && Math.abs(thumb.cssW - 120) < 1 && Math.abs(thumb.cssH / thumb.cssW - 842 / 595) < 0.02 && Math.abs(thumb.h / thumb.w - 842 / 595) < 0.02 && thumb.w === Math.ceil(120 * Math.min(thumb.dpr, 2)) && thumb.canvases < 12, JSON.stringify(thumb));
    await shot(win, `workspace-pages-panel-${theme}.png`);
    await js(win, `document.querySelector('.thumb[data-n="7"]').scrollIntoView({ block: 'center' })`);
    await sleep(500);
    await js(win, `document.querySelector('.thumb[data-n="7"]').click()`);
    await sleep(500);
    v = await panelState(win);
    check(`${theme}: a click on a thumbnail goes to that page, outlines it and returns the keys to the document`, v.current === 7 && v.page === '7' && v.on === '7' && (await js(win, `document.activeElement.id`)) === 'scroller', JSON.stringify(v));
    await js(win, `workspaceViewer.viewer.currentPageNumber = 11`);
    await sleep(500);
    v = await js(win, `(() => { const l = document.getElementById('thumbs').getBoundingClientRect(); const t = document.querySelector('.thumb[data-n="11"]').getBoundingClientRect(); return { on: document.querySelector('.thumb.on').dataset.n, inside: t.top >= l.top && t.bottom <= l.bottom, list: [l.top, l.bottom], thumb: [t.top, t.bottom] }; })()`);
    check(`${theme}: when the document moves to another page the outline follows and the panel scrolls to keep it in view`, v.on === '11' && v.inside, JSON.stringify(v));
    await clickPagesButton(win);
    v = await panelState(win);
    check(`${theme}: the button shuts it again: the room comes back, the drawn thumbnails are let go and the bitmaps are kept`, v.width === 0 && v.hidden && v.pressed === 'false' && v.canvases === 0 && v.kept >= 3 && Math.abs(v.wellWidth - closedWidth) <= 1, JSON.stringify(v));
    await clickPagesButton(win);
    await sleep(200);
    v = await panelState(win);
    check(`${theme}: opened again it shows the page in view at once, from the bitmaps it kept`, v.width === 214 && v.canvases >= 3 && v.on === '11', JSON.stringify(v));
    await closeAndWait(win);
  }
  nativeTheme.themeSource = 'light';
  {
    const win = await openAndWait(fresh(), twelve);
    await sleep(800);
    await clickPagesButton(win);
    await js(win, `document.getElementById('focus').click()`);
    check('focus reading with the panel open', await until('full screen', () => win.isFullScreen()));
    await sleep(900);
    const tint = (id) => js(win, `getComputedStyle(document.getElementById('${id}')).backgroundColor`);
    const at = (x, y) => js(win, `document.getElementById('scroller').dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: ${x}, clientY: ${y} }))`);
    const full = await js(win, `innerWidth`);
    let v = await panelState(win);
    check('in focus reading the open panel floats over the left edge, the pages keep the whole width, and its thumbnails are drawn', v.width === 214 && v.wellLeft === 0 && v.wellWidth === full && v.canvases >= 3 && (await js(win, `getComputedStyle(document.getElementById('rail')).position`)) === 'absolute', JSON.stringify(v));
    check('the Focus reading button is not tinted as selected, while the Pages button, which is on, is', (await tint('focus')) === 'rgba(0, 0, 0, 0)' && (await tint('pagesbtn')) !== 'rgba(0, 0, 0, 0)', `${await tint('focus')} ${await tint('pagesbtn')}`);
    await shot(win, 'workspace-focus-pages.png');
    await js(win, `document.querySelector('.thumb[data-n="3"]').click()`);
    await sleep(500);
    v = await panelState(win);
    check('a click on a thumbnail in focus reading goes to that page and the panel stays', v.current === 3 && v.on === '3' && v.width === 214, JSON.stringify(v));
    await at(300, 20);
    await sleep(500);
    await js(win, `document.getElementById('pagesbtn').click()`);
    await sleep(900);
    v = await panelState(win);
    check('the Pages button, brought back by the top edge, shuts the panel in focus reading', v.width === 0 && v.pressed === 'false' && v.canvases === 0, JSON.stringify(v));
    await js(win, `document.getElementById('pagesbtn').click()`);
    await sleep(900);
    v = await panelState(win);
    check('and opens it again', v.width === 214 && v.pressed === 'true' && v.canvases >= 3, JSON.stringify(v));
    await js(win, `document.getElementById('focus').click()`);
    check('leaving focus reading', await until('windowed', () => !win.isFullScreen()));
    await sleep(900);
    v = await panelState(win);
    check('puts the panel back beside the pages as it was, with its thumbnails', v.width === 214 && v.wellLeft === 214 && v.canvases >= 3 && v.pressed === 'true', JSON.stringify(v));
    check('and no title-row button is tinted but the Pages button', (await tint('focus')) === 'rgba(0, 0, 0, 0)');
    win.setSize(900, 600);
    await sleep(900);
    v = await js(win, `(() => { const w = document.querySelector('.well').getBoundingClientRect(); const s = document.getElementById('scroller'); return { wellWidth: w.width, sheet: document.querySelector('.page').getBoundingClientRect().width, scroller: s.clientWidth }; })()`);
    check('in a window of the smallest size the pages still fit beside the panel', v.wellWidth > 600 && v.sheet <= v.scroller, JSON.stringify(v));
    await closeAndWait(win);
  }

  console.log('the outline');
  {
    const win = await openAndWait(fresh(), await makeOutlinePdf('Outline.pdf'));
    await sleep(800);
    await clickPagesButton(win);
    let v = await outlineState(win);
    check('the panel opens on its Pages tab, and no bookmark is read until the Outline tab is shown', v.checked === 'Pages=true,Outline=false' && !v.thumbsHidden && v.outlineHidden && v.trees === 0 && v.canvases >= 3, JSON.stringify(v));
    await js(win, `document.getElementById('taboutline').click()`);
    await sleep(500);
    v = await outlineState(win);
    check('the Outline tab shows the bookmarks, the closed one without its children, and puts the thumbnails away', v.checked === 'Pages=false,Outline=true' && v.thumbsHidden && !v.outlineHidden && v.rows === 'Chapter 1|Section 1.1|Section 1.2|Chapter 2|<b>Bold?</b> & more|Appendix', JSON.stringify(v));
    check('a bookmark with children is open, unless the file says it is closed', v.folds === JSON.stringify({ 'Chapter 1': 'true', 'Chapter 2': 'false' }), v.folds);
    check('a title that looks like markup is text, not an element', v.markup === 0, JSON.stringify(v));
    await shot(win, 'workspace-outline-light.png');
    nativeTheme.themeSource = 'dark';
    await sleep(500);
    await shot(win, 'workspace-outline-dark.png');
    nativeTheme.themeSource = 'light';
    await clickRow(win, 'Chapter 2', '.otog');
    await sleep(300);
    v = await outlineState(win);
    check('the chevron opens a closed bookmark and shows its children, and goes nowhere', v.rows.includes('Chapter 2|Hidden child') && v.folds.includes('"Chapter 2":"true"') && v.current === 1, JSON.stringify(v));
    await clickRow(win, 'Chapter 2', '.otog');
    await sleep(300);
    check('and closes it again', !(await outlineState(win)).rows.includes('Hidden child'));
    await clickRow(win, 'Section 1.2');
    await sleep(600);
    v = await outlineState(win);
    check('a click on a bookmark goes to its page and returns the keys to the document', v.current === 3 && v.inScroller, JSON.stringify(v));
    await clickRow(win, 'Chapter 2', '.otog');
    await clickRow(win, 'Hidden child');
    await sleep(600);
    check('a bookmark under an opened one goes to its page', (await outlineState(win)).current === 5);
    await clickRow(win, '<b>Bold?</b> & more');
    await sleep(600);
    check('a title with markup in it goes to its page too', (await outlineState(win)).current === 2);
    await js(win, `workspaceViewer.viewer.currentPageNumber = 4`);
    await sleep(400);
    await clickRow(win, 'Appendix');
    await sleep(400);
    check('a bookmark with no destination is shown and does nothing', (await outlineState(win)).current === 4);
    await js(win, `document.querySelector('#outline .orow').focus()`);
    v = await outlineState(win);
    check('one bookmark is in the Tab order, and the arrow keys move between them', v.tabstops === 1 && v.focused === 'Chapter 1', JSON.stringify(v));
    await press(win, 'Down');
    check('Down moves to the next bookmark', (await outlineState(win)).focused === 'Section 1.1');
    await press(win, 'Left');
    check('Left on a child goes to its parent', (await outlineState(win)).focused === 'Chapter 1');
    await press(win, 'Left');
    v = await outlineState(win);
    check('Left on an open bookmark closes it', v.folds.includes('"Chapter 1":"false"') && !v.rows.includes('Section 1.1') && v.tabstops === 1, JSON.stringify(v));
    await press(win, 'Right');
    check('Right opens it', (await outlineState(win)).rows.startsWith('Chapter 1|Section 1.1'));
    await press(win, 'Right');
    check('and Right again goes to its first child', (await outlineState(win)).focused === 'Section 1.1');
    await press(win, 'Return');
    await sleep(500);
    v = await outlineState(win);
    check('Enter goes to the bookmark page', v.current === 2 && v.inScroller, JSON.stringify(v));
    await js(win, `document.getElementById('tabpages').click()`);
    await sleep(600);
    v = await outlineState(win);
    check('the Pages tab brings the thumbnails back, drawn, and puts the outline away', v.checked === 'Pages=true,Outline=false' && !v.thumbsHidden && v.outlineHidden && v.canvases >= 3, JSON.stringify(v));
    await js(win, `document.getElementById('taboutline').click()`);
    await clickPagesButton(win);
    await clickPagesButton(win);
    v = await outlineState(win);
    check('the tab in use is the one the panel opens on again', v.checked === 'Pages=false,Outline=true' && !v.outlineHidden && v.rows.startsWith('Chapter 1'), JSON.stringify(v));
    await closeAndWait(win);

    const bare = await openAndWait(fresh(), twelve);
    await sleep(800);
    await clickPagesButton(bare);
    await js(bare, `document.getElementById('taboutline').click()`);
    await sleep(500);
    v = await outlineState(bare);
    check('a document with no bookmarks says so', v.empty === 'This document has no bookmarks' && v.trees === 0, JSON.stringify(v));
    await closeAndWait(bare);
  }

  console.log('resizing the panel');
  {
    const win = await openAndWait(fresh(), twelve);
    await sleep(800);
    await clickPagesButton(win);
    await until('thumbnails', async () => (await panelState(win)).canvases >= 3);
    const geo = () => js(win, `(() => { const p = document.getElementById('rail'); const g = document.getElementById('railgrip'); const gr = g.getBoundingClientRect(); const c = document.querySelector('.thumb[data-n="1"] canvas'); const w = document.querySelector('.well').getBoundingClientRect();
      return { panel: p.getBoundingClientRect().width, gripRight: gr.right, cursor: getComputedStyle(g).cursor, now: g.getAttribute('aria-valuenow'), min: g.getAttribute('aria-valuemin'), max: g.getAttribute('aria-valuemax'), dragging: p.classList.contains('dragging'),
        sheet: document.querySelector('.thumb[data-n="1"] .sheet').getBoundingClientRect().width, canvasW: c ? c.width : 0, wellLeft: w.left, wellWidth: w.width, current: workspaceViewer.viewer.currentPageNumber, dpr: devicePixelRatio, page: document.querySelector('.page').getBoundingClientRect().width, scroller: document.getElementById('scroller').clientWidth }; })()`);
    const mouse = (type, x, y) => win.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1, modifiers: type === 'mouseUp' ? [] : ['leftButtonDown'] });
    const grabAt = () => js(win, `(() => { const r = document.getElementById('railgrip').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 300 }; })()`);
    const drag = async (to, release = true) => {
      const g = await grabAt();
      mouse('mouseDown', g.x, g.y);
      for (let i = 1; i <= 8; i++) { mouse('mouseMove', g.x + ((to - g.x) * i) / 8, g.y); await sleep(30); }
      if (!release) return g;
      mouse('mouseUp', to, g.y);
      await sleep(900);
      return g;
    };
    let v = await geo();
    check('the panel has a grip on its right edge with a resize cursor and its range, and starts at the narrowest, 214 px', v.panel === 214 && Math.abs(v.gripRight - 214) < 1 && v.cursor === 'col-resize' && v.min === '214' && v.max === '320' && v.now === '214' && Math.abs(v.sheet - 120) < 0.5, JSON.stringify(v));
    const g = await drag(295, false);
    v = await geo();
    check('while the grip is dragged the panel follows the pointer at once and the sheets with it, the pictures not yet redrawn', v.dragging && Math.abs(v.panel - 300) <= 1 && Math.abs(v.sheet - 206) <= 1 && v.canvasW === Math.ceil(120 * Math.min(v.dpr, 2)), JSON.stringify(v));
    await shot(win, 'workspace-panel-drag.png');
    mouse('mouseUp', 295, g.y);
    await sleep(900);
    v = await geo();
    check('let go, it keeps that width, the document area has the rest, and the thumbnails are drawn again at the new size', !v.dragging && Math.abs(v.panel - 300) <= 1 && Math.abs(v.wellLeft - v.panel) <= 1 && Math.abs(v.sheet - 206) <= 1 && v.canvasW === Math.ceil(206 * Math.min(v.dpr, 2)) && v.now === String(Math.round(v.panel)) && v.current === 1, JSON.stringify(v));
    await drag(900);
    v = await geo();
    check('dragged far to the right it stops at 320 px, with the thumbnails at their largest', v.panel === 320 && v.now === '320' && Math.abs(v.sheet - 226) <= 1, JSON.stringify(v));
    await shot(win, 'workspace-panel-wide.png');
    win.setSize(900, 600);
    await sleep(900);
    v = await geo();
    check('in a window of the smallest size the widest panel still leaves the pages room', v.wellWidth >= 550 && v.page <= v.scroller, JSON.stringify(v));
    win.setSize(1200, 800);
    await sleep(600);
    await drag(5);
    v = await geo();
    check('dragged far to the left it stops at 214 px, the size it had, with the thumbnails at 120 px', v.panel === 214 && v.now === '214' && Math.abs(v.sheet - 120) <= 1 && v.canvasW === Math.ceil(120 * Math.min(v.dpr, 2)), JSON.stringify(v));
    await js(win, `document.getElementById('railgrip').focus()`);
    await press(win, 'Right');
    await sleep(500);
    check('Right on the focused grip widens it by 16 px', (await geo()).panel === 230);
    await press(win, 'Left');
    await press(win, 'Left');
    await sleep(500);
    check('Left narrows it, and never below 214 px', (await geo()).panel === 214);
    await drag(295);
    await clickPagesButton(win);
    check('shut, the panel gives all its room back', (await geo()).panel === 0);
    await clickPagesButton(win);
    v = await geo();
    check('and it opens again at the width it had', Math.abs(v.panel - 300) <= 1 && v.canvasW === Math.ceil(206 * Math.min(v.dpr, 2)), JSON.stringify(v));
    await js(win, `document.querySelector('.thumb[data-n="3"]').click()`);
    await sleep(500);
    check('a click on a thumbnail still goes to its page', (await geo()).current === 3);
    await closeAndWait(win);
  }

  console.log('finding text and copying it');
  {
    const win = await openAndWait(fresh(), await makeSearchPdf('Search.pdf'));
    await sleep(500);
    const bar = () => barState(win);
    const typeText = (text) => typeInto(win, text);
    const count = (what) => countIs(win, what);
    let v = await bar();
    check('the title row has a Find button after the panel button, ready once the pages are known, and the bar is shut', v.titleLeft === 'pagesbtn,findbtn' && v.title === 'Find (Ctrl+F)' && !v.disabled && v.hidden && v.pressed === 'false', JSON.stringify(v));
    await press(win, 'F', ['control']);
    v = await bar();
    check('Ctrl+F opens the bar with the focus in its field, and the button is pressed', !v.hidden && v.focused && v.pressed === 'true' && v.placeholder === 'Find in document', JSON.stringify(v));
    check('the bar names its buttons, Aa for Match case and W for Whole words, neither on', v.opts === 'Match case=false,Whole words=false' && v.tips === 'Show all results,Previous (Shift+Enter),Next (Enter),Close (Esc)', JSON.stringify(v));
    await typeText('delivery');
    check('searching a word counts the hits in the whole document, 1 of 4', await count('1 of 4'), JSON.stringify(await bar()));
    v = await bar();
    check('the hit on the page in view is marked, and it is the current hit', v.hits >= 1 && v.selected === 1 && v.page === 1, JSON.stringify(v));
    await shot(win, 'workspace-search.png');
    await press(win, 'Return');
    await count('2 of 4');
    v = await bar();
    check('Enter goes to the next hit, on another page', v.count === '2 of 4' && v.page === 2 && v.selected === 1, JSON.stringify(v));
    await press(win, 'Return', ['shift']);
    check('Shift+Enter goes back', await count('1 of 4') && (await bar()).page === 1, JSON.stringify(await bar()));
    for (let i = 0; i < 3; i++) await press(win, 'Return');
    await count('4 of 4');
    v = await bar();
    check('stepping on reaches the last hit, two on page 3', v.count === '4 of 4' && v.page === 3, JSON.stringify(v));
    await press(win, 'Return');
    check('and one more starts again from the first', await count('1 of 4') && (await bar()).page === 1, JSON.stringify(await bar()));
    await js(win, `document.querySelector('.findbar .opt[title="Match case"]').click()`);
    check('Match case leaves the two hits whose capitals are the same, and the button is on', await count('1 of 2') && (await bar()).opts === 'Match case=true,Whole words=false', JSON.stringify(await bar()));
    await js(win, `document.querySelector('.findbar .opt[title="Match case"]').click()`);
    await js(win, `document.querySelector('.findbar .opt[title="Whole words"]').click()`);
    check('Whole words leaves the three hits that are words of their own', await count(/ of 3$/) && (await bar()).opts === 'Match case=false,Whole words=true', JSON.stringify(await bar()));
    await js(win, `document.querySelector('.findbar .opt[title="Whole words"]').click()`);
    await js(win, `document.querySelector('.findbar input').select()`);
    await typeText('brown fox');
    check('a phrase that runs over a line break is found, and both lines are marked', await count('1 of 1') && (await bar()).hits >= 2, JSON.stringify(await bar()));
    await js(win, `document.querySelector('.findbar input').select()`);
    await typeText('zzzz');
    check('a word the file does not have says No results', await count('No results'), JSON.stringify(await bar()));
    await js(win, `document.querySelector('.findbar input').select()`);
    await typeText('delivery');
    await count(/ of 4$/);
    await press(win, 'Escape');
    v = await bar();
    check('Esc closes the bar, takes the marks off the page and puts the focus back in the document', v.hidden && v.hits === 0 && v.pressed === 'false' && v.inScroller, JSON.stringify(v));
    await js(win, `document.getElementById('findbtn').click()`);
    v = await bar();
    check('the button opens it again with the last words selected, and finds them again', !v.hidden && v.query === 'delivery' && v.focused && await until('the marks', async () => (await bar()).hits >= 1), JSON.stringify(await bar()));
    await js(win, `document.getElementById('findbtn').click()`);
    check('and closes it', (await bar()).hidden);

    await js(win, `workspaceViewer.viewer.currentPageNumber = 1`);
    await sleep(800);
    const rects = await js(win, `(() => { const spans = [...document.querySelectorAll('.page[data-page-number="1"] .textLayer span')].filter((s) => /Delivery of the goods|will happen/.test(s.textContent)).map((s) => s.getBoundingClientRect());
      return spans.map((r) => ({ l: r.left, r: r.right, y: r.top + r.height / 2 })); })()`);
    const mouse = (type, x, y) => win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, modifiers: type === 'mouseUp' ? [] : ['leftButtonDown'] });
    const saved = await clipboard.readText();
    await clipboard.writeText('');
    mouse('mouseDown', rects[0].l + 1, rects[0].y);
    await sleep(100);
    for (let i = 1; i <= 8; i++) { mouse('mouseMove', rects[0].l + 1 + ((rects[1].r - rects[0].l - 3) * i) / 8, rects[0].y + ((rects[1].y - rects[0].y) * i) / 8); await sleep(30); }
    mouse('mouseUp', rects[1].r - 2, rects[1].y);
    await sleep(300);
    const selected = await js(win, `getSelection().toString()`);
    await press(win, 'C', ['control']);
    const copied = (await clipboard.readText()).replace(/\r\n/g, '\n');
    await clipboard.writeText(saved);
    check('dragging over two lines and Ctrl+C copies them in reading order, one line after the other', /^Delivery of the goods\s*\n+\s*will happen on Monday\.?\s*$/.test(copied), `${JSON.stringify(copied)} selected ${JSON.stringify(selected)} ${JSON.stringify(rects)}`);
    await closeAndWait(win);
  }

  console.log('selecting from empty paper');
  {
    const win = await openAndWait(fresh(), await makeSearchPdf('Search select.pdf'));
    await sleep(500);
    const mouse = (type, x, y) => win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, modifiers: type === 'mouseUp' ? [] : ['leftButtonDown'] });
    const geometry = await js(win, `(() => { const spans = [...document.querySelectorAll('.page[data-page-number="1"] .textLayer span')].filter((s) => /Delivery of the goods|will happen/.test(s.textContent)).map((s) => s.getBoundingClientRect());
      const p = document.querySelector('.page[data-page-number="1"]').getBoundingClientRect(); return { lines: spans.map((r) => ({ l: r.left, r: r.right, y: r.top + r.height / 2 })), page: { l: p.left, r: p.right, b: p.bottom } }; })()`);
    const [one, two] = geometry.lines;
    const drag = async (from, to) => {
      mouse('mouseDown', from[0], from[1]);
      await sleep(100);
      for (let i = 1; i <= 10; i++) { mouse('mouseMove', from[0] + ((to[0] - from[0]) * i) / 10, from[1] + ((to[1] - from[1]) * i) / 10); await sleep(30); }
      mouse('mouseUp', to[0], to[1]);
      await sleep(300);
      return js(win, `getSelection().toString().replace(/\\s+/g, ' ').trim()`);
    };
    let picked = await drag([one.l - 40, one.y], [(two.l + two.r) / 2, two.y]);
    check('a press in the blank before a line and a drag into the next one select from the start of the first line', /^Delivery of the goods will \w+/.test(picked) && !/Monday/.test(picked), JSON.stringify(picked));
    picked = await drag([one.r + 60, one.y], [(two.l + two.r) / 2, two.y]);
    check('a press in the blank after a line selects from the end of that line, so only the next line is picked', /^will \w+/.test(picked) && !/Delivery/.test(picked), JSON.stringify(picked));
    picked = await drag([geometry.page.r - 30, geometry.page.b - 30], [(one.l + one.r) / 2, one.y]);
    check('a press far below the text and a drag up into the first line select the lines between them, to the end of the last', /goods will happen on Monday\.$/.test(picked) && !/^Delivery/.test(picked), JSON.stringify(picked));
    await closeAndWait(win);
  }

  console.log('finding: the hits listed, marked and coloured');
  {
    const win = await openAndWait(fresh(), await makeSearchPdf('Search hits.pdf'));
    await sleep(500);
    const resultsState = () => js(win, `(() => { const rows = [...document.querySelectorAll('#results .hitrow')]; const sel = document.querySelector('.textLayer .highlight.selected'); const hp = document.getElementById('hitpanel'); const head = document.querySelector('.hithead'); const first = document.querySelector('#results .hitrow .pg'); const x = document.getElementById('hitclose').getBoundingClientRect(); const well = document.querySelector('.well').getBoundingClientRect();
      return { panelOpen: hp.classList.contains('open'), panelWidth: hp.getBoundingClientRect().width, panelRight: hp.getBoundingClientRect().right, win: innerWidth, listHidden: document.getElementById('hitinner').hidden, railOpen: document.getElementById('rail').classList.contains('open'), railWidth: document.getElementById('rail').getBoundingClientRect().width,
        pagesPressed: document.getElementById('pagesbtn').getAttribute('aria-pressed'), thumbs: document.querySelectorAll('.thumb').length, tabs: [...document.querySelectorAll('.seg3 button')].map((b) => b.textContent + '=' + b.getAttribute('aria-checked')).join(),
        title: head.querySelector('b').textContent, total: head.querySelector('.total').textContent, headHeight: head.getBoundingClientRect().height, titleLeft: head.querySelector('b').getBoundingClientRect().left, rowLeft: first ? first.getBoundingClientRect().left : -1,
        closeRight: x.right, listRight: document.getElementById('results').getBoundingClientRect().right, closeLabel: document.getElementById('hitclose').title, wellRight: well.right, wellLeft: well.left, rows: rows.length, pages: rows.map((r) => r.querySelector('.pg').textContent).join(), marks: rows.map((r) => r.querySelector('mark') ? r.querySelector('mark').textContent : '').join(),
        snips: rows.map((r) => r.querySelector('.snip').textContent), on: rows.filter((r) => r.classList.contains('on')).map((r) => rows.indexOf(r)).join(), space: parseFloat(document.querySelector('.rowspace').style.height) || 0,
        pressed: document.querySelector('.findbar button[title="Show all results"]').getAttribute('aria-pressed'), selectedText: sel ? sel.textContent : '', selectedPage: sel && sel.closest('.page') ? sel.closest('.page').dataset.pageNumber : '' }; })()`);
    const ticks = () => js(win, `(() => { const c = document.querySelector('.ticks'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; const x = Math.floor(c.width / 2); const bands = []; let cur = null;
      for (let y = 0; y < c.height; y++) { const i = (y * c.width + x) * 4; if (d[i + 3] > 0) { if (!cur) { cur = { from: y, to: y, current: false }; bands.push(cur); } cur.to = y; if (d[i] > 240 && d[i + 1] > 220 && d[i + 1] < 250 && d[i + 2] < 100) cur.current = true; } else cur = null; }
      return { w: c.clientWidth, h: c.clientHeight, bands: bands.map((b) => ({ from: +(b.from / c.height).toFixed(3), to: +(b.to / c.height).toFixed(3), current: b.current })) }; })()`);
    let v = await resultsState();
    check('with no search there is no Results panel, and the Pages panel has only its own two tabs', !v.panelOpen && v.panelWidth === 0 && v.listHidden && v.tabs === 'Pages=true,Outline=false', JSON.stringify(v));
    await press(win, 'F', ['control']);
    await typeInto(win, 'delivery');
    await countIs(win, '1 of 4');
    v = await resultsState();
    check('an open find bar does not open the Results panel by itself', !v.panelOpen && v.panelWidth === 0 && v.pressed === 'false', JSON.stringify(v));
    const colours = await js(win, `(() => { const all = [...document.querySelectorAll('.textLayer .highlight')]; const now = all.find((h) => h.classList.contains('selected')); const other = all.find((h) => !h.classList.contains('selected'));
      return { now: getComputedStyle(now).backgroundColor, other: getComputedStyle(other).backgroundColor, ring: getComputedStyle(now).boxShadow }; })()`);
    check('the hit being viewed is a plain yellow highlight, with no ring, and the other hits stay the pink', colours.now === 'rgba(255, 235, 59, 0.6)' && colours.other === 'rgba(232, 77, 111, 0.26)' && colours.ring === 'none', JSON.stringify(colours));
    let t = { bands: [] };
    await until('the marks', async () => { t = await ticks(); return t.bands.length >= 4; });
    check('a mark for each hit stands beside the scroll bar, the first page near the top and the last near the bottom, and the hit in view is yellow', t.w === 8 && t.bands.length === 4 && t.bands[0].from < 0.2 && t.bands[3].to > 0.7 && t.bands[0].current && !t.bands[3].current, JSON.stringify(t));
    await shot(win, 'workspace-search-marks.png');
    await press(win, 'Return');
    await press(win, 'Return');
    await countIs(win, '3 of 4');
    await sleep(300);
    t = await ticks();
    check('stepping on moves the yellow mark with it', t.bands.findIndex((b) => b.current) === 2 && t.bands.filter((b) => b.current).length === 1, JSON.stringify(t));
    await js(win, `document.querySelector('.findbar button[title="Show all results"]').click()`);
    await sleep(900);
    await until('rows', async () => { const r = await resultsState(); return r.snips.length === 4 && r.snips.every(Boolean); });
    v = await resultsState();
    check('the list button opens a Results panel of its own on the right, 280 px wide, with a row for every hit and its button pressed', v.panelOpen && !v.listHidden && Math.abs(v.panelWidth - 280) <= 1 && Math.abs(v.panelRight - v.win) <= 1 && v.rows === 4 && v.pressed === 'true' && v.title === 'Results' && v.total === '4 results', JSON.stringify(v));
    check('the Pages panel is not opened or built by it: it stays shut with its button off and no thumbnail drawn, and the document area gives up the room on the right only', !v.railOpen && v.railWidth === 0 && v.pagesPressed === 'false' && v.thumbs === 0 && v.wellLeft < 20 && Math.abs(v.wellRight - (v.win - 280)) <= 12, JSON.stringify(v));
    check('the panel is laid out evenly: the heading is 30 px high and its words stand where the rows\' words do, and the close button ends where the list ends', v.headHeight === 30 && Math.abs(v.titleLeft - v.rowLeft) <= 1 && Math.abs(v.closeRight - v.listRight) <= 1 && v.closeLabel === 'Hide results', JSON.stringify(v));
    check('each row names its page and marks the hit in a few words of the text round it', v.pages === 'Page 1,Page 2,Page 3,Page 3' && v.marks === 'Delivery,delivery,Delivery,delivery' && /^Delivery of the goods/.test(v.snips[0]) && /ask for delivery here/.test(v.snips[1]) && v.snips[1].startsWith('…') && v.snips[2] === 'Delivery redelivery', JSON.stringify(v.snips));
    check('the row of the hit in view is the one marked on', v.on === '2', JSON.stringify(v));
    await shot(win, 'workspace-search-results.png');
    await js(win, `document.querySelectorAll('#results .hitrow')[3].click()`);
    await countIs(win, '4 of 4');
    await sleep(800);
    v = await resultsState();
    check('a click on a row goes to that hit: its page, its text marked in yellow and the count', v.selectedPage === '3' && v.selectedText === 'delivery' && v.on === '3' && (await barState(win)).page === 3, JSON.stringify(v));
    await js(win, `document.querySelectorAll('#results .hitrow')[0].click()`);
    await countIs(win, '1 of 4');
    await sleep(800);
    v = await resultsState();
    check('and back on the first, on page 1', v.selectedPage === '1' && v.selectedText === 'Delivery' && v.on === '0', JSON.stringify(v));
    await js(win, `document.querySelector('.findbar input').focus()`);
    await press(win, 'Return');
    check('Enter carries on from the row that was clicked', (await countIs(win, '2 of 4')) && (await resultsState()).on === '1');
    await js(win, `document.querySelector('.findbar button[title="Show all results"]').click()`);
    await sleep(900);
    v = await resultsState();
    check('the list button shuts the panel again', !v.panelOpen && v.panelWidth === 0 && v.pressed === 'false', JSON.stringify(v));
    await js(win, `document.querySelector('.findbar button[title="Show all results"]').click()`);
    await sleep(900);
    await js(win, `document.getElementById('hitclose').click()`);
    await sleep(900);
    v = await resultsState();
    check('the panel\'s own close button shuts it and the list button follows', !v.panelOpen && v.pressed === 'false', JSON.stringify(v));
    await js(win, `document.querySelector('.findbar button[title="Show all results"]').click()`);
    await sleep(900);
    await js(win, `document.querySelector('.findbar input').focus()`);
    await press(win, 'Escape');
    await sleep(900);
    v = await resultsState();
    t = await ticks();
    check('closing the bar shuts the Results panel and takes the rows and the marks away', !v.panelOpen && v.panelWidth === 0 && v.listHidden && v.rows === 0 && v.pressed === 'false' && t.bands.length === 0, JSON.stringify({ v, t }));
    await closeAndWait(win);
  }

  console.log('finding a word that is found hundreds of times');
  {
    const win = await openAndWait(fresh(), await makeManyPdf('Search many.pdf'));
    await sleep(500);
    await press(win, 'F', ['control']);
    await typeInto(win, 'alpha');
    await countIs(win, '1 of 480');
    await js(win, `document.querySelector('.findbar button[title="Show all results"]').click()`);
    await sleep(900);
    const rowsNow = () => js(win, `(() => { const l = document.getElementById('results'); const rows = [...l.querySelectorAll('.hitrow')]; return { rows: rows.length, space: parseFloat(document.querySelector('.rowspace').style.height), top: l.scrollTop, height: l.clientHeight,
      first: rows.length ? rows[0].querySelector('.pg').textContent : '', last: rows.length ? rows[rows.length - 1].querySelector('.pg').textContent : '', empty: rows.filter((r) => !r.querySelector('mark')).length }; })()`);
    let v = await rowsNow();
    check('480 hits are one list as tall as 480 rows, with only the rows in view built', v.space === 480 * 68 && v.rows > 5 && v.rows < 30, JSON.stringify(v));
    await js(win, `document.getElementById('results').scrollTop = 100 * 68`);
    await sleep(600);
    await js(win, `[...document.querySelectorAll('#results .hitrow')].find((r) => r.style.top === '6800px').click()`);
    await countIs(win, '101 of 480');
    await sleep(1000);
    const clear = await js(win, `(() => { const bar = document.querySelector('.findbar').getBoundingClientRect(); const hit = document.querySelector('.textLayer .highlight.selected').getBoundingClientRect(); const s = document.getElementById('scroller').getBoundingClientRect();
      return { barBottom: bar.bottom, hitTop: hit.top, hitBottom: hit.bottom, scrollerBottom: s.bottom }; })()`);
    check('a hit that is stepped to comes to rest well below the find bar and inside the view', clear.hitTop >= clear.barBottom + 40 && clear.hitBottom <= clear.scrollerBottom, JSON.stringify(clear));
    await js(win, `document.getElementById('results').scrollTop = document.getElementById('results').scrollHeight`);
    await sleep(900);
    v = await rowsNow();
    check('at the end of the list the rows are the last ones, from page 2, and still few', v.last === 'Page 2' && v.rows < 30 && v.empty === 0, JSON.stringify(v));
    await js(win, `[...document.querySelectorAll('#results .hitrow')].pop().click()`);
    check('a click on the last row goes to the last hit', await countIs(win, '480 of 480'));
    await sleep(800);
    check('and the page it is on is in view', (await barState(win)).page === 2, JSON.stringify(await barState(win)));
    await closeAndWait(win);
  }

  console.log('finding in focus reading');
  {
    const win = await openAndWait(fresh(), await makeSearchPdf('Search focus.pdf'));
    await sleep(500);
    await press(win, 'F11');
    await until('full screen', () => win.isFullScreen());
    await sleep(500);
    await press(win, 'F', ['control']);
    await sleep(300);
    const v = await js(win, `(() => { const r = document.querySelector('.findbar').getBoundingClientRect(); return { open: !document.querySelector('.findbar').hidden, top: r.top, focused: document.activeElement.tagName }; })()`);
    check('Ctrl+F opens the bar in focus reading, below the place the title row comes to', v.open && v.top >= 50 && v.focused === 'INPUT', JSON.stringify(v));
    const wellBefore = await js(win, `document.querySelector('.well').getBoundingClientRect().width`);
    await js(win, `document.querySelector('.findbar button[title="Show all results"]').click()`);
    await sleep(800);
    const side = await js(win, `(() => { const p = document.getElementById('hitpanel'); const r = p.getBoundingClientRect(); return { position: getComputedStyle(p).position, right: r.right, width: r.width, win: innerWidth, well: document.querySelector('.well').getBoundingClientRect().width }; })()`);
    check('in focus reading the Results panel floats over the right edge and the pages do not move', side.position === 'absolute' && Math.abs(side.right - side.win) <= 1 && Math.abs(side.width - 280) <= 1 && side.well === wellBefore, JSON.stringify(side));
    await press(win, 'Escape');
    check('the first Esc closes the bar and stays in focus reading', win.isFullScreen() && await js(win, `document.querySelector('.findbar').hidden`));
    await press(win, 'Escape');
    check('the next Esc leaves focus reading', await until('windowed', () => !win.isFullScreen()));
    await closeAndWait(win);
  }

  console.log('links in a document');
  for (const theme of ['light', 'dark']) {
    nativeTheme.themeSource = theme;
    opened.length = 0;
    const win = await openAndWait(fresh(), await makeLinksPdf('Links.pdf'));
    await until('the links', () => js(win, `document.querySelectorAll('.page[data-page-number="1"] .linkAnnotation a').length >= 5`));
    const here = await js(win, `location.href`);
    const page = () => js(win, `workspaceViewer.viewer.currentPageNumber`);
    const onPage = (n) => until(`page ${n}`, async () => (await page()) === n, 5000);
    const stayed = async () => (await js(win, `location.href`)) === here && BrowserWindow.getAllWindows().length === 1;
    const list = await js(win, `[...document.querySelectorAll('.page[data-page-number="1"] .linkAnnotation a')].map((a) => ({ href: a.getAttribute('href'), title: a.title, target: a.target }))`);
    const external = list.filter((a) => /^[a-z]+:/i.test(a.title));
    check(`${theme}: every link to an address holds no address, so a middle click or a drag takes the page nowhere`, external.length === 3 && external.every((a) => a.href === '' && a.target === ''), JSON.stringify(list));
    check(`${theme}: pdf.js draws no link for a file, a script, another document or a program`, list.length === 5 && list.map((a) => a.title).join('|') === 'https://example.com/Docs?a=1#top|mailto:team@example.com|ftp://example.com/x|Go to page 3|Next page', JSON.stringify(list));
    const press1 = async (at) => {
      for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: Math.round(at.x), y: Math.round(at.y), button: 'left', clickCount: 1 });
      await sleep(500);
    };
    const click = async (n) => press1(await js(win, `(() => { const r = [...document.querySelectorAll('.page[data-page-number="1"] .linkAnnotation a')][${n}].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`));
    const clickLine = async (row) => press1(await js(win, `(() => { const r = document.querySelector('.page[data-page-number="1"]').getBoundingClientRect(); return { x: r.left + (100 / 595) * r.width, y: r.top + ((842 - (760 - ${row} * 40 + 7)) / 842) * r.height }; })()`));
    const cardState = () => js(win, `(() => { const c = document.querySelector('.card'); return c ? { title: c.querySelector('h3').textContent, address: c.querySelector('.addr').textContent, buttons: [...c.querySelectorAll('button')].map((b) => b.textContent).join(),
      focused: document.activeElement.textContent, role: c.getAttribute('role'), modal: c.getAttribute('aria-modal'), labelled: !!document.getElementById(c.getAttribute('aria-labelledby')) } : null; })()`);
    const choose = async (name) => { await js(win, `[...document.querySelectorAll('.card button')].find((b) => b.textContent === ${JSON.stringify(name)}).click()`); await sleep(300); };
    const mark = calls.length;
    const sent = (channel) => calls.slice(mark).filter((c) => c.channel === channel).map((c) => c.args[0]);

    await click(0);
    let card = await cardState();
    check(`${theme}: a click on a web link asks first, showing the whole address as the parser reads it`, card && card.title === 'Open this link?' && card.address === 'https://example.com/Docs?a=1#top' && card.buttons === 'Cancel,Open'
      && card.role === 'dialog' && card.modal === 'true' && card.labelled, JSON.stringify(card));
    check(`${theme}: nothing is opened while the card is up, and Open has the focus`, opened.length === 0 && card.focused === 'Open', JSON.stringify([opened, card]));
    await shot(win, `workspace-link-${theme}.png`);
    await press(win, 'Tab');
    check(`${theme}: Tab goes round the card's two buttons and stays inside it`, (await cardState()).focused === 'Cancel');
    await press(win, 'Tab');
    check(`${theme}: and back to Open`, (await cardState()).focused === 'Open');
    await press(win, 'Escape');
    const closed = await js(win, `({ card: !!document.querySelector('.card'), inScroller: document.getElementById('scroller').contains(document.activeElement) })`);
    check(`${theme}: Esc closes the card, opens nothing and returns the keys to the document`, !closed.card && closed.inScroller && opened.length === 0, JSON.stringify([closed, opened]));
    await click(0);
    await choose('Cancel');
    check(`${theme}: Cancel closes it and opens nothing`, !(await cardState()) && opened.length === 0);
    await click(0);
    await choose('Open');
    check(`${theme}: Open opens the address the card showed, once, and closes the card`, !(await cardState()) && JSON.stringify(opened) === '["https://example.com/Docs?a=1#top"]', JSON.stringify(opened));
    check(`${theme}: the main process was asked to check the address on each of the three clicks, and to open it once`, sent('pdfws:check-link').length === 3 && sent('pdfws:check-link').every((u) => u === 'https://example.com/Docs?a=1#top')
      && JSON.stringify(sent('pdfws:open-link')) === '["https://example.com/Docs?a=1#top"]', JSON.stringify(calls.slice(mark).map((c) => [c.channel, c.args[0]])));

    await click(1);
    card = await cardState();
    await choose('Open');
    check(`${theme}: a mail link asks and opens the mail address`, card && card.address === 'mailto:team@example.com' && opened.length === 2 && opened[1] === 'mailto:team@example.com', JSON.stringify([card, opened]));

    await click(2);
    check(`${theme}: a link to an ftp address shows no card and opens nothing`, !(await cardState()) && opened.length === 2 && sent('pdfws:check-link').length === 5 && await stayed(), JSON.stringify([opened.length, sent('pdfws:check-link')]));
    for (const [row, what] of [[2, 'a file'], [3, 'a script'], [7, 'another document'], [8, 'a program']]) {
      await clickLine(row);
      check(`${theme}: a click where the file has a link to ${what} shows no card and opens nothing`, !(await cardState()) && opened.length === 2 && await stayed(), JSON.stringify(opened));
    }
    const hostile = ['file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'data:text/html,x', 'ms-msdt:/id PCWDiagnostic', '\\\\server\\share\\a.exe', 'ftp://example.com/x', 'tel:+60123456789'];
    await js(win, `window.hostile = ${JSON.stringify(hostile)}.map((url) => { const a = document.createElement('a'); workspaceViewer.viewer.linkService.addLinkAttributes(a, url); document.querySelector('.well').append(a); return a; })`);
    await js(win, `window.hostile.forEach((a) => a.click())`);
    await sleep(500);
    check(`${theme}: the same links made by the page for any other address show no card and open nothing`, !(await cardState()) && opened.length === 2 && await stayed(), JSON.stringify(opened));
    await js(win, `window.hostile.forEach((a) => a.remove())`);

    await click(3);
    check(`${theme}: a link to a page goes to it`, await onPage(3));
    await press(win, 'Left', ['alt']);
    check(`${theme}: Alt+Left goes back to where the link was followed from`, await onPage(1));
    await press(win, 'Right', ['alt']);
    check(`${theme}: Alt+Right goes forward again`, await onPage(3));
    await press(win, 'Right', ['alt']);
    check(`${theme}: with nothing further forward Alt+Right does nothing`, (await page()) === 3);
    await press(win, 'Left', ['alt']);
    await press(win, 'Left', ['alt']);
    await sleep(500);
    check(`${theme}: with nothing further back Alt+Left does nothing, and the window stays where it is`, (await page()) === 1 && await stayed());

    await click(3);
    await onPage(3);
    await js(win, `document.getElementById('findbtn').click()`);
    await sleep(500);
    await press(win, 'Left', ['alt']);
    check(`${theme}: while the find field has the keys Alt+Left does not go back`, (await page()) === 3);
    await js(win, `document.getElementById('findbtn').click()`);
    await sleep(300);
    await press(win, 'Left', ['alt']);
    check(`${theme}: with the find bar shut it does`, await onPage(1));

    await click(4);
    check(`${theme}: a link that runs the next-page action goes to page 2`, await onPage(2));
    await closeAndWait(win);
  }
  nativeTheme.themeSource = 'light';

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
    await clickPagesButton(win);
    const panel = () => js(win, `({ canvases: document.querySelectorAll('.thumb canvas').length, entries: document.querySelectorAll('.thumb').length, kept: workspaceSidebar.thumbs.kept(), pages: document.querySelectorAll('.page canvas').length })`);
    let walk = await panel();
    check('the panel opens on the page in view with 3 000 entries and only the few in view drawn', walk.entries === 3000 && walk.canvases > 0 && walk.canvases < 30 && walk.kept <= walk.canvases + 20, JSON.stringify(walk));
    for (let step = 0; step < 160 && walk.kept < 300; step++) {
      await js(win, `document.getElementById('thumbs').scrollTop += 1500`);
      await sleep(450);
      walk = await panel();
    }
    for (let step = 0; step < 10; step++) { await js(win, `document.getElementById('thumbs').scrollTop += 1500`); await sleep(450); }
    walk = await panel();
    check('scrolling through hundreds of pages fills the thumbnail cache to 300 and no further, with fewer than 30 drawn at a time', walk.kept === 300 && walk.canvases > 0 && walk.canvases < 30, JSON.stringify(walk));
    check('the pages of the main view stay under 20 drawn while the panel is busy', walk.pages > 0 && walk.pages < 20, JSON.stringify(walk));
    await js(win, `document.getElementById('thumbs').scrollTop = document.getElementById('thumbs').scrollHeight`);
    check('the last page is drawn when the panel reaches the end', await until('the last thumbnail', () => js(win, `!!document.querySelector('.thumb[data-n="3000"] canvas')`)));
    await js(win, `document.querySelector('.thumb[data-n="3000"]').click()`);
    await sleep(800);
    check('and a click on it goes to page 3 000', (await js(win, `workspaceViewer.viewer.currentPageNumber`)) === 3000);
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

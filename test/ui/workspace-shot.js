// SPDX-License-Identifier: AGPL-3.0-or-later
// Opens the real workspace window on PDFs drawn here: the window's size, place and look in both themes (glass and the opaque
// window of Windows 10), the options pdf.js is given, how many bytes a 40 MB, 3 000-page file costs to show its first page, while
// idle and after scrolling 50 pages, the comments a file holds as markers beside the page, the scroll bars, the pages panel and its outline, a password-protected
// file, a file that is not a PDF, a file that is not there, and that the page is cut off from the network. Saves screenshots.
//   npx electron test/ui/workspace-shot.js
const { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, nativeTheme, screen } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument, PDFName, PDFRawStream, PDFString, PDFHexString, StandardFonts, clip, endPath, popGraphicsState, pushGraphicsState, rectangle, rgb } = require('pdf-lib');
const { createWorkspace } = require('../../src/features/pdf-workspace');
const { uniquePath, runPdfTool, detectEngines, probeLocked, checkPassword, asPdf, pdfSourceExts, convertFile } = require('../../src/features/conversion');
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
const shown = [];
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, fn) => handle(channel, (event, ...args) => { calls.push({ channel, args }); return fn(event, ...args); });
let writes = 0;
const setSettings = (patch) => { writes++; settings = { ...settings, ...patch }; };

// One workspace per scenario: the IPC handlers belong to one at a time. A scenario starts with no remembered view unless it asks to keep it.
const VIEW_KEYS = ['zoom', 'layout', 'sidebar', 'pageColours'];
const fresh = ({ keepView = false, ...options } = {}) => {
  if (!keepView && settings.pdfView && typeof settings.pdfView === 'object') settings = { ...settings, pdfView: Object.fromEntries(Object.entries(settings.pdfView).filter(([key]) => !VIEW_KEYS.includes(key))) };
  for (const channel of ['pdfws:state', 'pdfws:read', 'pdfws:unlock', 'pdfws:close', 'pdfws:drop', 'pdfws:focus', 'pdfws:dock', 'pdfws:view', 'pdfws:check-link', 'pdfws:open-link', 'pdfws:copy-link', 'pdfws:copy-links', 'pdfws:put-revision', 'pdfws:apply', 'pdfws:undo', 'pdfws:redo', 'pdfws:save', 'pdfws:save-as', 'pdfws:choose-sources', 'pdfws:drop-sources', 'pdfws:unlock-source', 'pdfws:extract', 'pdfws:split-plan', 'pdfws:split', 'pdfws:reload', 'pdfws:close-window', 'pdfws:properties', 'pdfws:details', 'pdfws:rename', 'pdfws:show', 'pdfws:engine', 'pdfws:install-engine']) ipcMain.removeHandler(channel);
  const workspace = createWorkspace({ hasPdfEngine: () => true, asset, getSettings: () => settings, setSettings, notify: (m) => notices.push(m), log: () => {}, openExternal: (url) => { opened.push(url); return Promise.resolve(); }, copyText: (text) => clipboard.writeText(text), uniquePath, runPdfTool, probeLocked, checkPassword, asPdf, pdfSourceExts, makePdf: (src, outDir, signal) => convertFile(src, 'pdf', { outDir, signal }), showInFolder: (file) => shown.push(file), ...options });
  workspace.registerIpc();
  return workspace;
};
const forgetSize = () => { settings = { ...settings, pdfView: { ...settings.pdfView, window: null } }; };
const js = (win, code) => win.webContents.executeJavaScript(code);
const shot = async (win, name) => fs.writeFileSync(path.join(out, name), (await win.webContents.capturePage()).toPNG());
const until = async (what, fn, ms = 20000) => {
  for (let waited = 0; waited < ms; waited += 100) { if (await fn()) return true; await sleep(100); }
  console.log(`  (gave up waiting for ${what})`);
  return false;
};

// The ink in an element that differs most from the paper at its top left corner, against that paper, from a capture of the window, so
// see-through colours are measured as they are shown.
async function inkContrast(win, selector) {
  const room = await js(win, `(() => { const c = document.querySelector(${JSON.stringify(selector)}); const r = c.getBoundingClientRect(); return { text: c.scrollWidth, box: c.clientWidth, rect: [r.left, r.top, r.right, r.bottom], width: innerWidth }; })()`);
  const capture = await win.webContents.capturePage();
  const bitmap = capture.toBitmap();
  const k = capture.getSize().width / room.width;
  const at = (x, y) => { const p = (Math.round(y * k) * capture.getSize().width + Math.round(x * k)) * 4; return [bitmap[p + 2], bitmap[p + 1], bitmap[p]]; };
  const shade = (rgb) => rgb.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }).reduce((sum, v, n) => sum + v * [0.2126, 0.7152, 0.0722][n], 0);
  const paper = shade(at(room.rect[0] + 2, room.rect[1] + 2));
  let ink = paper;
  for (let y = room.rect[1]; y < room.rect[3]; y += 0.5) for (let x = room.rect[0]; x < room.rect[2]; x += 0.5) { const s = shade(at(x, y)); if (Math.abs(s - paper) > Math.abs(ink - paper)) ink = s; }
  return { ...room, ratio: (Math.max(paper, ink) + 0.05) / (Math.min(paper, ink) + 0.05) };
}
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
  return { checked: [...document.querySelectorAll('#rail .seg3 button')].map((b) => b.textContent + '=' + b.getAttribute('aria-checked')).join(), thumbsHidden: document.getElementById('thumbs').hidden, outlineHidden: document.getElementById('outline').hidden,
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
    check('the page is given a token, a name and a size, and no path', Object.keys(JSON.parse(state).documents[0]).sort().join() === 'added,canRedo,canUndo,dirty,name,size,token' && !state.includes(root.replace(/\\/g, '\\\\')) && !/[A-Za-z]:\\\\/.test(state), state);
    check('the page cannot read with a token it was not given', (await js(win, `workspaceApi.read('0'.repeat(64), 0, 10).then(() => 'read', () => 'refused')`)) === 'refused');
    check('the page cannot read more than 4 MiB in one call', (await js(win, `workspaceApi.state().then((s) => workspaceApi.read(s.documents[0].token, 0, 4 * 1048576 + 1)).then(() => 'read', () => 'refused')`)) === 'refused');
    await closeAndWait(win);
  }

  console.log('closing the window just after it moved');
  {
    const thrown = [];
    const caught = (e) => thrown.push(e.message);
    process.on('uncaughtException', caught);
    for (let round = 0; round < 3; round++) {
      const win = await openAndWait(fresh(), small);
      const b = win.getBounds();
      win.setBounds({ ...b, x: b.x + 10, width: b.width - 10 });
      win.on('close', () => win.emit('resize'));
      win.close();
      await sleep(900);
    }
    process.off('uncaughtException', caught);
    check('a move or resize that arrives while the window is closing leaves no timer behind to fail on a window that is gone', thrown.length === 0, thrown.join(' | '));
  }

  console.log('tabs: several PDFs in one window');
  {
    const tabState = (win) => js(win, `(() => { const strip = document.getElementById('tabs'); const tabs = [...strip.querySelectorAll('.tab')]; const name = document.getElementById('docname');
      return { strip: !strip.hidden, names: tabs.map((t) => t.firstChild.textContent).join('|'), on: tabs.filter((t) => t.classList.contains('on')).map((t) => t.firstChild.textContent).join(), selected: tabs.filter((t) => t.getAttribute('aria-selected') === 'true').length,
        stops: tabs.filter((t) => t.tabIndex === 0).length, name: name.textContent, nameShown: !document.getElementById('nameline').hidden, pages: document.querySelectorAll('.page').length, canvases: document.querySelectorAll('.page canvas').length, failure: document.getElementById('failure').hidden ? '' : document.getElementById('failure').textContent,
        text: document.querySelector('.page[data-loaded="true"] .textLayer')?.textContent ?? '', page: workspaceViewer.viewer.currentPageNumber, zoom: workspaceViewer.viewer.currentScaleValue, scroll: document.getElementById('scroller').scrollTop, dock: !document.querySelector('.dockwrap')?.hidden }; })()`);
    const showing = (win, text, pages) => until(`${text} on show`, async () => { const s = await tabState(win); return s.text.includes(text) && s.pages === pages; });
    const clickTab = (win, n) => js(win, `document.querySelectorAll('#tabs .tab')[${n}].click()`);
    const closeTab = (win, n) => js(win, `document.querySelectorAll('#tabs .tab')[${n}].querySelector('.x').click()`);
    const other = await makePdf('Other.pdf', 1);
    const notPdf = path.join(root, 'Not a PDF.pdf');
    fs.writeFileSync(notPdf, 'This is a text file with a .pdf name.');

    settings = { ...settings, pdfRecent: [] };
    let workspace = fresh();
    let win = await openAndWait(workspace, small);
    let s = await tabState(win);
    check('one PDF shows its name and no tabs', !s.strip && s.nameShown && s.name === 'Small.pdf', JSON.stringify(s));

    win.minimize();
    await workspace.open([other]);
    await showing(win, 'page 1 of 1', 1);
    s = await tabState(win);
    check('a second start brings the same window to the front and adds a tab, which is shown', workspace.getWindow() === win && !win.isMinimized() && BrowserWindow.getAllWindows().length === 1 && s.strip && s.names === 'Small.pdf|Other.pdf' && s.on === 'Other.pdf' && !s.nameShown, JSON.stringify(s));
    check('the window is named for the tab on show, and the tab strip is one tab stop', win.getTitle() === 'Other.pdf - Pomelo' && s.selected === 1 && s.stops === 1 && s.failure === '');
    check('the page is drawn with ink on it', (await inkOnFirstPage(win)) > 100);
    await shot(win, 'workspace-tabs.png');

    await workspace.open([small]);
    await sleep(500);
    s = await tabState(win);
    check('a file that is open already is shown, not opened a second time', s.names === 'Small.pdf|Other.pdf' && s.on === 'Small.pdf' && win.getTitle() === 'Small.pdf - Pomelo', JSON.stringify(s));
    await workspace.open([path.join(root, 'small.PDF')]);
    await sleep(300);
    check('whatever the case of its path', (await tabState(win)).names === 'Small.pdf|Other.pdf');
    check('both files are in the recent list, newest first, once each', JSON.stringify(settings.pdfRecent) === JSON.stringify([other, small]), JSON.stringify(settings.pdfRecent));

    console.log('tabs: a tab is left as it was');
    await js(win, `workspaceViewer.viewer.currentScaleValue = '1.5'`);
    await sleep(400);
    await js(win, `workspaceViewer.viewer.currentPageNumber = 3`);
    await sleep(400);
    const left = await tabState(win);
    await clickTab(win, 1);
    await showing(win, 'page 1 of 1', 1);
    s = await tabState(win);
    check('another tab shows its own document and only its pages are drawn: the tab left holds none', s.pages === 1 && s.canvases <= 1 && s.on === 'Other.pdf', JSON.stringify(s));
    await clickTab(win, 0);
    await showing(win, 'page', 3);
    await sleep(600);
    s = await tabState(win);
    check('coming back, the tab has the page, the zoom and the place it was left at', s.page === 3 && s.zoom === '1.5' && Math.abs(s.scroll - left.scroll) <= 2 && s.canvases >= 1, `${JSON.stringify(left)} ${JSON.stringify(s)}`);
    check('and the dock shows its page count', (await js(win, `document.querySelector('.pagecount').textContent.replace(/\\s/g, '')`)) === '/3' && s.dock);

    console.log('tabs: the keyboard');
    await js(win, `document.querySelector('#tabs .tab.on').focus()`);
    await press(win, 'Right');
    await showing(win, 'page 1 of 1', 1);
    s = await tabState(win);
    check('Right moves to the next tab and shows it, and the focus stays in the strip', s.on === 'Other.pdf' && (await js(win, `document.activeElement.classList.contains('on') && document.activeElement.closest('#tabs') !== null`)));
    await press(win, 'Home');
    await showing(win, 'page', 3);
    check('Home goes to the first tab', (await tabState(win)).on === 'Small.pdf');
    await press(win, 'End');
    await showing(win, 'page 1 of 1', 1);
    check('End goes to the last', (await tabState(win)).on === 'Other.pdf');

    console.log('tabs: a file that cannot be shown among others');
    await workspace.open([notPdf]);
    await until('the failure', async () => (await tabState(win)).failure !== '');
    s = await tabState(win);
    check('a file that is not a PDF says so in its own tab and the others are untouched', s.on === 'Not a PDF.pdf' && s.failure === 'This file is damaged or is not a PDF' && s.pages === 0 && !s.dock && s.names === 'Small.pdf|Other.pdf|Not a PDF.pdf', JSON.stringify(s));
    await clickTab(win, 0);
    await showing(win, 'page', 3);
    s = await tabState(win);
    check('and the next tab hides the failure and shows its own pages', s.failure === '' && s.on === 'Small.pdf' && s.dock);
    await clickTab(win, 2);
    await until('the failure again', async () => (await tabState(win)).failure !== '');
    check('coming back to it shows the same failure', (await tabState(win)).failure === 'This file is damaged or is not a PDF');

    console.log('tabs: closing');
    const tokens = await js(win, `workspaceApi.state().then((st) => st.documents.map((d) => d.token))`);
    check('the main process knows all three documents', tokens.length === 3);
    await closeTab(win, 2);
    await showing(win, 'page 1 of 1', 1);
    s = await tabState(win);
    check('closing the rightmost tab, which was on show, shows the one before it', s.names === 'Small.pdf|Other.pdf' && s.on === 'Other.pdf' && s.strip && s.failure === '', JSON.stringify(s));
    check('the closed document can no longer be read, the others still can', await js(win, `Promise.all([workspaceApi.read(${JSON.stringify(tokens[2])}, 0, 10).then(() => 'read', () => 'refused'), workspaceApi.read(${JSON.stringify(tokens[1])}, 0, 10).then(() => 'read', () => 'refused')]).then((r) => r.join())`) === 'refused,read');
    await closeTab(win, 0);
    await sleep(500);
    s = await tabState(win);
    check('closing a tab that is not on show leaves the one on show, and one tab left shows its name alone', s.on === 'Other.pdf' && !s.strip && s.nameShown && s.name === 'Other.pdf' && s.pages === 1 && win.getTitle() === 'Other.pdf - Pomelo', JSON.stringify(s));
    check('the tab closed last can no longer be read either', await js(win, `workspaceApi.read(${JSON.stringify(tokens[0])}, 0, 10).then(() => 'read', () => 'refused')`) === 'refused');
    check('the window is still open', workspace.getWindow() === win && !win.isDestroyed());
    await win.webContents.executeJavaScript(`workspaceApi.state().then((st) => workspaceApi.close(st.documents[0].token))`);
    await sleep(800);
    check('closing the last tab closes the window and the file', win.isDestroyed() && workspace.getWindow() === null && workspace.served() === 0 && BrowserWindow.getAllWindows().length === 0);

    console.log('tabs: ten at most');
    const ten = [];
    for (let i = 1; i <= 11; i++) ten.push(await makePdf(`Ten ${String(i).padStart(2, '0')}.pdf`, 1));
    notices.length = 0;
    workspace = fresh();
    win = await openAndWait(workspace, ten[0]);
    await workspace.open(ten.slice(1, 10));
    await sleep(600);
    s = await tabState(win);
    check('ten files are ten tabs and the first of the last batch is on show', s.names.split('|').length === 10 && s.on === 'Ten 02.pdf' && notices.length === 0, JSON.stringify(s));
    win.setSize(1000, 700);
    await sleep(500);
    const room = () => js(win, `(() => { const strip = document.getElementById('tabs'); const box = strip.getBoundingClientRect(); const on = strip.querySelector('.on').getBoundingClientRect(); const right = [...document.querySelectorAll('.titletools > :not([hidden])')][0].getBoundingClientRect(); const left = [...document.querySelectorAll('.titleleft > *')].pop().getBoundingClientRect();
      return { tabs: [...strip.children].map((t) => Math.round(t.getBoundingClientRect().width)), names: Math.min(...[...strip.querySelectorAll('.tab span')].map((n) => Math.round(n.getBoundingClientRect().width))), before: Math.round(box.left - left.right), after: Math.round(right.left - box.right), scrolls: strip.scrollWidth > strip.clientWidth, onInView: on.left >= box.left + (strip.classList.contains('more-left') ? 24 : 0) - 1 && on.right <= box.right - (strip.classList.contains('more-right') ? 24 : 0) + 1, fade: ['more-left', 'more-right'].filter((c) => strip.classList.contains(c)).join() }; })()`);
    let r = await room();
    check('at 1 000 px ten tabs keep 96 px each, with room for about a dozen letters of the name, and the strip scrolls instead of squeezing them (they were 52 px with 11 px of name)', r.tabs.every((w) => w >= 96) && r.names >= 50 && r.scrolls, JSON.stringify(r));
    check('the strip keeps 12 px from the buttons on both sides, and fades on the side that has more tabs', r.before >= 12 && r.after >= 12 && r.fade === 'more-right' && r.onInView, JSON.stringify(r));
    check('a thin line stands between neighbouring tabs, and none beside the tab on show', await js(win, `(() => { const o = [...document.querySelectorAll('#tabs .tab')].map((t) => { const c = getComputedStyle(t, '::before'); return c.content === 'none' ? 'none' : c.opacity + ':' + c.width; }); return o.join(' '); })()`) === 'none 0:1px 0:1px 0.35:1px 0.35:1px 0.35:1px 0.35:1px 0.35:1px 0.35:1px 0.35:1px');
    await shot(win, 'workspace-tabs-ten.png');
    await js(win, `document.getElementById('savebtn').hidden = false`);
    await js(win, `(() => { for (const at of ['.titleleft', '.titletools']) { const b = document.createElement('button'); b.className = 'ib extra'; document.querySelector(at).prepend(b); } })()`);
    await sleep(300);
    r = await room();
    check('with Save showing and a button more on each side, the strip still keeps 12 px from them and the tabs keep their 96 px', r.tabs.every((w) => w >= 96) && r.before >= 12 && r.after >= 12, JSON.stringify(r));
    await shot(win, 'workspace-tabs-ten-save.png');
    await js(win, `(() => { document.getElementById('savebtn').hidden = true; for (const b of document.querySelectorAll('.extra')) b.remove(); })()`);
    await clickTab(win, 9);
    await sleep(500);
    r = await room();
    check('choosing the last tab scrolls it into view, clear of the fade, which moves to the left', r.onInView && r.fade === 'more-left', JSON.stringify(r));
    const wheelAt = await js(win, `(() => { const b = document.getElementById('tabs').getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), from: document.getElementById('tabs').scrollLeft }; })()`);
    win.webContents.sendInputEvent({ type: 'mouseWheel', x: wheelAt.x, y: wheelAt.y, deltaX: 0, deltaY: 120, wheelTicksY: 1 });
    await sleep(400);
    check('the mouse wheel scrolls the strip sideways', (await js(win, `document.getElementById('tabs').scrollLeft`)) < wheelAt.from, JSON.stringify(wheelAt));
    await workspace.open([ten[10]]);
    await sleep(400);
    s = await tabState(win);
    check('an eleventh is refused in the corner notice and opens no tab', s.names.split('|').length === 10 && notices.length === 1 && notices[0].title === 'Too many PDFs open' && notices[0].detail === 'Close one to open another.', JSON.stringify([s.names, notices]));
    await closeTab(win, 0);
    await workspace.open([ten[10]]);
    await until('the new tab', async () => (await tabState(win)).names.includes('Ten 11.pdf'));
    check('with one closed there is room for it', (await tabState(win)).on === 'Ten 11.pdf');
    check('the recent list holds ten paths at most, newest first', settings.pdfRecent.length === 10 && settings.pdfRecent[0] === ten[10] && !settings.pdfRecent.includes(ten[0]), JSON.stringify(settings.pdfRecent.map((p) => path.basename(p))));
    await closeAndWait(win);

    console.log('tabs: files dropped on the window');
    workspace = fresh();
    win = await openAndWait(workspace, small);
    const drop = async (files, items = []) => {
      const dbg = win.webContents.debugger;
      if (!dbg.isAttached()) dbg.attach('1.3');
      const data = { items, files, dragOperationsMask: 1 };
      for (const type of ['dragEnter', 'dragOver', 'drop']) await dbg.sendCommand('Input.dispatchDragEvent', { type, x: 300, y: 300, data });
      await sleep(900);
    };
    await drop([other]);
    s = await tabState(win);
    check('a PDF dropped on the window opens in a new tab and is shown', s.names === 'Small.pdf|Other.pdf' && s.on === 'Other.pdf' && win.getTitle() === 'Other.pdf - Pomelo', JSON.stringify(s));
    notices.length = 0;
    await drop([path.join(root, 'readme.txt')]);
    check('a file that is not a PDF opens nothing and says so', (await tabState(win)).names === 'Small.pdf|Other.pdf' && notices.length === 1 && notices[0].title === 'PDF files only', JSON.stringify(notices));
    await drop([], [{ mimeType: 'text/plain', data: 'some words' }]);
    check('dragged text, which is no file, opens nothing and says nothing', (await tabState(win)).names === 'Small.pdf|Other.pdf' && notices.length === 1, JSON.stringify(notices));
    check('a drop made up by the page does nothing', (await js(win, `(() => { const data = new DataTransfer(); data.items.add(new File(['x'], 'fake.pdf')); document.dispatchEvent(new DragEvent('drop', { dataTransfer: data })); return document.querySelectorAll('#tabs .tab').length; })()`)) === 2);
    win.webContents.debugger.detach();
    notices.length = 0;
    await closeAndWait(win);

    console.log('tabs: the Open dialog starts where the last PDF was');
    check('the newest file in the list gives the folder', require('../../src/features/pdf-workspace/recent').startFolder(settings.pdfRecent) === root);
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
    check(`${theme}: the dock holds the page group and the zoom group and nothing else`, d.titles.join('|') === 'Drag to move|Previous page (Page Up)|Next page (Page Down)|Pages (P)|Zoom out (Ctrl+−)|View options|Zoom in (Ctrl+=)'
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
    check(`${theme}: the zoom value opens the View menu with Zoom, Layout and Page colour`, menu.shown && menu.expanded === 'true' && menu.caps.join() === 'Zoom,Layout,Page colour'
      && menu.items.join() === 'Fit width,Fit page,Actual size,Continuous,Two pages side by side,Original,Sepia,Dark,Custom colours…' && menu.keys.join() === 'Ctrl+0,Ctrl+1', JSON.stringify(menu));
    await shot(win, `workspace-menu-${theme}.png`);
    await press(win, 'Escape');
    check(`${theme}: Esc closes the menu`, !(await dockState(win)).menu);
    await js(win, `document.querySelector('.dock .zoom').click()`);
    await js(win, `[...document.querySelectorAll('.menu .mi')].find((n) => n.textContent.startsWith('Two pages')).click()`);
    await sleep(500);
    d = await dockState(win);
    check(`${theme}: choosing Two pages side by side lays the pages out in pairs and closes the menu`, d.layout === 1 && !d.menu, JSON.stringify(d));
    await js(win, `document.querySelector('.dock .zoom').click()`);
    check(`${theme}: the menu marks the layout and the page colour in use`, (await js(win, `[...document.querySelectorAll('.menu .mi.on')].map((n) => n.firstChild.textContent).join()`)) === 'Two pages side by side,Original');
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
    const dockSize = () => js(win, `(() => { const d = document.querySelector('.dockwrap'); return d.offsetWidth + 'x' + d.offsetHeight; })()`);
    const row = await dockSize();
    await dragTo(...edges.left, true);
    v = await where();
    check('while it is dragged the dock follows the pointer and four places are marked, the nearest in the accent', v.dragging && v.ghosts === 4 && v.on.join() === 'left' && v.left < 120, JSON.stringify(v));
    check(`held against the left edge it keeps the 16 px it rests at (it went to 0 before), so its corner and shadow are not cut (${v.left} px)`, Math.abs(v.left - 16) < 1, JSON.stringify(v));
    const places = await js(win, `(() => { const s = (side) => { const r = document.querySelector('.snap.' + side).getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); }; return { row: [s('bottom'), s('top')], column: [s('left'), s('right')] }; })()`);
    await shot(win, 'workspace-dock-dragging.png');
    mouse('mouseUp', ...edges.left);
    await sleep(800);
    const upright = await dockSize();
    check(`each place marked while dragging is the size of the dock that lands there, ${row} in a row and ${upright} in a column (they were 326x50 and 76x260)`, places.row.every((s) => s === row) && places.column.every((s) => s === upright), JSON.stringify([places, row, upright]));
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
    check('the title row has a Find button after the panel button, ready once the pages are known, and the bar is shut', v.titleLeft === 'pagesbtn,findbtn,linksbtn' && v.title === 'Find (Ctrl+F)' && !v.disabled && v.hidden && v.pressed === 'false', JSON.stringify(v));
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
    win.setSize(900, 600);
    await sleep(900);
    const mouse = (type, x, y) => win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, modifiers: type === 'mouseUp' ? [] : ['leftButtonDown'] });
    const geometry = await js(win, `(() => { const spans = [...document.querySelectorAll('.page[data-page-number="1"] .textLayer span')].filter((s) => /Delivery of the goods|will happen/.test(s.textContent)).map((s) => s.getBoundingClientRect());
      const p = document.querySelector('.page[data-page-number="1"]').getBoundingClientRect(); return { lines: spans.map((r) => ({ l: r.left, r: r.right, y: r.top + r.height / 2 })), page: { l: p.left, r: p.right, b: Math.min(p.bottom, document.querySelector('.dock').getBoundingClientRect().top - 12) } }; })()`);
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
    forgetSize();
  }

  console.log('finding: the hits listed, marked and coloured');
  {
    const win = await openAndWait(fresh(), await makeSearchPdf('Search hits.pdf'));
    await sleep(500);
    const resultsState = () => js(win, `(() => { const rows = [...document.querySelectorAll('#results .hitrow')]; const sel = document.querySelector('.textLayer .highlight.selected'); const hp = document.getElementById('hitpanel'); const head = document.querySelector('.viewhead'); const first = document.querySelector('#results .hitrow .snip'); const x = document.getElementById('hitclose').getBoundingClientRect(); const well = document.querySelector('.well').getBoundingClientRect();
      return { panelOpen: hp.classList.contains('open'), panelWidth: hp.getBoundingClientRect().width, panelRight: hp.getBoundingClientRect().right, win: innerWidth, listHidden: document.getElementById('hitinner').hidden, railOpen: document.getElementById('rail').classList.contains('open'), railWidth: document.getElementById('rail').getBoundingClientRect().width,
        pagesPressed: document.getElementById('pagesbtn').getAttribute('aria-pressed'), thumbs: document.querySelectorAll('.thumb').length, tabs: [...document.querySelectorAll('#rail .seg3 button')].map((b) => b.textContent + '=' + b.getAttribute('aria-checked')).join(),
        side: [...document.querySelectorAll('#hitpanel .seg3 button')].map((b) => b.textContent + '=' + b.getAttribute('aria-checked')).join(), total: head.querySelector('.total').textContent, headHeight: head.getBoundingClientRect().height, titleLeft: head.querySelector('.total').getBoundingClientRect().left, rowLeft: first ? first.getBoundingClientRect().left : -1,
        closeRight: x.right, listRight: document.getElementById('results').getBoundingClientRect().right, closeLabel: document.getElementById('hitclose').title, wellRight: well.right, wellLeft: well.left, rows: rows.length, pages: rows.map((r) => r.querySelector('.pg').textContent).join(), marks: rows.map((r) => r.querySelector('mark') ? r.querySelector('mark').textContent : '').join(),
        heads: [...document.querySelectorAll('#results .hitpage')].map((h) => h.firstChild.textContent + '=' + h.lastChild.textContent).join(), snips: rows.map((r) => r.querySelector('.snip').textContent), on: rows.filter((r) => r.classList.contains('on')).map((r) => rows.indexOf(r)).join(), space: parseFloat(document.querySelector('.rowspace').style.height) || 0,
        pressed: document.querySelector('.findbar button[title="Show all results"]').getAttribute('aria-pressed'), selectedText: sel ? sel.textContent : '', selectedPage: sel && sel.closest('.page') ? sel.closest('.page').dataset.pageNumber : '' }; })()`);
    const ticks = () => js(win, `(() => { const c = document.querySelector('.ticks'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; const x = Math.floor(c.width / 2); const bands = []; let cur = null;
      for (let y = 0; y < c.height; y++) { const i = (y * c.width + x) * 4; if (d[i + 3] > 0) { if (!cur) { cur = { from: y, to: y, current: false }; bands.push(cur); } cur.to = y; if (d[i] > 240 && d[i + 1] > 220 && d[i + 1] < 250 && d[i + 2] < 100) cur.current = true; } else cur = null; }
      return { w: c.clientWidth, h: c.clientHeight, bands: bands.map((b) => ({ from: +(b.from / c.height).toFixed(3), to: +(b.to / c.height).toFixed(3), current: b.current })) }; })()`);
    let v = await resultsState();
    check('with no search there is no Results panel, and the Pages panel has only its own two tabs', !v.panelOpen && v.panelWidth === 0 && v.listHidden && v.tabs === 'Pages=true,Outline=false', JSON.stringify(v));
    await press(win, 'F', ['control']);
    await typeInto(win, 'delivery');
    await countIs(win, '1 of 4');
    await sleep(900);
    await until('rows', async () => { const r = await resultsState(); return r.snips.length === 4 && r.snips.every(Boolean); });
    v = await resultsState();
    check('searching opens the right-hand panel on its Search tab by itself, with a row for every hit and the list button pressed', v.panelOpen && !v.listHidden && Math.abs(v.panelWidth - 300) <= 1 && v.rows === 4 && v.pressed === 'true' && v.side === 'Search=true,Links=false' && v.total === '4 results', JSON.stringify(v));
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
    v = await resultsState();
    check('the panel stands on the right, 300 px wide, as the Search and Links tabs', v.panelOpen && Math.abs(v.panelWidth - 300) <= 1 && Math.abs(v.panelRight - v.win) <= 1 && v.side === 'Search=true,Links=false' && v.total === '4 results', JSON.stringify(v));
    check('the Pages panel is not opened or built by it: it stays shut with its button off and no thumbnail drawn, and the document area gives up the room on the right only', !v.railOpen && v.railWidth === 0 && v.pagesPressed === 'false' && v.thumbs === 0 && v.wellLeft < 20 && Math.abs(v.wellRight - (v.win - 300)) <= 12, JSON.stringify(v));
    check('the panel is laid out evenly: the count stands where the rows\' words do, and the close button ends where the list ends', v.headHeight === 32 && Math.abs(v.titleLeft - v.rowLeft) <= 1 && Math.abs(v.closeRight - v.listRight) <= 1 && v.closeLabel === 'Hide panel', JSON.stringify(v));
    check('the hits stand under a heading for each page with its count', v.heads === 'Page 1=1,Page 2=1,Page 3=2', JSON.stringify(v));
    check('each row names its page to a screen reader and marks the hit in a few words of the text round it', v.pages === 'Page 1,Page 2,Page 3,Page 3' && v.marks === 'Delivery,delivery,Delivery,delivery' && /^Delivery of the goods/.test(v.snips[0]) && /ask for delivery here/.test(v.snips[1]) && v.snips[1].startsWith('…') && v.snips[2] === 'Delivery redelivery', JSON.stringify(v.snips));
    check('the row of the hit in view is the one marked on', v.on === '2', JSON.stringify(v));
    await shot(win, 'workspace-search-results.png');
    await js(win, `document.querySelectorAll('#results .hitrow')[3].click()`);
    await countIs(win, '4 of 4');
    await sleep(800);
    v = await resultsState();
    check('a click on a row goes to that hit: its page, its text marked in yellow and the count', v.selectedPage === '3' && v.selectedText === 'delivery' && v.on === '3' && (await barState(win)).page === 3, JSON.stringify(v));
    nativeTheme.themeSource = 'dark';
    await sleep(400);
    const darkRow = await js(win, `(() => { const on = getComputedStyle(document.querySelector('#results .hitrow.on')); const off = getComputedStyle([...document.querySelectorAll('#results .hitrow')].find((r) => !r.classList.contains('on'))); return { on: on.backgroundColor, off: off.backgroundColor }; })()`);
    await shot(win, 'workspace-search-current-dark.png');
    nativeTheme.themeSource = 'light';
    await sleep(400);
    check('in the dark the row of the hit in view has a lighter surface than the others', darkRow.on === 'rgba(255, 255, 255, 0.2)' && darkRow.on !== darkRow.off, JSON.stringify(darkRow));
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
    check('closing the bar shuts the Search tab and takes the rows and the marks away', !v.panelOpen && v.panelWidth === 0 && v.listHidden && v.rows === 0 && v.pressed === 'false' && t.bands.length === 0, JSON.stringify({ v, t }));
    await press(win, 'F', ['control']);
    await typeInto(win, 'deliv');
    await until('rows for deliv', async () => (await resultsState()).marks === 'Deliv,deliv,Deliv,deliv');
    v = await resultsState();
    check('the rows show what was searched for, not the hits of the letters before', v.marks === 'Deliv,deliv,Deliv,deliv' && v.rows === 4, JSON.stringify(v));
    await typeInto(win, 'ery');
    await until('rows for delivery', async () => (await resultsState()).marks === 'Delivery,delivery,Delivery,delivery');
    v = await resultsState();
    check('and when the word is finished every row is drawn again for it', v.marks === 'Delivery,delivery,Delivery,delivery' && v.rows === 4 && v.pages === 'Page 1,Page 2,Page 3,Page 3', JSON.stringify(v));
    await closeAndWait(win);
  }

  console.log('finding a word that is found hundreds of times');
  {
    const win = await openAndWait(fresh(), await makeManyPdf('Search many.pdf'));
    await sleep(500);
    await press(win, 'F', ['control']);
    await typeInto(win, 'alpha');
    await countIs(win, '1 of 480');
    await sleep(900);
    const rowsNow = () => js(win, `(() => { const l = document.getElementById('results'); const rows = [...l.querySelectorAll('.hitrow')]; return { rows: rows.length, space: parseFloat(document.querySelector('.rowspace').style.height), top: l.scrollTop, height: l.clientHeight,
      first: rows.length ? rows[0].querySelector('.pg').textContent : '', last: rows.length ? rows[rows.length - 1].querySelector('.pg').textContent : '', empty: rows.filter((r) => !r.querySelector('mark')).length }; })()`);
    let v = await rowsNow();
    check('480 hits on 2 pages are one list as tall as 2 page headings and 480 rows, with only the rows in view built', v.space === 2 * 30 + 480 * 52 && v.rows > 5 && v.rows < 30, JSON.stringify(v));
    await js(win, `document.getElementById('results').scrollTop = 30 + 100 * 52`);
    await sleep(600);
    await js(win, `[...document.querySelectorAll('#results .hitrow')].find((r) => r.style.top === '5230px').click()`);
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
    check('in focus reading the right-hand panel floats over the right edge and the pages do not move', side.position === 'absolute' && Math.abs(side.right - side.win) <= 1 && Math.abs(side.width - 300) <= 1 && side.well === wellBefore, JSON.stringify(side));
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
    const look = () => js(win, `(() => { const s = getComputedStyle(document.querySelector('.page[data-page-number="1"] .linkAnnotation a')); return { bg: s.backgroundColor, blend: getComputedStyle(document.querySelector('.page[data-page-number="1"] .annotationLayer')).mixBlendMode, opacity: s.opacity }; })()`);
    const blue = await look();
    check(`${theme}: a link is the usual blue, drawn so that the dark text under it turns blue and the paper stays white`, blue.bg === 'rgb(11, 87, 208)' && blue.blend === 'lighten' && blue.opacity === '1', JSON.stringify(blue));
    const firstAt = await js(win, `(() => { const r = document.querySelector('.page[data-page-number="1"] .linkAnnotation a').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(firstAt.x), y: Math.round(firstAt.y) });
    await sleep(300);
    const hover = await look();
    check(`${theme}: with the pointer over a link it is the same blue, not pdf.js's yellow`, hover.bg === 'rgb(11, 87, 208)' && hover.opacity === '1', JSON.stringify(hover));
    const tint = async (rect) => {
      const image = await win.webContents.capturePage({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) });
      const bytes = image.toBitmap();
      let blueish = 0;
      let dark = 0;
      for (let i = 0; i < bytes.length; i += 4) {
        const [b, g, r] = [bytes[i], bytes[i + 1], bytes[i + 2]];
        if (b > r + 90 && b > g + 50) blueish++;
        else if (r < 90 && g < 90 && b < 90) dark++;
      }
      return { blueish, dark };
    };
    const lines = await js(win, `(() => { const r = document.querySelector('.page[data-page-number="1"]').getBoundingClientRect(); const at = (row) => ({ x: r.left + (80 / 595) * r.width, y: r.top + ((842 - (760 - row * 40 + 16)) / 842) * r.height, width: (110 / 595) * r.width, height: (20 / 842) * r.height });
      return { linked: at(0), plain: at(2), inside: at(5) }; })()`);
    const [linked, plain, inside] = [await tint(lines.linked), await tint(lines.plain), await tint(lines.inside)];
    check(`${theme}: the text of a link is drawn blue on white paper, and the text of a line with no link stays black`, linked.blueish > 120 && linked.dark === 0 && plain.dark > 10 && plain.blueish < 60, JSON.stringify([linked, plain]));
    const jumps = await js(win, `[3, 4].map((i) => getComputedStyle([...document.querySelectorAll('.page[data-page-number="1"] .linkAnnotation a')][i]).backgroundColor).join('|')`);
    check(`${theme}: a link to a page of the document is not blue: its text stays black and its anchor takes no colour`, inside.dark > 100 && inside.blueish < inside.dark && jumps === 'rgba(0, 0, 0, 0)|rgba(0, 0, 0, 0)', JSON.stringify([inside, jumps]));
    await shot(win, `workspace-links-${theme}.png`);
    const press1 = async (at) => {
      for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: Math.round(at.x), y: Math.round(at.y), button: 'left', clickCount: 1 });
      await sleep(500);
    };
    const click = async (n) => press1(await js(win, `(() => { const r = [...document.querySelectorAll('.page[data-page-number="1"] .linkAnnotation a')][${n}].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`));
    const clickLine = async (row) => press1(await js(win, `(() => { const r = document.querySelector('.page[data-page-number="1"]').getBoundingClientRect(); return { x: r.left + (100 / 595) * r.width, y: r.top + ((842 - (760 - ${row} * 40 + 7)) / 842) * r.height }; })()`));
    const cardState = () => js(win, `(() => { const c = document.querySelector('.card'); return c ? { title: c.querySelector('h3').textContent, address: c.querySelector('.addr').textContent, buttons: [...c.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') || b.textContent).join(),
      focused: document.activeElement.getAttribute('aria-label') || document.activeElement.textContent, role: c.getAttribute('role'), modal: c.getAttribute('aria-modal'), labelled: !!document.getElementById(c.getAttribute('aria-labelledby')) } : null; })()`);
    const choose = async (name) => { await js(win, `[...document.querySelectorAll('.card button')].find((b) => b.textContent === ${JSON.stringify(name)}).click()`); await sleep(300); };
    const mark = calls.length;
    const sent = (channel) => calls.slice(mark).filter((c) => c.channel === channel).map((c) => c.args[0]);

    await click(0);
    let card = await cardState();
    check(`${theme}: a click on a web link asks first, showing the whole address as the parser reads it`, card && card.title === 'Open this link?' && card.address === 'https://example.com/Docs?a=1#top' && card.buttons === 'Copy link,Cancel,Open'
      && card.role === 'dialog' && card.modal === 'true' && card.labelled, JSON.stringify(card));
    check(`${theme}: nothing is opened while the card is up, and Open has the focus`, opened.length === 0 && card.focused === 'Open', JSON.stringify([opened, card]));
    await shot(win, `workspace-link-${theme}.png`);
    await press(win, 'Tab');
    check(`${theme}: Tab goes round the card's three buttons and stays inside it`, (await cardState()).focused === 'Copy link');
    await press(win, 'Tab');
    check(`${theme}: and on`, (await cardState()).focused === 'Cancel');
    await press(win, 'Tab', ['shift']);
    await press(win, 'Tab', ['shift']);
    check(`${theme}: Shift+Tab goes back through them to Open`, (await cardState()).focused === 'Open');
    const behind = await js(win, `({ scroller: document.getElementById('scroller').inert, title: document.querySelector('.titlerow').inert, dock: document.querySelector('.dockwrap').inert,
      scroll: document.getElementById('scroller').scrollTop, scale: workspaceViewer.viewer.currentScaleValue, page: workspaceViewer.viewer.currentPageNumber })`);
    check(`${theme}: while the card is up the pages, the title row and the dock cannot be reached`, behind.scroller && behind.title && behind.dock, JSON.stringify(behind));
    win.webContents.sendInputEvent({ type: 'mouseWheel', x: 600, y: 300, deltaX: 0, deltaY: -300 });
    win.webContents.sendInputEvent({ type: 'mouseWheel', x: 600, y: 300, deltaX: 0, deltaY: -100, modifiers: ['control'] });
    await press(win, 'PageDown');
    await press(win, '0', ['control']);
    await press(win, 'Left', ['alt']);
    const still = await js(win, `({ scroll: document.getElementById('scroller').scrollTop, scale: workspaceViewer.viewer.currentScaleValue, page: workspaceViewer.viewer.currentPageNumber })`);
    check(`${theme}: and neither the wheel, Ctrl and the wheel, Page Down, Ctrl+0 nor Alt+Left moves or zooms the pages behind it`, still.scroll === behind.scroll && still.scale === behind.scale && still.page === behind.page, JSON.stringify([behind, still]));
    const veilAt = await js(win, `(() => { const r = document.querySelector('.veil').getBoundingClientRect(); return { x: r.left + 20, y: r.top + 20 }; })()`);
    await press1(veilAt);
    check(`${theme}: a click on the veil leaves the focus in the card`, await js(win, `document.querySelector('.card').contains(document.activeElement)`));
    const inField = await js(win, `(() => { const f = document.querySelector('.card .addr').getBoundingClientRect(); const c = document.querySelector('.card .copy').getBoundingClientRect(); return { inside: c.left >= f.left && c.right <= f.right - 10 && c.top >= f.top && c.bottom <= f.bottom, top: c.top - f.top, gap: f.right - c.right }; })()`);
    check(`${theme}: the copy button sits inside the address box at its top right, clear of the scroll bar`, inField.inside && inField.top < 10 && inField.gap >= 12, JSON.stringify(inField));
    await js(win, `document.querySelector('.card .copy').click()`);
    await sleep(300);
    const copied = await js(win, `(() => { const t = document.querySelector('.card .tip'); return { text: t.textContent, opacity: getComputedStyle(t).opacity }; })()`);
    check(`${theme}: the copy button puts the address on the clipboard and says Copied`, (await clipboard.readText()) === 'https://example.com/Docs?a=1#top' && copied.text === 'Copied' && copied.opacity === '1', JSON.stringify([await clipboard.readText(), copied]));
    await shot(win, `workspace-link-copied-${theme}.png`);
    await sleep(1500);
    check(`${theme}: the tip goes again by itself`, (await js(win, `getComputedStyle(document.querySelector('.card .tip')).opacity`)) === '0');
    clipboard.writeText('');
    await press(win, 'Escape');
    const closed = await js(win, `({ card: !!document.querySelector('.card'), inScroller: document.getElementById('scroller').contains(document.activeElement), inert: document.querySelectorAll('[inert]').length })`);
    check(`${theme}: Esc closes the card, opens nothing, returns the keys to the document and gives back everything behind it`, !closed.card && closed.inScroller && opened.length === 0 && closed.inert === 0, JSON.stringify([closed, opened]));
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
    const longUrl = `https://invoice.example.com/i/acct_${'1HQFCaCM3YxTUEmt'.repeat(24)}?s=pd`;
    await js(win, `(() => { const a = document.createElement('a'); workspaceViewer.viewer.linkService.addLinkAttributes(a, ${JSON.stringify(longUrl)}); document.querySelector('.well').append(a); a.click(); a.remove(); })()`);
    await sleep(500);
    const long = await js(win, `(() => { const a = document.querySelector('.card .addr'); return { shown: a.textContent, scrolls: a.scrollHeight > a.clientHeight, height: a.getBoundingClientRect().height, bar: a.offsetWidth - a.clientWidth - 2, cardHeight: document.querySelector('.card').getBoundingClientRect().height }; })()`);
    check(`${theme}: a very long address is shown whole in a box that holds to 96 px and scrolls, with a thin scroll bar of its own`, long.shown === longUrl && long.scrolls && long.height <= 98 && long.bar === 10 && long.cardHeight < 260, JSON.stringify(long));
    await shot(win, `workspace-link-long-${theme}.png`);
    await press(win, 'Escape');

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

  console.log('links on a page with a form field');
  {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([595, 842]);
    page.drawText('Web page', { x: 80, y: 760, size: 16, font });
    const field = doc.getForm().createTextField('name');
    field.setText('Sam Ng');
    field.addToPage(page, { x: 80, y: 600, width: 200, height: 26 });
    page.node.set(PDFName.of('Annots'), doc.context.obj([...page.node.Annots().asArray(), doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [70, 754, 260, 780], Border: [0, 0, 0], F: 4, A: { S: 'URI', URI: PDFString.of('https://example.com/') } }))]));
    const file = path.join(root, 'Form links.pdf');
    fs.writeFileSync(file, await doc.save({ useObjectStreams: false }));
    const win = await openAndWait(fresh(), file);
    await until('the link', () => js(win, `!!document.querySelector('.linkAnnotation a')`));
    await sleep(500);
    const form = await js(win, `({ blend: getComputedStyle(document.querySelector('.annotationLayer')).mixBlendMode, bg: getComputedStyle(document.querySelector('.linkAnnotation a')).backgroundColor, field: document.querySelector('.textWidgetAnnotation input')?.value })`);
    check('on a page with a form field the links are not tinted and the field keeps its text', form.blend === 'normal' && form.bg === 'rgba(0, 0, 0, 0)' && form.field === 'Sam Ng', JSON.stringify(form));
    await closeAndWait(win);
  }

  console.log('page colours and the view that is remembered');
  {
    const plain = path.join(root, 'Plain.pdf');
    const plainDoc = await PDFDocument.create();
    plainDoc.addPage([595, 842]).drawText('Pomelo', { x: 60, y: 700, size: 90, font: await plainDoc.embedFont(StandardFonts.HelveticaBold) });
    fs.writeFileSync(plain, await plainDoc.save({ useObjectStreams: false }));
    const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
    const look = (win) => js(win, `(() => { const c = document.querySelector('.page[data-page-number="1"] canvas'); const ctx = c.getContext('2d');
      const paper = [...ctx.getImageData(Math.round(c.width * 0.03), Math.round(c.height * 0.03), 1, 1).data].slice(0, 3);
      const box = ctx.getImageData(Math.round(c.width * 0.1), Math.round(c.height * 0.09), Math.round(c.width * 0.45), Math.round(c.height * 0.075));
      let ink = paper; let far = 0;
      for (let i = 0; i < box.data.length; i += 4) { const d = Math.abs(box.data[i] - paper[0]) + Math.abs(box.data[i + 1] - paper[1]) + Math.abs(box.data[i + 2] - paper[2]); if (d > far) { far = d; ink = [box.data[i], box.data[i + 1], box.data[i + 2]]; } }
      return { paper, ink, dim: document.getElementById('viewer').classList.contains('dim') }; })()`);
    const showing = async (win, paper, ink) => { await until('the colours', async () => { const l = await look(win); return near(l.paper, rgbOf(paper), 4) && near(l.ink, rgbOf(ink), 26); }, 10000); return look(win); };
    const menuOn = async (win) => { await js(win, `document.querySelector('.dock .zoom').click()`); const on = await js(win, `[...document.querySelectorAll('.menu .mi.on')].map((n) => n.firstChild.textContent).join()`); await press(win, 'Escape'); return on; };
    const choose = async (win, text) => { await js(win, `document.querySelector('.dock .zoom').click()`); await js(win, `[...document.querySelectorAll('.menu .mi')].find((n) => n.textContent.startsWith(${JSON.stringify(text)})).click()`); };
    const card = (win) => js(win, `(() => { const c = document.querySelector('.card'); return c ? { title: c.querySelector('h3').textContent, note: c.querySelector('.note')?.textContent ?? '', labels: [...c.querySelectorAll('.kv > span')].map((n) => n.textContent).join(), groups: [...c.querySelectorAll('.swrow')].map((g) => g.children.length).join(),
      checked: [...c.querySelectorAll('.sw[aria-checked="true"]')].map((b) => b.dataset.colour).join(), buttons: [...c.querySelectorAll('.row button')].map((b) => b.textContent).join(), focused: document.activeElement.textContent, role: c.getAttribute('role'), modal: c.getAttribute('aria-modal'), labelled: !!document.getElementById(c.getAttribute('aria-labelledby')),
      behind: document.querySelector('.dockwrap').inert } : null; })()`);
    const swatch = (win, colour) => js(win, `document.querySelector('.card .sw[data-colour="${colour}"]').click()`);
    const cardButton = (win, name) => js(win, `[...document.querySelectorAll('.card .row button')].find((b) => b.textContent === ${JSON.stringify(name)}).click()`);

    settings = { pdfView: { window: null } };
    let win = await openAndWait(fresh(), plain);
    await sleep(600);
    let l = await look(win);
    check('the pages keep the colours of the file until the user chooses others', near(l.paper, [255, 255, 255], 2) && near(l.ink, [0, 0, 0], 30) && !l.dim && (await menuOn(win)) === 'Continuous,Original', JSON.stringify(l));
    await choose(win, 'Sepia');
    l = await showing(win, '#f4ecd8', '#4b3b25');
    check('Sepia draws the paper cream and the text brown, and the menu marks it', near(l.paper, rgbOf('#f4ecd8'), 4) && near(l.ink, rgbOf('#4b3b25'), 26) && !l.dim && (await menuOn(win)) === 'Continuous,Sepia', JSON.stringify(l));
    await shot(win, 'workspace-sepia.png');
    await choose(win, 'Dark');
    l = await showing(win, '#1e1e20', '#d8d8dc');
    check('Dark draws the paper dark and the text light', near(l.paper, rgbOf('#1e1e20'), 4) && near(l.ink, rgbOf('#d8d8dc'), 26) && l.dim && (await menuOn(win)) === 'Continuous,Dark', JSON.stringify(l));
    await shot(win, 'workspace-dark-pages.png');
    await sleep(600);
    check('the choice is stored once the user has stopped choosing', settings.pdfView.pageColours === 'dark', JSON.stringify(settings.pdfView));

    await choose(win, 'Custom colours');
    await sleep(500);
    let c = await card(win);
    check('Custom colours… opens a card with a page and a text colour, five of each, and Apply focused', c && c.title === 'Page colours' && !c.note && c.labels === 'Page,Text' && c.groups === '5,5' && c.checked === '#fdf6e3,#3b3b3b'
      && c.buttons === 'Cancel,Apply' && c.focused === 'Apply' && c.role === 'dialog' && c.modal === 'true' && c.labelled && c.behind === true, JSON.stringify(c));
    await shot(win, 'workspace-colours-card.png');
    await js(win, `document.querySelector('.card .sw[aria-checked="true"]').focus()`);
    await press(win, 'Right');
    check('the arrow keys move through the swatches of a row', (await card(win)).checked === '#eef3ea,#3b3b3b' && (await js(win, `document.activeElement.dataset.colour`)) === '#eef3ea');
    await swatch(win, '#1b3a8a');
    await cardButton(win, 'Apply');
    await sleep(300);
    l = await showing(win, '#eef3ea', '#1b3a8a');
    check('Apply draws the pages in the pair, closes the card and gives the keys back to the document', near(l.paper, rgbOf('#eef3ea'), 4) && near(l.ink, rgbOf('#1b3a8a'), 26) && !l.dim && !(await card(win)) && (await js(win, `document.activeElement.id`)) === 'scroller', JSON.stringify(l));
    await sleep(600);
    check('the pair is stored as #rrggbb, and the menu marks Custom colours…', JSON.stringify(settings.pdfView.pageColours) === '{"page":"#eef3ea","text":"#1b3a8a"}' && (await menuOn(win)) === 'Continuous,Custom colours…', JSON.stringify(settings.pdfView));
    await choose(win, 'Custom colours');
    await sleep(400);
    c = await card(win);
    check('the card opens on the pair in use', c.checked === '#eef3ea,#1b3a8a', JSON.stringify(c));
    await swatch(win, '#1e1e20');
    await press(win, 'Escape');
    check('Esc closes the card and changes nothing', !(await card(win)) && JSON.stringify(settings.pdfView.pageColours) === '{"page":"#eef3ea","text":"#1b3a8a"}' && near((await look(win)).paper, rgbOf('#eef3ea'), 4));
    await choose(win, 'Custom colours');
    await sleep(400);
    await swatch(win, '#1e1e20');
    await cardButton(win, 'Cancel');
    await sleep(900);
    check('Cancel changes nothing either', !(await card(win)) && JSON.stringify(settings.pdfView.pageColours) === '{"page":"#eef3ea","text":"#1b3a8a"}' && near((await look(win)).paper, rgbOf('#eef3ea'), 4));
    await choose(win, 'Original');
    l = await showing(win, '#ffffff', '#000000');
    await sleep(600);
    check('Original gives the file its own colours back', near(l.paper, [255, 255, 255], 2) && near(l.ink, [0, 0, 0], 30) && settings.pdfView.pageColours === 'original', JSON.stringify([l, settings.pdfView]));

    const before = JSON.stringify(settings.pdfView);
    await js(win, `workspaceApi.setView({ pageColours: { page: 'red', text: '#000000' }, zoom: 'huge', layout: 'sideways', sidebar: { open: 'yes' }, window: { x: 1 }, dock: 'left', other: 1 })`);
    check('the main process keeps nothing that is invalid and nothing that is not a view setting', JSON.stringify(settings.pdfView) === before, JSON.stringify(settings.pdfView));
    writes = 0;
    await js(win, `workspaceApi.setView({ pageColours: 'original' })`);
    const same = writes;
    await js(win, `workspaceApi.setView({ layout: 'spread' })`);
    await js(win, `workspaceApi.setView({ layout: 'spread' })`);
    check('a value that is already stored is not written again', same === 0 && writes === 1 && settings.pdfView.layout === 'spread', `${same} ${writes}`);
    await closeAndWait(win);

    for (const [name, pageColours, link, blend, linkText] of [['dark', 'dark', 'rgb(138, 180, 248)', 'darken', 'light blue'], ['sepia', 'sepia', 'rgb(11, 87, 208)', 'lighten', 'blue']]) {
      settings = { pdfView: { window: null, pageColours } };
      win = await openAndWait(fresh({ keepView: true }), await makeLinksPdf('Links.pdf'));
      await until('the links', () => js(win, `document.querySelectorAll('.page[data-page-number="1"] .linkAnnotation a').length >= 5`));
      await sleep(900);
      const style = await js(win, `({ bg: getComputedStyle(document.querySelector('.page[data-page-number="1"] .linkAnnotation a')).backgroundColor, blend: getComputedStyle(document.querySelector('.page[data-page-number="1"] .annotationLayer')).mixBlendMode })`);
      const rects = await js(win, `(() => { const r = document.querySelector('.page[data-page-number="1"]').getBoundingClientRect(); const at = (row) => ({ x: r.left + (80 / 595) * r.width, y: r.top + ((842 - (760 - row * 40 + 16)) / 842) * r.height, width: (110 / 595) * r.width, height: (20 / 842) * r.height }); return { linked: at(0), plain: at(2) }; })()`);
      const count = async (rect) => {
        const bytes = (await win.webContents.capturePage({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) })).toBitmap();
        const found = { blueish: 0, solid: 0, grey: 0 };
        for (let i = 0; i < bytes.length; i += 4) {
          const [b, g, r] = [bytes[i], bytes[i + 1], bytes[i + 2]];
          if (b > r + 50 && b > g + 15 && b > 150) found.blueish++;
          if (b > 150 && r < 60 && g < 100) found.solid++;
          if (name === 'dark' ? r > 150 && Math.abs(r - b) < 30 : Math.max(r, g, b) < 120) found.grey++;
        }
        return found;
      };
      const [linked, rest] = [await count(rects.linked), await count(rects.plain)];
      check(`${name} pages: a web link is ${linkText} and its box is not filled in`, style.bg === link && style.blend === blend && linked.blueish > 100 && linked.solid === 0, JSON.stringify([style, linked]));
      check(`${name} pages: a line with no link keeps the colour of the text`, rest.grey > 10 && rest.blueish < 40, JSON.stringify(rest));
      await shot(win, `workspace-links-${name}.png`);
      await closeAndWait(win);
    }

    settings = { pdfView: { window: null } };
    win = await openAndWait(fresh(), twelve);
    await sleep(900);
    await press(win, '1', ['control']);
    await press(win, '=', ['control']);
    await choose(win, 'Two pages');
    await choose(win, 'Dark');
    await js(win, `document.getElementById('pagesbtn').click()`);
    await sleep(700);
    await js(win, `document.getElementById('taboutline').click()`);
    await js(win, `document.getElementById('railgrip').focus()`);
    await press(win, 'Right');
    await press(win, 'Right');
    await sleep(900);
    const view = { ...settings.pdfView };
    delete view.window;
    check('zoom, layout, the panel and the colours are stored beside the dock and the window', view.zoom === 1.1 && view.layout === 'spread' && view.pageColours === 'dark' && JSON.stringify(view.sidebar) === '{"open":true,"tab":"outline","width":246}', JSON.stringify(settings.pdfView));
    await closeAndWait(win);
    const viewOf = () => JSON.stringify({ ...settings.pdfView, window: null });
    const stored = viewOf();
    win = await openAndWait(fresh({ keepView: true }), twelve);
    await sleep(1500);
    const d = await dockState(win);
    const p = await panelState(win);
    const o = await outlineState(win);
    l = await look(win);
    check('the next start opens as it was left: zoom, layout, the Outline tab at its width, the dark pages', d.zoom === '110%' && d.layout === 1 && Math.round(p.width) === 246 && p.pressed === 'true' && !p.hidden && o.checked === 'Pages=false,Outline=true' && near(l.paper, rgbOf('#1e1e20'), 4) && l.dim, JSON.stringify([d, p, o, l]));
    check('the panel starts open, not sliding, and opening the file writes nothing', !(await js(win, `document.getElementById('rail').classList.contains('still')`)) && viewOf() === stored, JSON.stringify(settings.pdfView));
    await shot(win, 'workspace-restored.png');
    await closeAndWait(win);

    settings = { pdfView: { window: null, zoom: 'page-width', sidebar: { open: false, tab: 'outline', width: 300 } } };
    win = await openAndWait(fresh({ keepView: true }), twelve);
    await sleep(900);
    check('a fit is restored as a fit, and a shut panel stays shut', (await dockState(win)).zoom === 'Fit width' && (await panelState(win)).pressed === 'false' && Math.round((await panelState(win)).width) === 0);
    await js(win, `document.getElementById('pagesbtn').click()`);
    await sleep(900);
    check('and opens on the tab and the width it was left at', (await outlineState(win)).checked === 'Pages=false,Outline=true' && Math.round((await panelState(win)).width) === 300);
    await closeAndWait(win);

    settings = { pdfView: { window: null, zoom: 'huge', layout: 'sideways', sidebar: { open: 'yes', tab: 'pages', width: 260 }, pageColours: { page: 'red', text: 'blue' } } };
    win = await openAndWait(fresh({ keepView: true }), twelve);
    await sleep(900);
    const bad = await dockState(win);
    l = await look(win);
    check('values the settings file should not hold are ignored on the way in', bad.zoom === 'Fit page' && bad.layout === 0 && (await panelState(win)).pressed === 'false' && near(l.paper, [255, 255, 255], 2) && !l.dim, JSON.stringify([bad, l]));
    await closeAndWait(win);
    settings = { pdfView: { window: null } };
  }

  console.log('the Links panel');
  {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const [first, second, third] = [doc.addPage([595, 842]), doc.addPage([595, 842]), doc.addPage([595, 842])];
    const link = (page, y, A) => { page.drawText('Link text', { x: 80, y, size: 14, font }); return doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [70, y - 6, 200, y + 16], Border: [0, 0, 0], F: 4, A })); };
    const uri = (u) => ({ S: 'URI', URI: PDFString.of(u) });
    first.node.set(PDFName.of('Annots'), doc.context.obj([link(first, 760, uri('https://example.com/docs?a=1')), link(first, 720, uri('mailto:team@example.com')), link(first, 640, uri('file:///C:/Windows/System32/calc.exe')), link(first, 600, { S: 'GoTo', D: [third.ref, 'Fit'] })]));
    first.drawText('Read https://plain.example.org/guide/start. for more', { x: 80, y: 680, size: 14, font });
    second.node.set(PDFName.of('Annots'), doc.context.obj([link(second, 700, uri('https://example.com/docs?a=1'))]));
    third.node.set(PDFName.of('Annots'), doc.context.obj([link(third, 120, uri('https://far.example.net/low'))]));
    const withLinks = path.join(root, 'Link list.pdf');
    fs.writeFileSync(withLinks, await doc.save({ useObjectStreams: false }));
    const ROWS = 'example.com/docs?a=1|Page 1 · 2 places ; team@example.com|Page 1 ; plain.example.org/guide/start|Page 1 ; far.example.net/low|Page 3';
    const ADDRESSES = ['https://example.com/docs?a=1', 'mailto:team@example.com', 'https://plain.example.org/guide/start', 'https://far.example.net/low'];

    for (const theme of ['light', 'dark']) {
      nativeTheme.themeSource = theme;
      opened.length = 0;
      const win = await openAndWait(fresh(), withLinks);
      const state = () => js(win, `(() => { const rows = [...document.querySelectorAll('.linkrow')]; const g = (id) => document.getElementById(id); const b = g('linksbtn');
        return { rows: rows.map((r) => r.querySelector('.linkurl').textContent + '|' + r.querySelector('.linkpage').textContent).join(' ; '), scan: g('linkscan').textContent,
          copy: g('linkcopy').textContent, copyOff: g('linkcopy').disabled, choose: g('linkchoose').hidden ? '' : g('linkchoose').title, all: g('linkchoose').getAttribute('aria-checked'), width: g('hitpanel').getBoundingClientRect().width, tabs: [...document.querySelectorAll('#hitpanel .seg3 button')].map((t) => t.textContent + '=' + t.getAttribute('aria-checked')).join(), pressed: b.getAttribute('aria-pressed'), disabled: b.disabled, title: b.title,
          picked: rows.filter((r) => r.classList.contains('on')).length, checked: rows.filter((r) => r.querySelector('.pick').getAttribute('aria-checked') === 'true').length, empty: g('linklist').querySelector('.sideempty').hidden ? '' : g('linklist').querySelector('.sideempty').textContent,
          current: workspaceViewer.viewer.currentPageNumber, bar: [...document.querySelector('.titleleft').children].map((c) => c.id).join(), focus: document.activeElement.id || document.activeElement.className, mark: document.querySelectorAll('.linkhit').length,
          kinds: rows.map((r) => (r.querySelector('.pick svg rect') ? 'mail' : 'web')).join(), now: rows.findIndex((r) => r.classList.contains('now') && r.getAttribute('aria-current') === 'true'), scanning: !g('linkprogress').hidden }; })()`);
      const clip = async () => clipboard.readText();
      const until2 = (what, fn) => until(what, async () => fn(await state()), 8000);

      let s = await state();
      check(`${theme}: the title row has a Links button after Find, with its tooltip, and the panel is shut`, s.bar === 'pagesbtn,findbtn,linksbtn' && s.title === 'Links in this document' && !s.disabled && s.pressed === 'false' && s.width === 0 && s.rows === '', JSON.stringify(s));
      await js(win, `document.getElementById('linksbtn').click()`);
      await until2('the links', (x) => x.scan === '4 links' && x.rows !== '');
      await sleep(500);
      s = await state();
      check(`${theme}: the button opens the panel on its Links tab at 300 px, with the addresses listed top to bottom, once each, with the page and an icon for the kind`, s.width === 300 && s.pressed === 'true' && s.tabs === 'Search=false,Links=true' && s.rows === ROWS && s.kinds === 'web,mail,web,web' && s.scan === '4 links' && !s.scanning && s.choose === 'Select All' && s.all === 'false' && s.empty === '' && s.now === -1, JSON.stringify(s));
      check(`${theme}: Copy is there but off, since nothing is selected`, s.copy === 'Copy' && s.copyOff, JSON.stringify(s));
      await shot(win, `workspace-linklist-${theme}.png`);

      await js(win, `document.getElementById('linkchoose').click()`);
      s = await state();
      check(`${theme}: the circle in the heading selects every row, is filled, offers Clear and Copy becomes Copy All`, s.all === 'true' && s.picked === 4 && s.checked === 4 && s.choose === 'Clear' && s.copy === 'Copy All' && !s.copyOff, JSON.stringify(s));
      await js(win, `document.getElementById('linkcopy').click()`);
      await sleep(400);
      check(`${theme}: Copy All puts every address on the clipboard, one to a line, and says Copied`, (await clip()) === ADDRESSES.join('\n') && (await state()).copy === 'Copied', await clip());
      await until2('the label back', (x) => x.copy === 'Copy All');
      check(`${theme}: and the label goes back to Copy All`, (await state()).copy === 'Copy All');
      await js(win, `document.getElementById('linkchoose').click()`);
      s = await state();
      check(`${theme}: Clear empties the selection and Copy is off again`, s.picked === 0 && s.copy === 'Copy' && s.copyOff && s.choose === 'Select All', JSON.stringify(s));

      const pick = (n) => js(win, `document.querySelectorAll('.linkrow')[${n}].querySelector('.pick').click()`);
      await pick(1);
      await pick(3);
      s = await state();
      check(`${theme}: the circle of a row selects it, the button counts the selection and the heading's circle shows a part selection`, s.all === 'mixed' && s.picked === 2 && s.checked === 2 && s.copy === 'Copy 2' && !s.copyOff && s.choose === 'Clear', JSON.stringify(s));
      await js(win, `document.getElementById('linkcopy').click()`);
      await sleep(300);
      check(`${theme}: Copy then copies only the selected ones, in the order of the list`, (await clip()) === [ADDRESSES[1], ADDRESSES[3]].join('\n'), await clip());
      await until2('the label back', (x) => x.copy === 'Copy 2');
      await pick(0);
      await pick(2);
      s = await state();
      check(`${theme}: with every row selected by hand the button reads Copy All`, s.picked === 4 && s.copy === 'Copy All', JSON.stringify(s));
      await js(win, `document.getElementById('linkchoose').click()`);

      await js(win, `document.querySelectorAll('.linkrow')[3].querySelector('.linkgo').click()`);
      await until2('page 3', (x) => x.current === 3);
      await until2('the mark', (x) => x.mark === 1);
      const where = await js(win, `(() => { const m = document.querySelector('.linkhit'); const c = document.getElementById('scroller').getBoundingClientRect(); const r = m ? m.getBoundingClientRect() : null; return { shown: !!m, inside: !!r && r.top >= c.top && r.bottom <= c.bottom, onPage: !!m && !!m.closest('.page[data-page-number="3"]'), colour: m ? getComputedStyle(m).backgroundColor : '' }; })()`);
      s = await state();
      check(`${theme}: a click on a row goes to the page of the link, lights the link in the yellow of a search hit, marks the row as the current one and gives the keys back to the document`, s.now === 3 && where.shown && where.inside && where.onPage && where.colour === 'rgba(255, 235, 59, 0.6)' && s.focus === 'scroller' && s.picked === 0, JSON.stringify([where, s]));
      await js(win, `document.querySelectorAll('.linkrow').forEach((r, i) => { if (i < 3) r.classList.add('on'); })`);
      const look = await js(win, `(() => { const rows = [...document.querySelectorAll('.linkrow')]; const css = (r) => getComputedStyle(r); const now = css(rows[3]); const other = css(rows[1]); return { now: now.backgroundColor, other: other.backgroundColor, otherOn: rows[1].classList.contains('on') }; })()`);
      check(`${theme}: the current row stands out from the selected ones, by its surface, which in the dark is a lighter grey`, look.otherOn && look.now !== look.other && (theme === 'light' || look.now === 'rgba(255, 255, 255, 0.2)'), JSON.stringify(look));
      await shot(win, `workspace-linklist-current-${theme}.png`);
      await js(win, `document.querySelectorAll('.linkrow').forEach((r, i) => { if (i < 3) r.classList.remove('on'); })`);
      await sleep(2500);
      check(`${theme}: the link stays lit`, (await state()).mark === 1);
      await js(win, `document.querySelectorAll('.linkrow')[0].querySelector('.linkgo').click()`);
      await until2('page 1', (x) => x.current === 1);
      await until2('the other mark', (x) => x.mark === 1);
      check(`${theme}: choosing another row lights that link and no other`, await js(win, `!!document.querySelector('.page[data-page-number="1"] .linkhit') && document.querySelectorAll('.linkhit').length === 1`));

      await js(win, `document.querySelectorAll('.linkrow')[0].querySelector('.linkopen').click()`);
      await sleep(400);
      const card = await js(win, `document.querySelector('.card') ? { title: document.querySelector('.card h3').textContent, address: document.querySelector('.card .addr').textContent } : null`);
      check(`${theme}: the arrow of a row asks first, with the address, like a link in the page`, card && card.title === 'Open this link?' && card.address === ADDRESSES[0] && opened.length === 0, JSON.stringify(card));
      await js(win, `[...document.querySelectorAll('.card button')].find((b) => b.textContent === 'Open').click()`);
      await sleep(400);
      check(`${theme}: Open then opens that address and no other`, JSON.stringify(opened) === JSON.stringify([ADDRESSES[0]]), JSON.stringify(opened));

      await js(win, `document.querySelectorAll('.linkrow')[0].querySelector('.linkgo').focus()`);
      await press(win, 'Down');
      check(`${theme}: Down moves to the next row`, (await js(win, `document.activeElement === document.querySelectorAll('.linkrow')[1].querySelector('.linkgo')`)));
      await press(win, 'Space');
      s = await state();
      check(`${theme}: Space selects the row in focus and goes nowhere`, s.picked === 1 && s.current === 1 && (await js(win, `document.querySelectorAll('.linkrow')[1].classList.contains('on')`)), JSON.stringify(s));
      await press(win, 'Enter', ['control']);
      await sleep(400);
      check(`${theme}: Ctrl+Enter asks to open the link in focus`, (await js(win, `document.querySelector('.card .addr')?.textContent`)) === ADDRESSES[1]);
      await press(win, 'Escape');
      await sleep(200);
      await js(win, `document.querySelectorAll('.linkrow')[0].querySelector('.linkgo').focus()`);
      await press(win, 'Escape');
      await sleep(500);
      s = await state();
      check(`${theme}: Esc in the panel shuts it, takes the light off the link and returns the keys to the document`, s.width === 0 && s.pressed === 'false' && s.focus === 'scroller' && s.mark === 0 && s.now === -1, JSON.stringify(s));
      await closeAndWait(win);
    }
    nativeTheme.themeSource = 'light';

    const win = await openAndWait(fresh(), withLinks);
    const panel = () => js(win, `({ width: document.getElementById('hitpanel').getBoundingClientRect().width, tabs: [...document.querySelectorAll('#hitpanel .seg3 button')].map((t) => t.textContent + '=' + t.getAttribute('aria-checked')).join(), links: document.getElementById('linksbtn').getAttribute('aria-pressed'),
      bar: !document.querySelector('.findbar').hidden, barFocus: document.activeElement === document.querySelector('.findbar input'), rows: document.querySelectorAll('#results .hitrow').length, field: document.querySelector('.findbar input').value, selected: document.querySelector('.findbar input').selectionStart + '-' + document.querySelector('.findbar input').selectionEnd, linksShown: !document.getElementById('linksview').hidden, searchShown: !document.getElementById('searchview').hidden, hint: document.querySelector('#results .sideempty')?.textContent ?? '' })`);
    await js(win, `document.getElementById('linksbtn').click()`);
    await sleep(900);
    let t = await panel();
    check('the Links button opens the panel on the Links tab and leaves the find bar shut', t.width === 300 && t.tabs === 'Search=false,Links=true' && t.linksShown && !t.searchShown && !t.bar && t.links === 'true', JSON.stringify(t));
    await js(win, `document.getElementById('tabsearch').click()`);
    await sleep(900);
    t = await panel();
    check('choosing the Search tab turns the find bar on, with the focus in its field, and says where the hits will be', t.tabs === 'Search=true,Links=false' && t.searchShown && !t.linksShown && t.bar && t.barFocus && t.links === 'false' && /Type in the search bar/.test(t.hint), JSON.stringify(t));
    await typeInto(win, 'Link');
    await sleep(900);
    t = await panel();
    check('and what is searched for is listed in the panel as it is typed', t.width === 300 && t.rows > 1 && t.tabs === 'Search=true,Links=false', JSON.stringify(t));
    await js(win, `document.getElementById('tablinks').click()`);
    await sleep(900);
    t = await panel();
    check('the Links tab shows the links and closes the find bar, which keeps what was typed', t.tabs === 'Search=false,Links=true' && t.linksShown && !t.bar && t.links === 'true' && t.field === 'Link', JSON.stringify(t));
    await js(win, `document.getElementById('tabsearch').click()`);
    await sleep(900);
    t = await panel();
    check('the Search tab brings the bar back with the last search in it, all selected, and its hits listed', t.tabs === 'Search=true,Links=false' && t.bar && t.barFocus && t.field === 'Link' && t.selected === '0-4' && t.rows > 1 && t.links === 'false', JSON.stringify(t));
    await typeInto(win, 'Read');
    await sleep(900);
    t = await panel();
    check('typing straight away replaces the text and the list follows', t.field === 'Read' && t.rows === 1, JSON.stringify(t));
    await js(win, `document.getElementById('tablinks').click()`);
    await sleep(900);
    await press(win, 'F', ['control']);
    await sleep(900);
    t = await panel();
    check('Ctrl+F while the Links tab is up opens the bar and brings the Search tab with it', t.tabs === 'Search=true,Links=false' && t.bar && t.field === 'Read' && t.rows === 1, JSON.stringify(t));
    await js(win, `document.getElementById('linksbtn').click()`);
    await sleep(500);
    t = await panel();
    check('the Links button on another tab switches to Links and closes the bar', t.tabs === 'Search=false,Links=true' && t.width === 300 && !t.bar, JSON.stringify(t));
    await js(win, `document.getElementById('linksbtn').click()`);
    await sleep(900);
    check('and pressed again it shuts the panel', (await panel()).width === 0);
    await js(win, `document.querySelector('.findbar input').focus()`);
    await press(win, 'Escape');
    await sleep(500);
    await js(win, `document.getElementById('tablinks').click()`);
    await sleep(900);
    await js(win, `document.getElementById('hitclose').click()`);
    await sleep(900);
    check('the close button shuts the panel and Esc in the bar closes the bar', (await panel()).width === 0 && !(await panel()).bar);
    await js(win, `document.getElementById('linksbtn').click()`);
    await sleep(900);
    await js(win, `document.getElementById('tabsearch').click()`);
    await sleep(600);
    t = await panel();
    check('choosing the Search tab turns the bar on again after it was closed', t.bar && t.barFocus && t.tabs === 'Search=true,Links=false', JSON.stringify(t));
    const kept = await js(win, `(async () => [await workspaceApi.copyLinks(['file:///x', 'https://a.test', 'javascript:1', 'https://a.test/', 5, null]), await workspaceApi.copyLinks('https://b.test'), await workspaceApi.copyLinks({ length: 1 })])()`);
    check('the main process copies only addresses that may be opened, each once, and nothing for anything that is not a list', JSON.stringify(kept) === '[1,0,0]' && (await clipboard.readText()) === 'https://a.test/', JSON.stringify(kept));
    await closeAndWait(win);

    const none = await openAndWait(fresh(), small);
    await js(none, `document.getElementById('linksbtn').click()`);
    await until('the end of the scan', () => js(none, `document.getElementById('linkscan').textContent === '' && !!document.querySelector('#linklist .sideempty') && document.querySelector('#linklist .sideempty').textContent === 'No links in this document'`));
    await sleep(500);
    const nothing = await js(none, `({ empty: document.querySelector('#linklist .sideempty').textContent, copyHidden: document.getElementById('linkcopy').hidden || getComputedStyle(document.getElementById('linkcopy')).display === 'none', choose: document.getElementById('linkchoose').hidden, rows: document.querySelectorAll('.linkrow').length, status: document.getElementById('linkscan').textContent })`);
    check('a document with no links says so, and shows nothing to select or copy', nothing.empty === 'No links in this document' && nothing.copyHidden && nothing.choose && nothing.rows === 0 && nothing.status === '', JSON.stringify(nothing));
    await closeAndWait(none);
  }

  console.log('pictures keep their own colours on coloured pages');
  {
    const bitmap = (opaqueHalf) => {
      const buffer = Buffer.alloc(60 * 60 * 4);
      for (let y = 0; y < 60; y++) for (let x = 0; x < 60; x++) buffer.set(!opaqueHalf || x < 30 ? [0, 160, 0, 255] : [0, 0, 0, 0], (y * 60 + x) * 4);
      return nativeImage.createFromBitmap(buffer, { width: 60, height: 60 }).toPNG();
    };
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    const page = doc.addPage([595, 842]);
    page.drawText('Pomelo', { x: 60, y: 760, size: 40, font });
    page.drawImage(await doc.embedPng(bitmap(true)), { x: 100, y: 500, width: 120, height: 120 });
    page.drawText('Hi', { x: 110, y: 540, size: 30, font });
    page.pushOperators(pushGraphicsState(), rectangle(300, 500, 40, 120), clip(), endPath());
    page.drawImage(await doc.embedPng(bitmap(false)), { x: 300, y: 500, width: 120, height: 120 });
    page.pushOperators(popGraphicsState());
    const file = path.join(root, 'Pictures.pdf');
    fs.writeFileSync(file, await doc.save({ useObjectStreams: false }));
    const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
    const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const GREEN = [0, 160, 0];
    const pdfPoint = (x, y) => `(() => { const r = document.querySelector('.page[data-page-number="1"]').getBoundingClientRect(); return { x: Math.round(r.left + (${x} / 595) * r.width), y: Math.round(r.top + ((842 - ${y}) / 842) * r.height) }; })()`;
    const win = await openAndWait(fresh({ keepView: true }), file);
    const sample = async (x, y) => {
      const at = await js(win, pdfPoint(x, y));
      const bytes = (await win.webContents.capturePage({ x: at.x, y: at.y, width: 1, height: 1 })).toBitmap();
      return [bytes[2], bytes[1], bytes[0]];
    };
    const layerCount = () => js(win, `document.querySelectorAll('.page[data-page-number="1"] .canvasWrapper canvas').length`);
    const dark = async (x0, y0, x1, y1) => {
      const a = await js(win, pdfPoint(x0, y1));
      const b = await js(win, pdfPoint(x1, y0));
      const bytes = (await win.webContents.capturePage({ x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y })).toBitmap();
      let n = 0;
      for (let i = 0; i < bytes.length; i += 4) if (bytes[i] < 50 && bytes[i + 1] < 50 && bytes[i + 2] < 50) n++;
      return n;
    };
    const choose = async (text) => { await js(win, `document.querySelector('.dock .zoom').click()`); await js(win, `[...document.querySelectorAll('.menu .mi')].find((n) => n.textContent.startsWith(${JSON.stringify(text)})).click()`); };
    await sleep(700);
    check('with the file\'s own colours there is one layer, the page as drawn', (await layerCount()) === 1 && near(await sample(200, 580), [255, 255, 255], 3) && near(await sample(130, 600), GREEN, 16));
    for (const [name, paperHex] of [['Sepia', '#f4ecd8'], ['Dark', '#1e1e20']]) {
      await choose(name);
      await until(`${name} layer`, async () => (await layerCount()) === 2 && near(await sample(500, 300), rgbOf(paperHex), 8), 15000);
      await sleep(500);
      const s = { picture: await sample(130, 600), seeThrough: await sample(200, 580), cropped: await sample(320, 560), outside: await sample(380, 560), paper: await sample(500, 300), textOnPicture: await dark(105, 535, 150, 575) };
      check(`${name}: a picture stays in its own colours, over a page that is recoloured`, near(s.picture, GREEN, 18) && near(s.cropped, GREEN, 18) && near(s.paper, rgbOf(paperHex), 8) && (await layerCount()) === 2, JSON.stringify(s));
      check(`${name}: the see-through part of a picture shows the paper of the page, not white, and a picture cut by a clip is cut`, near(s.seeThrough, rgbOf(paperHex), 8) && near(s.outside, rgbOf(paperHex), 8), JSON.stringify(s));
      check(`${name}: text that stands over a picture is kept as the file has it`, s.textOnPicture > 15, JSON.stringify(s));
      await shot(win, `workspace-pictures-${name.toLowerCase()}.png`);
    }
    await choose('Original');
    await until('the layer gone', async () => (await layerCount()) === 1, 15000);
    await sleep(500);
    check('Original takes the layer away and the picture is as it was', (await layerCount()) === 1 && near(await sample(130, 600), GREEN, 16) && near(await sample(200, 580), [255, 255, 255], 3));
    await closeAndWait(win);
    settings = { pdfView: { window: null } };
  }

  console.log('saving: changes, the Save button and the questions about them');
  for (const theme of ['light', 'dark']) {
    nativeTheme.themeSource = theme;
    const file = await makePdf(`Save-${theme}.pdf`, 2);
    const original = fs.readFileSync(file);
    const edited = Buffer.concat([original, Buffer.from('\n% edited\n%%EOF\n')]);
    const editedAgain = Buffer.concat([edited, Buffer.from('% edited again\n%%EOF\n')]);
    const win = await openAndWait(fresh(), file);
    const token = (await js(win, `workspaceApi.state()`)).documents[0].token;
    const put = (bytes) => js(win, `workspaceApi.putRevision(${JSON.stringify(token)}, Uint8Array.from(atob(${JSON.stringify(bytes.toString('base64'))}), (c) => c.charCodeAt(0)))`);
    const state = () => js(win, `({ dot: !document.getElementById('docdot').hidden, button: !document.getElementById('savebtn').hidden, title: document.getElementById('savebtn').title, saved: document.getElementById('docsaved').classList.contains('on') ? document.getElementById('docsaved').textContent : '',
      card: document.querySelector('.veil h3')?.textContent ?? '', buttons: [...document.querySelectorAll('.veil .row button')].map((b) => b.textContent).join(), note: document.querySelector('.veil .note')?.textContent ?? '', pages: document.querySelectorAll('.page canvas').length })`);
    let st = await state();
    check(`${theme}: a document with no changes shows no dot and no Save button`, !st.dot && !st.button && st.card === '', JSON.stringify(st));

    await put(edited);
    await until('the Save button', async () => (await state()).button);
    st = await state();
    check(`${theme}: a change shows the dot after the name and the Save button, and the file on disk is as it was`, st.dot && st.button && st.title === 'Save (Ctrl+S)' && fs.readFileSync(file).equals(original), JSON.stringify(st));

    await press(win, 's', ['control']);
    await until('the question', async () => (await state()).card !== '');
    st = await state();
    check(`${theme}: the first Save over a file asks once whether to replace it`, st.card === 'Replace the original?' && st.buttons === 'Cancel,Save a copy,Replace' && st.note === `Save over Save-${theme}.pdf, or keep it as it is and save a copy.` && fs.readFileSync(file).equals(original), JSON.stringify(st));
    await shot(win, `workspace-replace-${theme}.png`);
    await press(win, 'Escape');
    st = await state();
    check(`${theme}: Esc answers no: nothing is written and the changes are still there`, st.card === '' && st.dot && fs.readFileSync(file).equals(original), JSON.stringify(st));

    await press(win, 's', ['control']);
    await until('the question', async () => (await state()).card !== '');
    await js(win, `[...document.querySelectorAll('.veil .row button')].find((b) => b.textContent === 'Replace').click()`);
    await until('the save', async () => !(await state()).button);
    st = await state();
    check(`${theme}: Replace saves over the file, the dot and the button go and Saved shows`, fs.readFileSync(file).equals(edited) && !st.dot && !st.button && st.saved === 'Saved' && st.card === '', JSON.stringify(st));
    await shot(win, `workspace-saved-${theme}.png`);
    check(`${theme}: no program is left holding a temporary file`, fs.readdirSync(root).filter((n) => n.endsWith('.tmp')).length === 0);

    await put(editedAgain);
    await until('the Save button', async () => (await state()).button);
    await press(win, 's', ['control']);
    await until('the save', async () => !(await state()).button);
    check(`${theme}: the second Save does not ask again`, fs.readFileSync(file).equals(editedAgain) && (await state()).card === '');

    const undone = await js(win, `workspaceApi.undo(${JSON.stringify(token)})`);
    await until('the page drawn again', async () => (await state()).pages > 0 && (await state()).button);
    st = await state();
    check(`${theme}: undo gives back the earlier version, is a change to save, and the pages are drawn again`, undone.info.size === edited.length && st.button && st.pages > 0, JSON.stringify([undone, st]));
    await js(win, `workspaceApi.redo(${JSON.stringify(token)})`);
    await until('nothing to save and the pages drawn', async () => { const now = await state(); return !now.button && now.pages > 0; });

    await put(edited);
    await until('the Save button', async () => (await state()).button);

    win.close();
    await until('the question', async () => !win.isDestroyed() && (await state()).card !== '');
    st = await state();
    check(`${theme}: closing the window with changes asks first, and the window stays`, !win.isDestroyed() && st.card === `Save changes to Save-${theme}.pdf?` && st.buttons === "Cancel,Don't save,Save", JSON.stringify(st));
    await shot(win, `workspace-close-${theme}.png`);
    await press(win, 'Escape');
    check(`${theme}: Esc cancels, nothing is closed and nothing is written`, !win.isDestroyed() && (await state()).dot && fs.readFileSync(file).equals(editedAgain));
    win.close();
    await until('the question', async () => (await state()).card !== '');
    await js(win, `[...document.querySelectorAll('.veil .row button')].find((b) => b.textContent === "Don't save").click()`);
    await until('the window gone', () => win.isDestroyed());
    check(`${theme}: Don't save closes the window and leaves the file as it was`, win.isDestroyed() && fs.readFileSync(file).equals(editedAgain) && BrowserWindow.getAllWindows().length === 0);
  }

  console.log('saving a copy: it opens in place of the document');
  {
    const realSave = dialog.showSaveDialog;
    const answerWith = (target) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }); };
    const names = (win) => js(win, `workspaceApi.state()`).then((state) => state.documents.map((d) => d.name).join('|'));
    const tokenOf = async (win, name) => (await js(win, `workspaceApi.state()`)).documents.find((d) => d.name === name).token;
    const edit = (win, token, bytes) => js(win, `workspaceApi.putRevision(${JSON.stringify(token)}, Uint8Array.from(atob(${JSON.stringify(bytes.toString('base64'))}), (c) => c.charCodeAt(0)))`);
    const buttons = (win) => js(win, `({ save: !document.getElementById('savebtn').hidden, dot: !document.getElementById('docdot').hidden, tabs: document.querySelectorAll('#tabs .tab').length })`);
    for (const theme of ['light', 'dark']) {
      nativeTheme.themeSource = theme;
      const file = await makePdf(`Copy-source-${theme}.pdf`, 2);
      const other = await makePdf(`Copy-other-${theme}.pdf`, 1);
      const original = fs.readFileSync(file);
      const edited = Buffer.concat([original, Buffer.from('\n% edited\n%%EOF\n')]);
      const workspace = fresh();
      const win = await openAndWait(workspace, other);
      await workspace.open([file]);
      await until('both documents', async () => (await names(win)) === `Copy-other-${theme}.pdf|Copy-source-${theme}.pdf`);
      await edit(win, await tokenOf(win, `Copy-source-${theme}.pdf`), edited);
      await until('the Save button', async () => (await buttons(win)).save);
      const copy = path.join(root, `Copy-of-${theme}.pdf`);
      answerWith(copy);
      await press(win, 'S', ['control', 'shift']);
      await until('the copy open', async () => (await names(win)) === `Copy-other-${theme}.pdf|Copy-of-${theme}.pdf`);
      await until('the copy shown', () => js(win, `!!document.querySelector('.page[data-loaded="true"] canvas')`));
      const now = await buttons(win);
      check(`${theme}: Ctrl+Shift+S writes the copy, opens it in a tab of its own and closes the document it came from`, fs.readFileSync(copy).equals(edited) && fs.readFileSync(file).equals(original) && (await names(win)) === `Copy-other-${theme}.pdf|Copy-of-${theme}.pdf` && now.tabs === 2, JSON.stringify([await names(win), now]));
      check(`${theme}: the copy is shown, with nothing to save, and the window says its name`, win.getTitle() === `Copy-of-${theme}.pdf - Pomelo` && !now.save && !now.dot, JSON.stringify([win.getTitle(), now]));
      await closeAndWait(win);

      const alone = await makePdf(`Copy-alone-${theme}.pdf`, 1);
      const second = await openAndWait(fresh(), alone);
      await edit(second, await tokenOf(second, `Copy-alone-${theme}.pdf`), Buffer.concat([fs.readFileSync(alone), Buffer.from('\n% edited\n%%EOF\n')]));
      await until('the Save button', async () => (await buttons(second)).save);
      const lone = path.join(root, `Copy-lone-${theme}.pdf`);
      answerWith(lone);
      await press(second, 'S', ['control', 'shift']);
      await until('the copy open', async () => (await names(second)) === `Copy-lone-${theme}.pdf`);
      check(`${theme}: with the one document in the window the copy takes its place and the window stays`, !second.isDestroyed() && fs.existsSync(lone) && fs.readFileSync(lone).length > 0, JSON.stringify(await names(second)));
      await closeAndWait(second);

      const first = await makePdf(`Copy-first-${theme}.pdf`, 1);
      const target = await makePdf(`Copy-target-${theme}.pdf`, 3);
      const workspaceTwo = fresh();
      const third = await openAndWait(workspaceTwo, first);
      await workspaceTwo.open([target]);
      await until('both documents', async () => (await names(third)).split('|').length === 2);
      const wrote = Buffer.concat([fs.readFileSync(first), Buffer.from('\n% mine\n%%EOF\n')]);
      await js(third, `document.querySelector('#tabs .tab').click()`);
      await until('the first tab', async () => third.getTitle() === `Copy-first-${theme}.pdf - Pomelo`);
      await edit(third, await tokenOf(third, `Copy-first-${theme}.pdf`), wrote);
      await until('the Save button', async () => (await buttons(third)).save);
      answerWith(target);
      await press(third, 'S', ['control', 'shift']);
      await until('the document closed', async () => (await names(third)) === `Copy-target-${theme}.pdf`);
      await until('the target shown again', () => js(third, `!!document.querySelector('.page[data-loaded="true"] canvas')`));
      check(`${theme}: a copy saved over a file that is open in another tab shows that file as it is now, in that tab`, fs.readFileSync(target).equals(wrote) && third.getTitle() === `Copy-target-${theme}.pdf - Pomelo` && !(await buttons(third)).save, JSON.stringify([await names(third), third.getTitle()]));
      await closeAndWait(third);

      const closing = await makePdf(`Copy-closing-${theme}.pdf`, 1);
      const fourth = await openAndWait(fresh(), closing);
      await edit(fourth, await tokenOf(fourth, `Copy-closing-${theme}.pdf`), Buffer.concat([fs.readFileSync(closing), Buffer.from('\n% edited\n%%EOF\n')]));
      const later = path.join(root, `Copy-closing-saved-${theme}.pdf`);
      answerWith(later);
      fourth.close();
      await until('the question', () => js(fourth, `!!document.querySelector('.veil h3')`));
      await js(fourth, `[...document.querySelectorAll('.veil .row button')].find((b) => b.textContent === 'Save').click()`);
      await until('the replace question', () => js(fourth, `document.querySelector('.veil h3')?.textContent === 'Replace the original?'`));
      await js(fourth, `[...document.querySelectorAll('.veil .row button')].find((b) => b.textContent === 'Save a copy').click()`);
      await until('the window gone', () => fourth.isDestroyed());
      check(`${theme}: a copy saved while the window is closing is written and the window closes, with nothing opened`, fs.existsSync(later) && BrowserWindow.getAllWindows().length === 0);
    }
    dialog.showSaveDialog = realSave;
    nativeTheme.themeSource = 'light';
  }

  {
    const file = await makePdf('Save-and-close.pdf', 1);
    const original = fs.readFileSync(file);
    const edited = Buffer.concat([original, Buffer.from('\n% edited\n%%EOF\n')]);
    const win = await openAndWait(fresh(), file);
    const token = (await js(win, `workspaceApi.state()`)).documents[0].token;
    await js(win, `workspaceApi.putRevision(${JSON.stringify(token)}, Uint8Array.from(atob(${JSON.stringify(edited.toString('base64'))}), (c) => c.charCodeAt(0)))`);
    win.close();
    await until('the question', () => js(win, `!!document.querySelector('.veil h3')`));
    await js(win, `[...document.querySelectorAll('.veil .row button')].find((b) => b.textContent === 'Save').click()`);
    await until('the replace question', () => js(win, `document.querySelector('.veil h3')?.textContent === 'Replace the original?'`));
    await js(win, `[...document.querySelectorAll('.veil .row button')].find((b) => b.textContent === 'Replace').click()`);
    await until('the window gone', () => win.isDestroyed());
    check('Save in the question about closing saves the file and then closes the window', win.isDestroyed() && fs.readFileSync(file).equals(edited));

    const other = await makePdf('Changed-elsewhere.pdf', 1);
    const copyOf = fs.readFileSync(other);
    const second = await openAndWait(fresh(), other);
    const key = (await js(second, `workspaceApi.state()`)).documents[0].token;
    await js(second, `workspaceApi.putRevision(${JSON.stringify(key)}, Uint8Array.from(atob(${JSON.stringify(Buffer.concat([copyOf, Buffer.from('\n% mine\n%%EOF\n')]).toString('base64'))}), (c) => c.charCodeAt(0)))`);
    const theirs = Buffer.concat([copyOf, Buffer.from('\n% theirs, written by another program\n%%EOF\n')]);
    fs.writeFileSync(other, theirs);
    await press(second, 's', ['control']);
    await until('the question', () => js(second, `!!document.querySelector('.veil h3')`));
    await js(second, `[...document.querySelectorAll('.veil .row button')].find((b) => b.textContent === 'Replace').click()`);
    await until('the changed question', () => js(second, `document.querySelector('.veil h3')?.textContent.endsWith('changed by another program.')`));
    const ask = await js(second, `({ title: document.querySelector('.veil h3').textContent, buttons: [...document.querySelectorAll('.veil .row button')].map((b) => b.textContent).join() })`);
    check('a file another program changed is not saved over: the page says so and offers Cancel, Reload and Save a copy', ask.title === 'Changed-elsewhere.pdf was changed by another program.' && ask.buttons === 'Cancel,Reload,Save a copy' && fs.readFileSync(other).equals(theirs), JSON.stringify(ask));
    await js(second, `[...document.querySelectorAll('.veil .row button')].find((b) => b.textContent === 'Reload').click()`);
    await until('the change gone', async () => !(await js(second, `!document.getElementById('savebtn').hidden`)));
    check('Reload forgets the changes and the file is as the other program left it', fs.readFileSync(other).equals(theirs) && !(await js(second, `!document.getElementById('savebtn').hidden`)));
    await closeAndWait(second);
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

  console.log('the Pages grid');
  {
    const twelve = await makePdf('Grid twelve.pdf', 12);
    const second = await makePdf('Grid two.pdf', 2);
    const grid = (win) => js(win, `(() => { const g = document.querySelector('.pgrid'); const b = document.querySelector('.dock .tool'); const bar = document.querySelector('.optbar'); const cells = [...document.querySelectorAll('.cell:not(.hole):not(.leaving)')];
      return { shown: !g.hidden, organising: document.querySelector('.well').classList.contains('organising'), scroller: getComputedStyle(document.getElementById('scroller')).visibility, cells: cells.length,
        labels: cells.slice(0, 2).map((c) => c.getAttribute('aria-label')).join(), canvases: document.querySelectorAll('.cell canvas').length, selected: cells.filter((c) => c.classList.contains('sel')).map((c) => c.dataset.n).join(),
        aria: cells.filter((c) => c.getAttribute('aria-selected') === 'true').length, focused: document.activeElement.classList.contains('cell') ? document.activeElement.dataset.n : document.activeElement.id,
        stops: cells.filter((c) => c.tabIndex === 0).length, bar: bar.hidden ? '' : (() => { const s = bar.querySelector('.selchip'); return s.checkVisibility({ visibilityProperty: true }) ? s.querySelector('.count').textContent : bar.querySelector('.hint').textContent; })(), title: b.title, label: b.getAttribute('aria-label'), pressed: b.getAttribute('aria-pressed'), on: b.classList.contains('on'),
        dot: !b.querySelector('.engdot').hidden, labelWidth: b.querySelector('.lbl').getBoundingClientRect().width, tooling: document.body.classList.contains('tooling'), page: workspaceViewer.viewer.currentPageNumber,
        card: document.querySelector('.card h3')?.textContent ?? '', role: g.getAttribute('role') }; })()`);
    const centre = (win, n) => js(win, `(() => { const c = document.querySelector('.cell[data-n="${n}"] .sheet'); c.scrollIntoView({ block: 'nearest' }); const r = c.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    const click = async (win, p, modifiers = [], times = 1) => {
      win.webContents.focus();
      win.webContents.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y });
      for (let clickCount = 1; clickCount <= times; clickCount++) for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: p.x, y: p.y, button: 'left', clickCount, modifiers });
      await sleep(200);
    };
    const clickCell = async (win, n, modifiers = [], times = 1) => click(win, await centre(win, n), modifiers, times);
    const sheetsDrawn = (win, n) => until(`${n} thumbnails`, async () => (await grid(win)).canvases >= n);
    const across = (win) => js(win, `(() => { const top = document.querySelector('.cell').offsetTop; return [...document.querySelectorAll('.cell')].filter((c) => c.offsetTop === top).length; })()`);
    const openGrid = async (win, wait = 500) => { await js(win, `document.querySelector('.dock .tool').click()`); await sleep(wait); };

    for (const theme of ['light', 'dark']) {
      nativeTheme.themeSource = theme;
      const win = await openAndWait(fresh({ solid: true, hasPdfEngine: () => true }), twelve);
      win.setSize(900, 600);
      await sleep(600);
      let g = await grid(win);
      check(`${theme}: the dock has a Pages button with its key in the tooltip, not pressed, with no engine dot and no grid`, g.title === 'Pages (P)' && g.label === 'Pages' && g.pressed === 'false' && !g.dot && !g.shown && g.cells === 0 && g.role === 'listbox', JSON.stringify(g));
      await openGrid(win);
      await sheetsDrawn(win, 12);
      g = await grid(win);
      check(`${theme}: the button opens a grid of every page that takes the place of the reading view, with its name beside the icon`, g.shown && g.organising && g.scroller === 'hidden' && g.cells === 12 && g.labels === 'Page 1,Page 2' && g.pressed === 'true' && g.on && g.labelWidth > 20 && g.tooling, JSON.stringify(g));
      const ink = await js(win, `(() => { const c = document.querySelector('.cell[data-n="1"] canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let dark = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 1] < 200) dark++; return dark; })()`);
      check(`${theme}: every thumbnail is drawn, with ink on it, and the page in view has the focus as the one Tab stop`, g.canvases === 12 && g.focused === '1' && g.stops === 1 && g.selected === '' && g.bar === 'Select pages to turn, delete or extract' && ink > 500, JSON.stringify([ink, g]));
      const widths = await js(win, `[...document.querySelectorAll('.cell .sheet')].slice(0, 3).map((s) => Math.round(s.getBoundingClientRect().width)).join()`);
      check(`${theme}: a thumbnail is 160 px wide`, widths === '160,160,160', widths);

      await clickCell(win, 3);
      g = await grid(win);
      check(`${theme}: a click selects one page and the bar says so`, g.selected === '3' && g.aria === 1 && g.bar === '1 page' && g.focused === '3', JSON.stringify(g));
      await clickCell(win, 5, ['control']);
      await clickCell(win, 7, ['control']);
      g = await grid(win);
      check(`${theme}: Ctrl and a click adds a page`, g.selected === '3,5,7' && g.bar === '3 pages', JSON.stringify(g));
      await clickCell(win, 5, ['control']);
      check(`${theme}: Ctrl and a click on a selected page takes it out`, (await grid(win)).selected === '3,7');
      await clickCell(win, 9, ['shift']);
      g = await grid(win);
      check(`${theme}: Shift and a click selects from the page last clicked to this one`, g.selected === '5,6,7,8,9' || g.selected === '7,8,9', JSON.stringify(g));
      await clickCell(win, 2, ['control', 'shift']);
      g = await grid(win);
      check(`${theme}: Ctrl and Shift adds that range to what is selected`, g.aria >= 8 && g.selected.split(',').includes('2') && g.selected.split(',').includes('9'), JSON.stringify(g));
      await press(win, 'A', ['control']);
      g = await grid(win);
      check(`${theme}: Ctrl+A selects every page`, g.aria === 12 && g.bar === '12 pages', JSON.stringify(g));
      await shot(win, `workspace-grid-all-${theme}.png`);

      await js(win, `document.querySelector('.pgrid').scrollTop = 0`);
      await clickCell(win, 3);
      const hover = await centre(win, 2);
      win.webContents.sendInputEvent({ type: 'mouseMove', x: hover.x, y: hover.y });
      await sleep(400);
      const looks = await js(win, `(() => { const o = (n) => getComputedStyle(document.querySelector('.cell[data-n="' + n + '"] .sheet')).outlineColor; const c = (n) => getComputedStyle(document.querySelector('.cell[data-n="' + n + '"]'));
        return { selected: o(3), hovered: o(2), plain: o(1), label: c(3).color, plainLabel: c(1).color, weight: c(3).fontWeight, plainWeight: c(1).fontWeight, halo: getComputedStyle(document.querySelector('.cell[data-n="3"] .sheet'), '::before').content, width: getComputedStyle(document.querySelector('.cell[data-n="3"] .sheet')).outlineWidth }; })()`);
      check(`${theme}: a selected page, one the pointer is over and one that is neither each look different: one accent ring and a bold accent number, a grey ring, and nothing`,
        looks.selected !== looks.hovered && looks.hovered !== looks.plain && looks.selected !== looks.plain && looks.label !== looks.plainLabel && Number(looks.weight) > Number(looks.plainWeight) && looks.halo === 'none' && looks.width === '3px', JSON.stringify(looks));
      const image = await win.webContents.capturePage();
      const bitmap = image.toBitmap();
      const width = image.getSize().width;
      const scale = width / (await js(win, `innerWidth`));
      const pixel = (x, y) => { const i = (Math.round(y * scale) * width + Math.round(x * scale)) * 4; return [bitmap[i + 2], bitmap[i + 1], bitmap[i]]; };
      const lum = (rgb) => rgb.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
      const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
      const probe = await js(win, `(() => { const s = document.querySelector('.cell[data-n="3"] .sheet').getBoundingClientRect(); const w = document.querySelector('.well').getBoundingClientRect(); const p = document.querySelector('.cell[data-n="1"] .sheet').getBoundingClientRect();
        const h = document.querySelector('.cell[data-n="2"] .sheet').getBoundingClientRect();
        return { ring: [s.left - 4, s.top + s.height / 2], hover: [h.left - 3, h.top + h.height / 2], well: [w.left + 6, w.top + 12], plain: [p.left - 4, p.top + p.height / 2], label: getComputedStyle(document.querySelector('.cell[data-n="3"]')).color }; })()`);
      const wellPixel = pixel(...probe.well);
      const ringPixel = pixel(...probe.ring);
      const labelRgb = probe.label.match(/\d+/g).slice(0, 3).map(Number);
      check(`${theme}: the ring of a selected page is at least 3 to 1 against the area behind it, and its bold number at least 4.5 to 1`, ratio(ringPixel, wellPixel) >= 3 && ratio(labelRgb, wellPixel) >= 4.5, `ring ${ratio(ringPixel, wellPixel).toFixed(2)} label ${ratio(labelRgb, wellPixel).toFixed(2)} ${ringPixel} ${wellPixel}`);
      check(`${theme}: a page that is not selected has no ring`, ratio(pixel(...probe.plain), wellPixel) < 1.2, `${pixel(...probe.plain)} ${wellPixel}`);
      const hoverPixel = pixel(...probe.hover);
      check(`${theme}: the ring of a page under the pointer shows but is weaker than the selection ring and differs from it by more than hue (was 3.75 against 3.89 in light and 6.18 against 4.74 in dark, 1.04 and 1.31 apart)`,
        ratio(hoverPixel, wellPixel) >= 1.5 && ratio(hoverPixel, wellPixel) < ratio(ringPixel, wellPixel) && ratio(hoverPixel, ringPixel) >= 1.5 && looks.width === '3px',
        `hover ${ratio(hoverPixel, wellPixel).toFixed(2)} ring ${ratio(ringPixel, wellPixel).toFixed(2)} apart ${ratio(hoverPixel, ringPixel).toFixed(2)} ${hoverPixel}`);
      await shot(win, `workspace-grid-${theme}.png`);

      await clickCell(win, 4);
      await press(win, 'Right');
      g = await grid(win);
      check(`${theme}: Right moves to the next page and selects only it`, g.selected === '5' && g.focused === '5', JSON.stringify(g));
      const columns = await across(win);
      await press(win, 'Down');
      g = await grid(win);
      check(`${theme}: Down moves a row (${columns} pages across)`, 5 + columns <= 12 ? g.selected === String(5 + columns) && g.focused === String(5 + columns) : g.selected === '5', JSON.stringify(g));
      await press(win, 'Right', ['shift']);
      await press(win, 'Right', ['shift']);
      g = await grid(win);
      check(`${theme}: Shift and an arrow extends the selection from where it began`, g.aria === 3 && g.bar === '3 pages', JSON.stringify(g));
      const halo = await js(win, `(() => { const r = document.activeElement.querySelector('.sheet').getBoundingClientRect(); const o = document.querySelector('.cell.sel:not(:focus) .sheet').getBoundingClientRect(); return { focus: [r.left - 8, r.top + 30], gap: [r.left - 6, r.top + 30], other: [o.left - 8, o.top + 30], selected: document.activeElement.classList.contains('sel') }; })()`);
      const now = await win.webContents.capturePage();
      const nowBitmap = now.toBitmap();
      const seen = (x, y) => { const i = (Math.round(y * scale) * width + Math.round(x * scale)) * 4; return [nowBitmap[i + 2], nowBitmap[i + 1], nowBitmap[i]]; };
      check(`${theme}: the page the keyboard is on stands out inside the selection, with a ring in the text colour outside the selection ring, apart from it, that the other selected pages do not have (its ring was the selection colour, the same pixel as theirs)`,
        halo.selected && ratio(seen(...halo.focus), wellPixel) >= 3 && ratio(seen(...halo.focus), ringPixel) >= 3 && ratio(seen(...halo.gap), wellPixel) < 1.2 && ratio(seen(...halo.other), wellPixel) < 1.2,
        `focus ${ratio(seen(...halo.focus), wellPixel).toFixed(2)} against the area, ${ratio(seen(...halo.focus), ringPixel).toFixed(2)} against the selection ring, gap ${ratio(seen(...halo.gap), wellPixel).toFixed(2)} against the area, other ${ratio(seen(...halo.other), wellPixel).toFixed(2)}`);
      await shot(win, `workspace-grid-keyboard-${theme}.png`);
      await press(win, 'Home');
      g = await grid(win);
      await press(win, 'End');
      const end = await grid(win);
      check(`${theme}: Home goes to the first page and End to the last`, g.selected === '1' && g.focused === '1' && end.selected === '12' && end.focused === '12', JSON.stringify([g, end]));
      await press(win, 'Home');
      await press(win, 'Space');
      g = await grid(win);
      await press(win, 'Space');
      check(`${theme}: Space takes the focused page out of the selection and puts it back`, g.selected === '' && (await grid(win)).selected === '1', JSON.stringify(g));
      await press(win, 'Escape');
      g = await grid(win);
      const inside = await js(win, `document.getElementById('scroller').contains(document.activeElement)`);
      check(`${theme}: Esc leaves the grid for the reading view, with the keys back in the document`, !g.shown && !g.organising && g.scroller === 'visible' && g.pressed === 'false' && !g.on && !g.tooling && inside && g.cells === 0, JSON.stringify(g));
      await press(win, 'P');
      await sleep(500);
      check(`${theme}: P opens the grid again`, (await grid(win)).shown);
      await press(win, 'P');
      check(`${theme}: and P closes it`, !(await grid(win)).shown);
      await closeAndWait(win);
      forgetSize();
    }
    nativeTheme.themeSource = 'light';

    console.log('the grid: a double click, Enter, the rubber band');
    {
      const win = await openAndWait(fresh({ hasPdfEngine: () => true }), twelve);
      await openGrid(win);
      await sheetsDrawn(win, 12);
      await clickCell(win, 4, [], 2);
      let g = await grid(win);
      check('a double click on a page returns to reading at that page', !g.shown && g.page === 4 && g.pressed === 'false', JSON.stringify(g));
      await openGrid(win);
      await press(win, 'Right');
      await press(win, 'Return');
      g = await grid(win);
      check('Enter on a focused page does the same (the grid opened on page 4, Right moved to 5)', !g.shown && g.page === 5, JSON.stringify(g));

      await openGrid(win);
      const box = await js(win, `(() => { const g = document.querySelector('.pgrid').getBoundingClientRect(); return { x: Math.round(g.left + 10), y: Math.round(g.top + 10) }; })()`);
      const mouse = (type, x, y, modifiers = []) => win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, modifiers: type === 'mouseUp' ? modifiers : ['leftButtonDown', ...modifiers] });
      const dragTo = async (to, modifiers = []) => {
        mouse('mouseDown', box.x, box.y, modifiers);
        for (let i = 1; i <= 10; i++) { mouse('mouseMove', box.x + (to.x - box.x) * i / 10, box.y + (to.y - box.y) * i / 10, modifiers); await sleep(20); }
        await sleep(100);
      };
      const two = await centre(win, 2);
      const six = await centre(win, 6);
      win.webContents.focus();
      await dragTo(two);
      const during = await js(win, `(() => { const b = document.querySelector('.band'); const r = b.getBoundingClientRect(); return { shown: !b.hidden, width: Math.round(r.width), height: Math.round(r.height), selected: [...document.querySelectorAll('.cell.sel')].map((c) => c.dataset.n).join() }; })()`);
      check('a rubber band dragged from empty paper over two pages in a row draws a rectangle and selects them', during.shown && during.width > 100 && during.height > 20 && during.selected === '1,2', JSON.stringify(during));
      await shot(win, 'workspace-grid-band.png');
      mouse('mouseUp', two.x, two.y);
      await sleep(200);
      g = await grid(win);
      check('letting go keeps them selected and removes the rectangle', g.selected === '1,2' && (await js(win, `document.querySelector('.band').hidden`)) && g.bar === '2 pages', JSON.stringify(g));
      await dragTo(six);
      mouse('mouseUp', six.x, six.y);
      await sleep(200);
      const columns = await across(win);
      const wanted = [];
      for (let n = 1; n <= 6; n++) if (Math.floor((n - 1) / columns) <= Math.floor(5 / columns) && (n - 1) % columns <= 5 % columns) wanted.push(n);
      g = await grid(win);
      check(`a band over a block of pages selects the pages it touches and replaces the old selection (${columns} across)`, g.selected === wanted.join(), `${g.selected} ${wanted}`);
      await clickCell(win, 12, ['control']);
      await dragTo(two, ['control']);
      mouse('mouseUp', two.x, two.y, ['control']);
      await sleep(200);
      g = await grid(win);
      check('a band with Ctrl held adds to the selection', g.selected.split(',').includes('12') && g.selected.split(',').includes('1') && g.selected.split(',').includes('2'), g.selected);
      await click(win, box);
      g = await grid(win);
      check('a click on empty paper clears the selection and the bar shows its hint again', g.selected === '' && g.bar === 'Select pages to turn, delete or extract' && g.aria === 0, JSON.stringify(g));
      const bars = await js(win, `(() => { const l = document.querySelector('.pgrid'); return { overflow: getComputedStyle(l).overflowY, track: getComputedStyle(l).scrollbarColor }; })()`);
      check('the grid scrolls with the same thin scroll bar as the pages', bars.overflow === 'auto' && /transparent|rgba\(0, 0, 0, 0\)/.test(bars.track), JSON.stringify(bars));

      const dock = () => js(win, `(() => { const z = document.querySelector('.dock .zoom'); return { widths: [...document.querySelectorAll('.cell .sheet')].slice(0, 2).map((s) => Math.round(s.getBoundingClientRect().width)).join(), zoom: z.textContent, off: z.disabled,
        scale: workspaceViewer.viewer.currentScale, box: document.querySelector('.dock .pageno').value, reading: workspaceViewer.viewer.currentPageNumber, focused: document.activeElement.dataset?.n ?? '' }; })()`);
      const pressDock = (label) => js(win, `document.querySelector('.dock [aria-label="${label}"]').click()`);
      const reading = await dock();
      check('while the grid is up the zoom value gives the size of the pages in it and does not open the View menu', reading.zoom === '100%' && reading.off && reading.widths === '160,160', JSON.stringify(reading));
      await pressDock('Zoom in');
      await sleep(400);
      let d = await dock();
      check(`Zoom in makes the pages in the grid bigger and leaves the reading view as it was (it zoomed the hidden view, from 0.477 to 0.6, while the cells stayed 160 px)`, d.widths === '200,200' && d.zoom === '125%' && d.scale === reading.scale, JSON.stringify(d));
      for (let i = 0; i < 3; i++) await pressDock('Zoom out');
      await sleep(400);
      d = await dock();
      check('Zoom out makes them smaller, down to 120 px', d.widths === '120,120' && d.zoom === '75%' && d.scale === reading.scale, JSON.stringify(d));
      await pressDock('Zoom in');
      await clickCell(win, 2);
      await pressDock('Next page');
      await sleep(200);
      d = await dock();
      check('the page buttons move through the grid and the page box shows the page they reach, leaving the reading view where it was (Next turned the hidden view a page)', d.focused === '3' && d.box === '3' && d.reading === reading.reading && d.widths === '160,160', JSON.stringify(d));
      await press(win, 'Escape');
      await sleep(400);
      d = await dock();
      check('leaving the grid gives the zoom value and the page box back to the reading view', !d.off && (/^Fit /.test(d.zoom) || d.zoom === `${Math.round(d.scale * 100)}%`) && d.box === String(d.reading), JSON.stringify(d));
      await closeAndWait(win);
    }

    console.log('the grid: tabs, focus reading, the dock on each side');
    {
      const workspace = fresh({ hasPdfEngine: () => true });
      const win = await openAndWait(workspace, twelve);
      await workspace.open([second]);
      await sleep(1500);
      await js(win, `document.querySelectorAll('#tabs .tab')[0].click()`);
      await sleep(1000);
      await openGrid(win);
      await js(win, `document.querySelectorAll('#tabs .tab')[1].click()`);
      await sleep(1500);
      let g = await grid(win);
      check('choosing another tab leaves the grid for that tab\'s pages', !g.shown && g.cells === 0 && g.pressed === 'false' && g.scroller === 'visible', JSON.stringify(g));
      await js(win, `document.querySelectorAll('#tabs .tab')[0].click()`);
      await sleep(1500);
      await openGrid(win, 600);
      await js(win, `document.getElementById('focus').click()`);
      await until('full screen', async () => (await dockState(win)).full);
      await sleep(900);
      const wrap = await js(win, `(() => { const w = document.querySelector('.dockwrap'); const r = w.getBoundingClientRect(); return { transform: getComputedStyle(w).transform, bottom: r.bottom, height: innerHeight }; })()`);
      check('in focus reading the dock stays while the grid is up, though the pointer is not at the edge', wrap.transform === 'none' && wrap.bottom <= wrap.height, JSON.stringify(wrap));
      await press(win, 'Escape');
      await sleep(900);
      g = await grid(win);
      check('Esc leaves the grid first and focus reading second', !g.shown && (await dockState(win)).full);
      await press(win, 'Escape');
      await until('the window leaves full screen', async () => !(await dockState(win)).full);
      check('and the second Esc leaves focus reading', !(await dockState(win)).full);
      await openGrid(win, 600);
      await clickCell(win, 3);
      for (const side of ['bottom', 'top', 'left', 'right']) {
        await js(win, `document.querySelector('.well').dataset.dock = '${side}'`);
        await sleep(700);
        const place = await js(win, `(() => { const d = document.querySelector('.dock').getBoundingClientRect(); const o = document.querySelector('.optbar').getBoundingClientRect(); const w = document.querySelector('.well').getBoundingClientRect(); const s = document.querySelector('.optbar .sep').getBoundingClientRect();
          return { above: o.bottom <= d.top, below: o.top >= d.bottom, apart: o.right <= d.left || o.left >= d.right || o.bottom <= d.top || o.top >= d.bottom, inside: o.left >= w.left && o.right <= w.right && o.top >= w.top && o.bottom <= w.bottom,
            centre: Math.abs((o.left + o.right) / 2 - (d.left + d.right) / 2) < 2, wellCentre: Math.abs((o.left + o.right) / 2 - (w.left + w.right) / 2) < 2, low: Math.round(w.bottom - o.bottom), sep: Math.round(s.width) + 'x' + Math.round(s.height),
            label: document.querySelector('.dock .tool .lbl').getBoundingClientRect().width }; })()`);
        const placed = { bottom: place.above && place.centre, top: place.below && place.centre, left: place.wellCentre && place.low === 16, right: place.wellCentre && place.low === 16 }[side];
        const named = side === 'left' || side === 'right' ? place.label < 2 : place.label > 20;
        check(`with the dock at the ${side}, the bar of selected pages stands ${{ bottom: 'above it', top: 'below it', left: 'at the bottom middle, clear of the grid\'s middle (it floated across it, at y 297 to 339)', right: 'at the bottom middle' }[side]}, its divider upright (it lay flat, 22x1, beside a column), and the tool's name shows only in a row`,
          placed && place.apart && place.inside && place.sep === '1x22' && named, JSON.stringify(place));
      }
      const slide = () => js(win, `(() => { const o = document.querySelector('.optbar'); const style = getComputedStyle(o); return { y: Math.round(new DOMMatrix(style.transform).m42), opacity: Number(style.opacity), clickable: style.pointerEvents !== 'none' }; })()`);
      // The transition is read as it starts, in the frames after the click: a position sampled part way is lost on a slow runner, where the
      // whole slide can be over before the sample is taken, and there the style can change a frame after the click.
      const fold = () => js(win, `(async () => { document.querySelector('.fold').click(); const o = document.querySelector('.optbar'); const y = (f) => Math.round(new DOMMatrix(f?.transform ?? 'none').m42);
        for (let i = 0; i < 20; i++) { const style = getComputedStyle(o); const t = o.getAnimations().find((a) => a.transitionProperty === 'transform'); const k = t?.effect.getKeyframes() ?? [];
          if (t) return { ms: t.effect.getTiming().duration, from: y(k[0]), to: y(k.at(-1)) };
          if (i === 19) return { none: true, folded: document.querySelector('.dock').classList.contains('folded'), y: y(style), transition: style.transition, animations: o.getAnimations().map((a) => a.transitionProperty ?? a.animationName).join() };
          await new Promise((resolve) => requestAnimationFrame(resolve)); } })()`);
      const still = await js(win, `matchMedia('(prefers-reduced-motion: reduce)').matches`);
      for (const side of ['bottom', 'top']) {
        await js(win, `document.querySelector('.well').dataset.dock = '${side}'`);
        await sleep(700);
        const going = await fold();
        await sleep(1100);
        const away = await slide();
        const coming = await fold();
        await sleep(1200);
        const back = await slide();
        const sign = side === 'top' ? -1 : 1;
        check(`with the dock at the ${side}, hiding the controls slides the bar of selected pages away with the dock, toward that edge, as it fades, and showing them brings it back the same way (it went and came back at once)`,
          (still ? going?.none && coming?.none : going?.ms >= 400 && going.from === 0 && going.to === 130 * sign && coming?.ms >= 400 && coming.from === 130 * sign && coming.to === 0) && away.y === 130 * sign && away.opacity === 0 && !away.clickable && back.y === 0 && back.opacity === 1 && back.clickable, JSON.stringify({ still, going, away, coming, back }));
      }
      const motion = win.webContents.debugger;
      if (!motion.isAttached()) motion.attach('1.3');
      await motion.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await js(win, `document.querySelector('.well').dataset.dock = 'bottom'`);
      await sleep(700);
      const calm = { going: await fold() };
      await sleep(300);
      calm.away = await slide();
      calm.dock = await js(win, `getComputedStyle(document.querySelector('.dock')).transitionDuration`);
      calm.coming = await fold();
      await sleep(300);
      calm.back = await slide();
      check('with reduced motion the dock and the bar go and come back without sliding (they slid away and jumped back)', calm.going?.none && calm.away.y === 130 && calm.coming?.none && calm.back.y === 0 && calm.dock === '0s', JSON.stringify(calm));
      await motion.sendCommand('Emulation.setEmulatedMedia', { features: [] });
      motion.detach();
      await js(win, `document.querySelector('.well').dataset.dock = 'bottom'`);
      win.setSize(900, 600);
      await js(win, `document.getElementById('pagesbtn').click(); document.getElementById('docbtn').click()`);
      await sleep(1200);
      await press(win, 'A', ['control']);
      for (const side of ['bottom', 'left']) {
        await js(win, `document.querySelector('.well').dataset.dock = '${side}'`);
        await sleep(900);
        const fit = await js(win, `(() => { const w = document.querySelector('.well').getBoundingClientRect(); const box = (s) => document.querySelector(s).getBoundingClientRect(); const within = (r) => r.left >= w.left && r.right <= w.right && r.top >= w.top && r.bottom <= w.bottom;
          const o = box('.optbar'); const d = box('.dock'); const f = box('.fold'); const meet = (a, b) => !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
          return { well: Math.round(w.width), bar: within(o), dock: within(d), fold: within(f), clear: !meet(o, d) && !meet(o, f) && !meet(d, f), words: getComputedStyle(document.querySelector('.optbar .opt')).fontSize }; })()`);
        check(`at 900 x 600 with both side panels open (${fit.well} px between them) and the dock at the ${side}, the bar keeps its buttons as icons, and the bar, the dock and its fold button are all inside the area without meeting (the bar was cut by 128 and 149 px, the dock by 21 px with its fold button hidden)`,
          fit.bar && fit.dock && fit.fold && fit.clear && fit.words === '0px', JSON.stringify(fit));
        if (side === 'bottom') await shot(win, 'workspace-grid-narrow.png');
      }
      await js(win, `document.querySelector('.well').dataset.dock = 'bottom'`);
      await closeAndWait(win);
    }

    console.log('the grid: a big file draws only what is in view');
    {
      const big = await makePdf('Grid big.pdf', 3000);
      const win = await openAndWait(fresh({ hasPdfEngine: () => true }), big);
      await openGrid(win, 1500);
      const first = await js(win, `({ cells: document.querySelectorAll('.cell').length, canvases: document.querySelectorAll('.cell canvas').length })`);
      await js(win, `document.querySelector('.pgrid').scrollTop = document.querySelector('.pgrid').scrollHeight`);
      await sleep(2500);
      const last = await js(win, `({ canvases: document.querySelectorAll('.cell canvas').length, end: !!document.querySelector('.cell[data-n="3000"] canvas') })`);
      check(`3 000 pages make 3 000 cells but draw only the few in view (${first.canvases} at the start, ${last.canvases} at the end)`, first.cells === 3000 && first.canvases > 0 && first.canvases < 80 && last.canvases < 80 && last.end, JSON.stringify([first, last]));
      await js(win, `document.querySelector('.cell[data-n="3000"]').click()`);
      await press(win, 'A', ['control']);
      check('Ctrl+A on 3 000 pages selects them all', (await js(win, `document.querySelectorAll('.cell.sel').length`)) === 3000 && (await grid(win)).bar === '3000 pages');
      await closeAndWait(win);
      fs.rmSync(big, { force: true });
    }

    console.log('the grid without the PDF engine');
    {
      let installed = false;
      const asked = [];
      const outcomes = [{ ok: false, message: 'There is no network connection' }, { ok: true }];
      const workspace = fresh({
        hasPdfEngine: () => installed,
        installEngine: async (key, onNote) => {
          asked.push(key);
          onNote('Downloading 40%', 0.4);
          await sleep(1500);
          const outcome = outcomes.shift();
          installed = outcome.ok;
          return outcome;
        },
      });
      const win = await openAndWait(workspace, twelve);
      await sleep(500);
      let g = await grid(win);
      check('the Pages button carries a small dot while the engine is missing', g.dot && g.title === 'Pages (P)', JSON.stringify(g));
      const mark = calls.length;
      await openGrid(win, 600);
      g = await grid(win);
      const card = await js(win, `(() => { const c = document.querySelector('.card'); return { text: c.querySelector('.note').textContent, buttons: [...c.querySelectorAll('.row button')].map((b) => b.textContent).join(), focus: document.activeElement.textContent, modal: c.getAttribute('aria-modal') }; })()`);
      check('without the engine the button opens one card, and no grid', !g.shown && g.card === 'Editing needs the PDF engine' && card.text === 'A one-time download. It runs on this PC and works offline.' && card.buttons === 'Not now,Install' && card.focus === 'Install' && card.modal === 'true', JSON.stringify([g, card]));
      await shot(win, 'workspace-grid-engine-card.png');
      await js(win, `[...document.querySelectorAll('.card button')].find((b) => b.textContent === 'Not now').click()`);
      await sleep(300);
      g = await grid(win);
      check('Not now closes the card and leaves the reading view, the dot and the document as they were', !g.shown && g.card === '' && g.dot && g.scroller === 'visible' && asked.length === 0, JSON.stringify(g));
      await press(win, 'P');
      await sleep(500);
      check('the P key shows the same card', (await grid(win)).card === 'Editing needs the PDF engine');
      await press(win, 'Escape');
      await sleep(300);
      check('and Esc is Not now', (await grid(win)).card === '');
      await openGrid(win, 400);
      await js(win, `[...document.querySelectorAll('.card button')].find((b) => b.textContent === 'Install').click()`);
      await sleep(500);
      const working = await js(win, `(() => { const c = document.querySelector('.card'); const b = [...c.querySelectorAll('.row button')]; return { note: c.querySelector('.note').textContent, disabled: b.map((x) => x.disabled).join(), spinning: !!c.querySelector('.row .spin'), meter: !c.querySelector('.meter').hidden, done: c.querySelector('.meter .scanline').style.getPropertyValue('--done') }; })()`);
      check('Install asks for the PDF engine and shows its progress inside the card, with both buttons resting', asked.join() === 'pdf' && working.note === 'Downloading 40%' && working.disabled === 'true,true' && working.spinning && working.meter && working.done === '40%', JSON.stringify(working));
      await press(win, 'Escape');
      check('Esc does not close the card while it installs', (await grid(win)).card === 'Editing needs the PDF engine');
      await shot(win, 'workspace-grid-engine-installing.png');
      await sleep(1500);
      const failed = await js(win, `(() => { const c = document.querySelector('.card'); return { message: c.querySelector('.emsg p').textContent, shown: c.querySelector('.emsg').classList.contains('on'), button: [...c.querySelectorAll('.row button')].map((b) => b.textContent + (b.disabled ? '!' : '')).join(), meter: c.querySelector('.meter').hidden, note: c.querySelector('.note').textContent }; })()`);
      check('a failed install says why in the card and offers Retry', failed.message === 'There is no network connection' && failed.shown && failed.button === 'Not now,Retry' && failed.meter && failed.note === 'A one-time download. It runs on this PC and works offline.' && !installed, JSON.stringify(failed));
      await shot(win, 'workspace-grid-engine-failed.png');
      await js(win, `[...document.querySelectorAll('.card button')].find((b) => b.textContent === 'Retry').click()`);
      await until('the card to close', async () => (await grid(win)).card === '', 8000);
      await sleep(600);
      g = await grid(win);
      check('when it installs, the card closes and the grid opens at once, with no restart and no dot', asked.join() === 'pdf,pdf' && g.shown && g.cells === 12 && !g.dot && g.pressed === 'true', JSON.stringify(g));
      const ran = calls.slice(mark).map((c) => c.channel).filter((c) => ['pdfws:apply', 'pdfws:put-revision', 'pdfws:save'].includes(c));
      check('none of this changed the document', ran.length === 0 && (await js(win, `document.getElementById('savebtn').hidden`)), ran.join());
      await closeAndWait(win);
    }

    console.log('the grid: turning, deleting and moving pages');
    if (!detectEngines().pdf) console.log('  PDF engine not installed: skipped');
    else {
      const reading = (win, code) => Promise.race([js(win, code), new Promise((resolve) => setTimeout(() => resolve(''), 3000))]);
      const pages = (win) => reading(win, `(async () => { const d = workspaceViewer.viewer.pdfDocument; if (!d) return ''; const out = []; for (let i = 1; i <= d.numPages; i++) out.push((await (await d.getPage(i)).getTextContent()).items.map((x) => x.str).join('').match(/page (\\d+)/)[1]); return out.join(','); })()`);
      const turns = (win) => reading(win, `(async () => { const d = workspaceViewer.viewer.pdfDocument; if (!d) return ''; const out = []; for (let i = 1; i <= Math.min(d.numPages, 12); i++) out.push((await d.getPage(i)).rotate); return out.join(','); })()`);
      const bar = (win) => js(win, `(() => { const b = document.querySelector('.optbar'); const buttons = [...b.querySelectorAll('button:not(.mi)')].filter((x) => x.checkVisibility({ visibilityProperty: true })); return { shown: !b.hidden, titles: buttons.map((x) => x.title).join('|'), disabled: buttons.map((x) => x.disabled ? 1 : 0).join(''),
        count: (() => { const s = b.querySelector('.selchip'); return s.checkVisibility({ visibilityProperty: true }) ? s.querySelector('.count').textContent : b.querySelector('.hint').textContent; })(), busy: document.querySelector('.pgrid').classList.contains('busy'), save: !document.getElementById('savebtn').hidden, cells: document.querySelectorAll('.cell:not(.hole):not(.leaving)').length, shape: [...document.querySelectorAll('.cell:not(.hole):not(.leaving)')].map((c) => c.style.getPropertyValue('--r') < 1 ? 'w' : 't').join('') }; })()`);
      const settled = (win) => until('the change to be read back', () => js(win, `(() => { const g = document.querySelector('.pgrid'); return !g.hidden && !g.classList.contains('busy') && document.querySelectorAll('.cell').length > 0 && document.querySelectorAll('.cell canvas').length > 0; })()`));
      const push = (win, name) => js(win, `[...document.querySelectorAll('.optbar button')].find((b) => b.getAttribute('aria-label') === ${JSON.stringify(name)}).click()`);
      const mouse = (win, type, p, modifiers = []) => win.webContents.sendInputEvent({ type, x: Math.round(p.x), y: Math.round(p.y), button: 'left', clickCount: 1, modifiers: type === 'mouseUp' ? modifiers : ['leftButtonDown', ...modifiers] });
      const edge = async (win, n, side) => { const c = await centre(win, n); return js(win, `(() => { const r = document.querySelector('.cell[data-n="${n}"] .sheet').getBoundingClientRect(); return { x: ${side === 'left'} ? r.left + 10 : r.right - 10, y: ${c.y} }; })()`); };
      // Presses page `from`, pulls to the left or right half of page `n` as the grid has it once the others have made way, and lets go
      // unless asked not to. Resolves when it let go.
      const frames = (win) => js(win, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
      const pull = async (win, from, [side, n], { release = true } = {}) => {
        win.webContents.focus();
        await edge(win, n, side);
        const start = await centre(win, from);
        await frames(win);
        await sleep(150);
        mouse(win, 'mouseMove', start);
        mouse(win, 'mouseDown', start);
        const to = await edge(win, n, side);
        await sleep(150);
        for (let i = 1; i <= 8; i++) { mouse(win, 'mouseMove', { x: start.x + (to.x - start.x) * i / 8, y: start.y + (to.y - start.y) * i / 8 }); await sleep(25); }
        await sleep(350);
        const end = await edge(win, n, side);
        await frames(win);
        await sleep(150);
        mouse(win, 'mouseMove', end);
        await sleep(150);
        if (!release) return null;
        mouse(win, 'mouseUp', end);
        return Date.now();
      };
      const applied = () => calls.filter((c) => c.channel === 'pdfws:apply').length;
      const frame = (win) => js(win, `(() => { const b = document.querySelector('.optbar'); const u = [...b.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === 'Undo').getBoundingClientRect(); return { width: Math.round(b.getBoundingClientRect().width), undo: Math.round(u.left), shown: !b.hidden }; })()`);
      const watching = (win, least) => js(win, `(() => { window.__blank = 0; window.__first = document.querySelector('.cell[data-n="1"]'); cancelAnimationFrame(window.__tick); const tick = () => { if (document.querySelectorAll('.cell canvas').length < ${least}) window.__blank++; window.__tick = requestAnimationFrame(tick); }; tick(); })()`);
      const watched = (win) => js(win, `({ blank: window.__blank, kept: document.querySelector('.cell[data-n="1"]') === window.__first && window.__first.isConnected })`);
      const changed = (win, wanted) => until(`the pages to be ${wanted}`, async () => (await pages(win)) === wanted);

      for (const theme of ['light', 'dark']) {
        nativeTheme.themeSource = theme;
        const file = await makePdf('Grid change.pdf', 12);
        const win = await openAndWait(fresh({ solid: true }), file);
        win.setSize(900, 600);
        await sleep(600);
        await openGrid(win);
        await sheetsDrawn(win, 12);
        let b = await bar(win);
        const empty = await frame(win);
        check(`${theme}: with nothing selected the bar has Add, Split…, a hint and Undo and Redo, which are off`, b.shown && b.titles === 'Add|Split…|Undo (Ctrl+Z)|Redo (Ctrl+Y)' && b.disabled === '0011' && b.count === 'Select pages to turn, delete or extract', JSON.stringify(b));
        const hintLook = await inkContrast(win, '.optbar .hint');
        check(`${theme}: the hint fits its place in the bar and reads at ${hintLook.ratio.toFixed(2)}:1, at least 4.5`, hintLook.text <= hintLook.box && hintLook.ratio >= 4.5, JSON.stringify(hintLook));

        await press(win, 'Right');
        const focus = await js(win, `(() => { const c = document.activeElement; const s = c.querySelector('.sheet'); return { cell: c.classList.contains('cell'), box: getComputedStyle(c).outlineStyle, ring: getComputedStyle(s).outlineStyle, halo: getComputedStyle(s, '::before').border, inset: getComputedStyle(s, '::before').inset, text: getComputedStyle(document.body).color, focusVisible: c.matches(':focus-visible') }; })()`);
        check(`${theme}: a page reached with the keyboard has its selection ring and, outside it, a ring in the text colour, with no box round the sheet and its number`, focus.cell && focus.focusVisible && focus.box === 'none' && focus.ring === 'solid' && focus.halo === `2px solid ${focus.text}` && focus.inset === '-9px', JSON.stringify(focus));
        await clickCell(win, 3);
        await clickCell(win, 5, ['control']);
        b = await bar(win);
        check(`${theme}: with pages selected the hint gives way to a chip naming them, beside turning, extracting and deleting, all on, and undo and redo are still off`, b.titles === 'Add|Split…|Clear the selection|Rotate left|Rotate right|Extract|Delete (Del)|Undo (Ctrl+Z)|Redo (Ctrl+Y)' && b.disabled === '000000011' && b.count === '2 pages', JSON.stringify(b));
        const full = await frame(win);
        check(`${theme}: selecting pages does not change the bar's width or move Undo and Redo (${full.width} px, Undo at ${full.undo} px, as with nothing selected)`, full.width === empty.width && full.undo === empty.undo, JSON.stringify([empty, full]));
        const chipLook = await inkContrast(win, '.optbar .selchip .count');
        check(`${theme}: the count in the chip fits and reads at ${chipLook.ratio.toFixed(2)}:1, at least 4.5`, chipLook.text <= chipLook.box && chipLook.ratio >= 4.5, JSON.stringify(chipLook));
        const before = applied();
        await js(win, `document.querySelector('.cell[data-n="2"]').__kept = true; window.__wiggles = 0; (() => { const original = Element.prototype.animate; Element.prototype.animate = function (keys, options) { if (Array.isArray(keys) && keys.some((k) => String(k.transform ?? '').includes('translateX'))) window.__wiggles++; return original.call(this, keys, options); }; })()`);
        await watching(win, 12);
        await push(win, 'Rotate right');
        const working = await js(win, `({ busy: document.querySelector('.pgrid').classList.contains('busy'), aria: document.querySelector('.pgrid').getAttribute('aria-busy'), dims: getComputedStyle(document.querySelector('.pgrid .cells')).transitionDelay, look: [...document.querySelectorAll('.optbar button:not(.mi)')].map((x) => getComputedStyle(x).opacity + (x.disabled ? 'off' : '')).join(), shown: !document.querySelector('.optbar').hidden })`);
        check(`${theme}: while the engine works the grid is marked busy, also for screen readers, its pages fade if it takes longer than 0.4 s (there was only the cursor), and the bar keeps its look, with only the buttons that have nothing to do dimmed`, working.busy && working.aria === 'true' && working.dims === '0.4s' && working.shown && working.look === '1,1,1,1,1,1,1,0.35off,0.35off', JSON.stringify(working));
        await settled(win);
        await until('the turned pages to be drawn turned', async () => (await bar(win)).shape === 'ttwtwttttttt');
        b = await bar(win);
        let selected = (await grid(win)).selected;
        check(`${theme}: Rotate right turns the two pages, the grid is built again with them still selected, and the file has changes to save`, applied() === before + 1 && (await turns(win)) === '0,0,90,0,90,0,0,0,0,0,0,0' && b.shape === 'ttwtwttttttt' && selected === '3,5' && b.save && b.disabled === '000000001', JSON.stringify([await turns(win), b, selected]));
        await shot(win, `workspace-grid-changed-${theme}.png`);
        let seenNow = await watched(win);
        check(`${theme}: turning the pages did not blank the grid or build it again (no frame with fewer pictures than before, the same cells kept)`, seenNow.blank === 0 && seenNow.kept && (await js(win, `document.querySelector('.cell[data-n="2"]').__kept === true`)), JSON.stringify(seenNow));
        await push(win, 'Rotate left');
        await settled(win);
        await until('the pages to be drawn upright', async () => (await bar(win)).shape === 'tttttttttttt');
        check(`${theme}: Rotate left turns them back, and with the pages as they were opened there is nothing left to save`, (await turns(win)) === '0,0,0,0,0,0,0,0,0,0,0,0' && (await bar(win)).shape === 'tttttttttttt' && !(await bar(win)).save, JSON.stringify(await bar(win)));
        await push(win, 'Undo');
        await settled(win);
        check(`${theme}: Undo brings the turn back, with redo on`, (await turns(win)) === '0,0,90,0,90,0,0,0,0,0,0,0' && (await bar(win)).disabled === '0000');
        await press(win, 'Z', ['control']);
        await settled(win);
        check(`${theme}: Ctrl+Z goes back once more, to the file as it was opened, and there is nothing left to save`, (await turns(win)) === '0,0,0,0,0,0,0,0,0,0,0,0' && !(await bar(win)).save && (await bar(win)).disabled === '0010');
        await press(win, 'Y', ['control']);
        await settled(win);
        check(`${theme}: Ctrl+Y does the turn again`, (await turns(win)) === '0,0,90,0,90,0,0,0,0,0,0,0');
        await press(win, 'Z', ['control']);
        await settled(win);

        await clickCell(win, 3);
        await push(win, 'Rotate right');
        await settled(win);
        await push(win, 'Rotate right');
        await settled(win);
        const undone = calls.filter((c) => c.channel === 'pdfws:undo').length;
        const beforeSpam = await frame(win);
        for (let i = 0; i < 4; i++) await push(win, 'Undo');
        await until('the presses to be worked through', async () => (await turns(win)) === '0,0,0,0,0,0,0,0,0,0,0,0' && (await bar(win)).shape === 'tttttttttttt' && !(await bar(win)).busy);
        await settled(win);
        const afterSpam = await frame(win);
        check(`${theme}: four quick presses on Undo after two turns step back twice and stop at the file as it was opened, the bar staying where it was (${beforeSpam.width} px, Undo at ${beforeSpam.undo} px)`, calls.filter((c) => c.channel === 'pdfws:undo').length === undone + 2 && !(await bar(win)).save && afterSpam.width === beforeSpam.width && afterSpam.undo === beforeSpam.undo && afterSpam.shown, JSON.stringify([beforeSpam, afterSpam, await bar(win)]));

        await clickCell(win, 2);
        await watching(win, 11);
        await press(win, 'Delete');
        await js(win, `new Promise((resolve) => setTimeout(resolve, 0))`);
        const closing = await js(win, `({ leaving: document.querySelectorAll('.cell.leaving').length, left: document.querySelectorAll('.cell:not(.leaving)').length })`);
        await changed(win, '1,3,4,5,6,7,8,9,10,11,12');
        await settled(win);
        b = await bar(win);
        selected = await grid(win);
        check(`${theme}: Delete takes the selected page out, nothing is selected after it and the page that took its place has the focus`, (await pages(win)) === '1,3,4,5,6,7,8,9,10,11,12' && b.cells === 11 && selected.selected === '' && selected.focused === '2' && b.save, JSON.stringify([b, selected]));
        seenNow = await watched(win);
        check(`${theme}: the grid shows the deletion at once, the page fading where it was while the others close up, and never blanks (${JSON.stringify(closing)})`, closing.left === 11 && closing.leaving <= 1 && seenNow.blank === 0, JSON.stringify([closing, seenNow]));
        await push(win, 'Undo');
        await changed(win, '1,2,3,4,5,6,7,8,9,10,11,12');
        check(`${theme}: Undo puts the page back where it was`, (await bar(win)).cells === 12);
        await press(win, 'A', ['control']);
        const asked = applied();
        await press(win, 'Delete');
        await sleep(300);
        const card = await js(win, `({ title: document.querySelector('.card h3')?.textContent ?? '', buttons: [...document.querySelectorAll('.card .row button')].map((x) => x.textContent).join() })`);
        check(`${theme}: deleting every page is refused with a card, and nothing is sent to the engine`, card.title === 'A PDF needs at least one page' && card.buttons === 'OK' && applied() === asked, JSON.stringify(card));
        await js(win, `[...document.querySelectorAll('.card button')].find((x) => x.textContent === 'OK').click()`);
        await sleep(300);
        check(`${theme}: OK closes it and the keys are back in the grid`, (await grid(win)).card === '' && (await grid(win)).focused === '2' && (await grid(win)).selected.split(',').length === 12, JSON.stringify(await grid(win)));

        await clickCell(win, 2);
        const ring = await js(win, `getComputedStyle(document.querySelector('.cell[data-n="2"] .sheet')).outlineColor`);
        await js(win, `window.__wiggles = 0`);
        await watching(win, 12);
        await pull(win, 2, ['left', 5], { release: false });
        const moving = await js(win, `(() => { const h = document.querySelector('.cell.hole'); const g = document.querySelector('.ghost'); const sheet = h?.querySelector('.sheet'); const style = sheet && getComputedStyle(sheet); const other = document.querySelector('.cell[data-n="3"] .sheet').getBoundingClientRect();
          return { hole: !!h, before: h?.nextElementSibling?.dataset.n ?? '', text: sheet?.textContent ?? '', dashed: style?.borderTopStyle ?? '', border: style?.borderTopColor ?? '', fits: !!sheet && Math.abs(sheet.getBoundingClientRect().width - other.width) < 1.5 && Math.abs(sheet.getBoundingClientRect().height - other.height) < 1.5,
            lifted: [...document.querySelectorAll('.cell.lifted')].map((x) => x.dataset.n).join(), hidden: getComputedStyle(document.querySelector('.cell[data-n="2"]')).display, ghost: !!g, drawn: g ? g.querySelectorAll('canvas').length : 0, ghostFits: !!g && Math.abs(g.getBoundingClientRect().width - other.width) < 8,
            cursor: getComputedStyle(document.querySelector('.pgrid')).cursor, shaken: window.__wiggles, line: !!document.querySelector('.slot') }; })()`);
        check(`${theme}: pulling page 2 over the left half of page 5 takes it out of the grid, opens a dashed Drop here space the size of a page before page 5, and a copy of the page follows the pointer`, moving.hole && moving.before === '5' && moving.text === 'Drop here' && moving.dashed === 'dashed' && moving.fits && moving.lifted === '2' && moving.hidden === 'none' && moving.ghost && moving.drawn === 1 && moving.ghostFits && moving.cursor === 'grabbing' && !moving.line, JSON.stringify(moving));
        check(`${theme}: the dashed edge of the space is the selection colour, and the pages that made way shook from side to side (${moving.shaken} shakes)`, moving.border === ring && moving.shaken > 0, JSON.stringify([moving.border, ring, moving.shaken]));
        await shot(win, `workspace-grid-moving-${theme}.png`);
        mouse(win, 'mouseUp', await edge(win, 5, 'left'));
        await changed(win, '1,3,4,2,5,6,7,8,9,10,11,12');
        await settled(win);
        selected = await grid(win);
        seenNow = await watched(win);
        check(`${theme}: letting go moves the page in front of page 5, it stays selected where it landed, and the grid was never blank or built again`, selected.selected === '4' && selected.focused === '4' && selected.cells === 12 && seenNow.blank === 0 && seenNow.kept && (await js(win, `!document.querySelector('.cell.hole') && !document.querySelector('.ghost')`)), JSON.stringify([selected, seenNow]));

        const mark = applied();
        await pull(win, 4, ['left', 5]);
        await sleep(400);
        check(`${theme}: dropping a page where it already is changes nothing`, applied() === mark && (await pages(win)) === '1,3,4,2,5,6,7,8,9,10,11,12');
        await clickCell(win, 1);
        await clickCell(win, 2, ['shift']);
        await pull(win, 1, ['right', 12]);
        await changed(win, '4,2,5,6,7,8,9,10,11,12,1,3');
        await settled(win);
        check(`${theme}: two selected pages move together, in their order, to the end when dropped on the right half of the last page`, (await grid(win)).selected === '11,12', JSON.stringify(await grid(win)));

        await clickCell(win, 3);
        const cancelled = applied();
        await pull(win, 3, ['left', 8], { release: false });
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
        mouse(win, 'mouseUp', await edge(win, 8, 'left'));
        await sleep(500);
        const open = await grid(win);
        check(`${theme}: Esc in the middle of a pull puts the page down where it was, and the grid stays open`, applied() === cancelled && open.shown && (await pages(win)) === '4,2,5,6,7,8,9,10,11,12,1,3' && (await js(win, `document.querySelectorAll('.cell.lifted').length + (document.querySelector('.cell.hole') ? 10 : 0) + (document.querySelector('.ghost') ? 100 : 0)`)) === 0, JSON.stringify(open));
        await clickCell(win, 11);
        await clickCell(win, 12, ['shift']);
        await pull(win, 11, ['left', 1]);
        await changed(win, '1,3,4,2,5,6,7,8,9,10,11,12');
        await settled(win);
        check(`${theme}: the two pages moved back to the front still leave the second page out of its place, so there is something to save`, (await bar(win)).save, JSON.stringify(await bar(win)));
        await pull(win, 4, ['left', 2]);
        await changed(win, '1,2,3,4,5,6,7,8,9,10,11,12');
        await settled(win);
        check(`${theme}: moving the page back where it was leaves the pages as they were opened, and the Save button goes`, !(await bar(win)).save && (await bar(win)).disabled === '000000001', JSON.stringify(await bar(win)));
        await clickCell(win, 3);
        await press(win, 'Right', ['control', 'shift']);
        await changed(win, '1,2,4,3,5,6,7,8,9,10,11,12');
        await settled(win);
        let keyed = await grid(win);
        check(`${theme}: Ctrl+Shift+Right moves the selected page one place on, and it keeps the selection and the focus (pages could only be moved with the pointer)`, keyed.selected === '4' && keyed.focused === '4', JSON.stringify(keyed));
        await press(win, 'Home', ['control', 'shift']);
        await changed(win, '3,1,2,4,5,6,7,8,9,10,11,12');
        await settled(win);
        keyed = await grid(win);
        check(`${theme}: Ctrl+Shift+Home moves it to the front`, keyed.selected === '1' && keyed.focused === '1', JSON.stringify(keyed));
        const still = applied();
        await press(win, 'Left', ['control', 'shift']);
        await sleep(400);
        check(`${theme}: Ctrl+Shift+Left on the first page changes nothing`, applied() === still && (await pages(win)) === '3,1,2,4,5,6,7,8,9,10,11,12');
        win.destroy();
        await sleep(500);
        forgetSize();
      }
      nativeTheme.themeSource = 'light';

      console.log('the grid: a change that fails, and a file that was changed by another program');
      {
        const file = await makePdf('Grid fails.pdf', 12);
        const win = await openAndWait(fresh({ runPdfTool: async () => { throw new Error('This PDF has a problem'); } }), file);
        await openGrid(win);
        await sheetsDrawn(win, 12);
        await clickCell(win, 4);
        notices.length = 0;
        await push(win, 'Rotate left');
        await until('the notice', async () => notices.length > 0, 5000);
        await sleep(300);
        const b = await bar(win);
        check('a change the engine cannot make says so in the corner and leaves the grid as it was, with the page still selected and the bar on again', notices.at(-1)?.title === "Can't make this change" && notices.at(-1).detail === 'This PDF has a problem' && !b.busy && b.disabled === '000000011' && (await grid(win)).selected === '4' && !b.save, JSON.stringify([notices, b]));
        notices.length = 0;
        await closeAndWait(win);
      }

      console.log('the grid: inserting and extracting pages');
      {
        const picture = (name, colour) => {
          const buffer = Buffer.alloc(80 * 40 * 4);
          for (let i = 0; i < 80 * 40; i++) buffer.set([...colour, 255], i * 4);
          const file = path.join(root, name);
          fs.writeFileSync(file, nativeImage.createFromBitmap(buffer, { width: 80, height: 40 }).toPNG());
          return file;
        };
        const secret = `Pw-${crypto.randomBytes(6).toString('hex')}`;
        const protectedFile = path.join(root, 'Grid protected.pdf');
        fs.writeFileSync(protectedFile, encryptedPdf(secret));
        const notAPdf = path.join(root, 'Grid notes.zip');
        fs.writeFileSync(notAPdf, 'not a pdf');
        const first = picture('Grid picture one.png', [200, 40, 40]);
        const second = picture('Grid picture two.png', [40, 40, 200]);
        const order = (win) => reading(win, `(async () => { const d = workspaceViewer.viewer.pdfDocument; if (!d) return ''; const out = []; for (let i = 1; i <= d.numPages; i++) { const m = (await (await d.getPage(i)).getTextContent()).items.map((x) => x.str).join('').match(/page (\\d+) of (\\d+)/); out.push(m ? m[1] + (m[2] === '6' ? '' : 's') : '-'); } return out.join(','); })()`);
        const tagged = (win) => js(win, `[...document.querySelectorAll('.cell.added')].map((c) => c.dataset.n).join()`);
        const tagLook = (win, n) => js(win, `(() => { const channel = (c) => { const v = Number(c) / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
          const lum = (css) => { const [r, g, b] = css.match(/[\\d.]+/g).slice(0, 3).map((x) => Number(x) * (css.startsWith('color(') ? 255 : 1)); return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b); };
          const cell = document.querySelector('.cell[data-n="${n}"]'); const sheet = cell.querySelector('.sheet'); const tag = getComputedStyle(sheet, '::after');
          const a = lum(tag.color); const b = lum(tag.backgroundColor); const sheetBox = sheet.getBoundingClientRect();
          return { text: tag.content, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), label: cell.getAttribute('aria-label'), width: parseFloat(tag.width), fits: parseFloat(tag.width) + 14 < sheetBox.width }; })()`);
        const arrives = (win, wanted) => until(`the pages to be ${wanted}`, async () => (await order(win)) === wanted);
        const menu = (win) => js(win, `(() => { const m = document.querySelector('.addgroup .menu'); const b = document.querySelector('.addgroup .opt'); const r = m.getBoundingClientRect(); return { open: !m.hidden, expanded: b.getAttribute('aria-expanded'), items: [...m.querySelectorAll('.mi')].map((x) => x.textContent).join('|'), focused: document.activeElement?.textContent ?? '',
          inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, wide: r.width }; })()`);
        const choose = (win, label) => js(win, `[...document.querySelectorAll('.addgroup .mi')].find((x) => x.textContent === ${JSON.stringify(label)}).click()`);
        const addMenu = (win) => js(win, `document.querySelector('.addgroup .opt').click()`);
        const addFiles = async (win) => { await addMenu(win); await choose(win, 'Files…'); await until('the Add files card', () => js(win, `document.querySelector('.veil h3')?.textContent === 'Add files'`)); };
        const CHOOSE = 'Drop PDFs, pictures or documents, or choose files';
        const inCard = (win, label) => js(win, `[...document.querySelectorAll('.veil .btn, .veil .addfiles')].find((b) => b.textContent === ${JSON.stringify(label)}).click()`);
        const listed = (win) => js(win, `[...document.querySelectorAll('.veil .cfile .cname')].map((n) => n.title).join('|')`);
        const extractButton = (win) => js(win, `[...document.querySelectorAll('.optbar button')].find((x) => x.getAttribute('aria-label') === 'Extract').click()`);
        const submit = (win, text) => js(win, `(() => { const f = document.querySelector('.veil input'); f.value = ${JSON.stringify(text)}; f.dispatchEvent(new Event('input')); f.closest('.card').querySelector('.primary').click(); })()`);
        const askedFor = (win) => until('the password card', () => js(win, `!!document.querySelector('.veil input') && !document.querySelector('.veil input').disabled`));
        const picked = [];
        const realOpen = dialog.showOpenDialog;
        const realSave = dialog.showSaveDialog;
        const answer = (...files) => { dialog.showOpenDialog = async (_win, options) => { picked.push(options); return files.length ? { canceled: false, filePaths: files } : { canceled: true, filePaths: [] }; }; };
        let delay = 0;
        const slowTool = async (...args) => { await sleep(delay); return runPdfTool(...args); };
        const tapOn = async (win, selector) => {
          const p = await js(win, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
          mouse(win, 'mouseMove', p);
          mouse(win, 'mouseDown', p);
          mouse(win, 'mouseUp', p);
          await sleep(300);
        };
        const ring = (win) => js(win, `document.activeElement.matches(':focus-visible')`);

        for (const theme of ['light', 'dark']) {
          nativeTheme.themeSource = theme;
          const doc = await makePdf(`Grid insert ${theme}.pdf`, 6);
          const source = await makePdf(`Grid source ${theme}.pdf`, 2);
          const win = await openAndWait(fresh({ solid: true, runPdfTool: slowTool }), doc);
          win.setSize(900, 600);
          await sleep(600);
          await openGrid(win);
          await sheetsDrawn(win, 6);

          const looks = await js(win, `(() => { const o = document.querySelector('.addgroup .opt'); const s = [...document.querySelectorAll('.optbar .opt')].find((x) => x.title === 'Split…'); return { add: o.textContent, addColour: getComputedStyle(o).color, split: s.textContent, splitColour: getComputedStyle(s).color, text: getComputedStyle(document.body).color, icons: o.querySelectorAll('svg').length + '+' + s.querySelectorAll('svg').length, height: o.getBoundingClientRect().height, haspopup: o.getAttribute('aria-haspopup') }; })()`);
          check(`${theme}: Add and Split… carry an icon and their words, Add with a small arrow for its menu, in the full text colour, 30 px high`, looks.add === 'Add' && looks.split === 'Split…' && looks.addColour === looks.text && looks.splitColour === looks.text && looks.icons === '2+1' && looks.height === 30 && looks.haspopup === 'menu', JSON.stringify(looks));

          await clickCell(win, 1);
          await press(win, 'Right');
          await tapOn(win, '.addgroup .opt');
          let m = await menu(win);
          check(`${theme}: Add opens a menu with Files… and Blank page inside the window, the first item focused`, m.open && m.expanded === 'true' && m.items === 'Files…|Blank page' && m.focused === 'Files…' && m.inside, JSON.stringify(m));
          check(`${theme}: opened with the mouse after the keyboard moved through the grid, the menu shows no focus ring (it took on the grid's)`, !(await ring(win)));
          await shot(win, `workspace-grid-insert-menu-${theme}.png`);
          await press(win, 'Down');
          check(`${theme}: the arrow keys move through the items, and the ring shows once the keyboard is used`, (await menu(win)).focused === 'Blank page' && (await ring(win)));
          await press(win, 'Escape');
          check(`${theme}: Esc gives the focus back to Add`, await js(win, `document.activeElement === document.querySelector('.addgroup .opt')`));
          await press(win, 'Space');
          check(`${theme}: opened from the keyboard, the menu shows the ring on its first item`, (await menu(win)).focused === 'Files…' && (await ring(win)));
          answer();
          await press(win, 'Space');
          await until('the Add files card', () => js(win, `document.querySelector('.veil h3')?.textContent === 'Add files'`));
          check(`${theme}: Files… chosen from the keyboard opens the card with the ring on its first button`, (await js(win, `document.activeElement.textContent`)) === CHOOSE && (await ring(win)));
          await press(win, 'Escape');
          await until('the card to close', () => js(win, `!document.querySelector('.veil')`));
          await tapOn(win, '.addgroup .opt');
          await tapOn(win, '.addgroup .mi');
          await until('the Add files card', () => js(win, `document.querySelector('.veil h3')?.textContent === 'Add files'`));
          check(`${theme}: Files… chosen with the mouse opens the card with its first button focused but no ring`, (await js(win, `document.activeElement.textContent`)) === CHOOSE && !(await ring(win)));
          await press(win, 'Escape');
          await until('the card to close', () => js(win, `!document.querySelector('.veil')`));
          await tapOn(win, '.addgroup .opt');
          await press(win, 'Escape');
          m = await menu(win);
          check(`${theme}: Esc closes the menu and the grid stays open`, !m.open && m.expanded === 'false' && (await grid(win)).shown, JSON.stringify(m));
          await addMenu(win);
          mouse(win, 'mouseDown', { x: 450, y: 300 });
          mouse(win, 'mouseUp', { x: 450, y: 300 });
          await sleep(200);
          check(`${theme}: a click outside the menu closes it`, !(await menu(win)).open);

          await clickCell(win, 2);
          let mark = applied();
          await addMenu(win);
          await choose(win, 'Blank page');
          await arrives(win, '1,2,-,3,4,5,6');
          await settled(win);
          let g = await grid(win);
          let last = calls.filter((c) => c.channel === 'pdfws:apply').at(-1);
          check(`${theme}: Blank page puts a page after the selected one, selects it, closes the menu, and the file has changes to save`, applied() === mark + 1 && JSON.stringify(last.args[1]) === '[{"op":"pages.blank","before":3}]' && g.selected === '3' && g.cells === 7 && (await bar(win)).save && !(await menu(win)).open, JSON.stringify([g, last.args]));
          check(`${theme}: the blank page wears the Added tag, and no other page does`, (await tagged(win)) === '3' && (await js(win, `document.querySelector('.cell[data-n="3"]').getAttribute('aria-label')`)) === 'Page 3, added', await tagged(win));
          await push(win, 'Undo');
          await arrives(win, '1,2,3,4,5,6');
          await settled(win);
          check(`${theme}: Undo takes it away again, and the pages are as they were opened`, !(await bar(win)).save && (await bar(win)).cells === 6);
          check(`${theme}: with the page gone no page wears the tag`, (await tagged(win)) === '');

          answer(source);
          mark = applied();
          await addFiles(win);
          check(`${theme}: Files… opens the Add files card with the document listed and Add to document off`, (await listed(win)) === path.basename(doc) && (await js(win, `document.querySelector('.veil .primary').disabled`)), await listed(win));
          await inCard(win, CHOOSE);
          await until('the file in the list', async () => (await listed(win)).includes(path.basename(source)));
          check(`${theme}: choosing files asks once for PDFs, pictures and documents, several at a time, and lists them after the document`, picked.at(-1).title === 'Add files' && picked.at(-1).properties.includes('multiSelections') && ['pdf', 'png', 'docx'].every((e) => picked.at(-1).filters[0].extensions.includes(e)) && (await listed(win)) === `${path.basename(doc)}|${path.basename(source)}`, JSON.stringify([picked.at(-1), await listed(win)]));
          await inCard(win, 'Add to document');
          await arrives(win, '1,2,3,4,5,6,1s,2s');
          await settled(win);
          g = await grid(win);
          last = calls.filter((c) => c.channel === 'pdfws:apply').at(-1);
          check(`${theme}: Add to document puts the pages of a file listed after the document at its end in one change, selects them, closes the card, and sends the engine no path`, applied() === mark + 1 && JSON.stringify(last.args[1].map((o) => [o.op, o.before, o.sources.length])) === '[["pages.insert",7,1]]' && !JSON.stringify(last.args).includes(source) && g.selected === '7,8' && g.cells === 8 && (await bar(win)).save && (await js(win, `!document.querySelector('.veil')`)), JSON.stringify([g, last.args]));
          await shot(win, `workspace-grid-inserted-${theme}.png`);
          const tag = await tagLook(win, 7);
          check(`${theme}: the pages added from a PDF wear an Added tag and the pages before them do not; the tag reads at 4.5:1 or better and fits the page (${tag.ratio.toFixed(1)}:1)`, (await tagged(win)) === '7,8' && tag.text === '"Added"' && tag.ratio >= 4.5 && tag.fits && tag.label === 'Page 7, added' && (await js(win, `document.querySelector('.cell[data-n="6"]').getAttribute('aria-label')`)) === 'Page 6', JSON.stringify([await tagged(win), tag]));

          answer(first, second);
          mark = applied();
          await addFiles(win);
          await inCard(win, CHOOSE);
          await until('the pictures in the list', async () => (await listed(win)).split('|').length === 3);
          await js(win, `document.querySelector('.veil .cfile.me .grip').focus()`);
          await press(win, 'Down', ['alt']);
          const moved = await js(win, `({ names: [...document.querySelectorAll('.veil .cfile .cname')].map((n) => n.title).join('|'), focused: document.activeElement === document.querySelector('.veil .cfile.me .grip') })`);
          check(`${theme}: Alt+Down moves the document below the first picture and keeps the focus on its handle`, moved.names === [first, doc, second].map((f) => path.basename(f)).join('|') && moved.focused, JSON.stringify(moved));
          await inCard(win, 'Add to document');
          await arrives(win, '-,1,2,3,4,5,6,1s,2s,-');
          await settled(win);
          last = calls.filter((c) => c.channel === 'pdfws:apply').at(-1);
          check(`${theme}: a file above the document goes in front of page 1 and one below it at the end, both in one change`, applied() === mark + 1 && JSON.stringify(last.args[1].map((o) => [o.before, o.sources.length])) === '[[9,1],[1,1]]' && (await grid(win)).cells === 10, JSON.stringify(last.args));
          check(`${theme}: pictures added wear the tag too, beside the pages from the PDF`, (await tagged(win)) === '1,8,9,10', await tagged(win));
          await push(win, 'Undo');
          await arrives(win, '1,2,3,4,5,6,1s,2s');
          await settled(win);
          check(`${theme}: one Undo takes both pictures away`, (await grid(win)).cells === 8 && (await tagged(win)) === '7,8', await tagged(win));
          await push(win, 'Redo');
          await arrives(win, '-,1,2,3,4,5,6,1s,2s,-');
          await settled(win);

          mark = applied();
          answer();
          await addFiles(win);
          await inCard(win, CHOOSE);
          await sleep(400);
          check(`${theme}: closing the file dialog with nothing chosen leaves only the document in the card, and Add to document off`, (await listed(win)) === path.basename(doc) && (await js(win, `document.querySelector('.veil .primary').disabled`)));
          notices.length = 0;
          answer(notAPdf);
          await inCard(win, CHOOSE);
          await until('the notice', async () => notices.length > 0, 5000);
          check(`${theme}: a file that is not a PDF, a picture or a document says so in the corner and is not listed`, notices.at(-1).title === "Can't add these files" && notices.at(-1).detail === 'Only PDFs, pictures and documents can be added.' && (await listed(win)) === path.basename(doc), JSON.stringify(notices));
          notices.length = 0;
          await inCard(win, 'Cancel');
          await sleep(300);
          check(`${theme}: Cancel closes the card and changes nothing`, (await js(win, `!document.querySelector('.veil')`)) && applied() === mark && (await order(win)) === '-,1,2,3,4,5,6,1s,2s,-');

          answer(protectedFile);
          await addFiles(win);
          await inCard(win, CHOOSE);
          await askedFor(win);
          const ask = await js(win, `(() => { const top = document.querySelector('.veil input').closest('.card'); const under = [...document.querySelectorAll('.veil .card')].find((c) => c !== top); return { title: top.querySelector('h3').textContent, type: top.querySelector('input').type, buttons: [...top.querySelectorAll('.btn')].map((b) => b.textContent).join(), under: under?.querySelector('h3').textContent, inert: !!under?.closest('[inert]') }; })()`);
          check(`${theme}: a protected PDF asks for its password in the usual card, over the Add files card, which cannot be used meanwhile, and nothing is sent yet`, ask.title === 'Password protected' && ask.type === 'password' && ask.buttons === 'Cancel,Open' && ask.under === 'Add files' && ask.inert && applied() === mark, JSON.stringify(ask));
          const named = await js(win, `(() => { const n = document.querySelector('.veil .fname'); return { text: n.textContent, shown: !n.hidden, title: n.title, colour: getComputedStyle(n).color, body: getComputedStyle(document.body).color }; })()`);
          check(`${theme}: the card says which file it is asking about, in the full text colour, under the title`, named.shown && named.text === 'Grid protected.pdf' && named.title === 'Grid protected.pdf' && named.colour === named.body, JSON.stringify(named));
          await sleep(450);
          await shot(win, `workspace-grid-insert-password-${theme}.png`);
          await submit(win, 'not the password');
          await until('the second ask', () => js(win, `!!document.querySelector('.veil .emsg.on') && !document.querySelector('.veil input').disabled`));
          check(`${theme}: a wrong password is answered in the same card`, (await js(win, `document.querySelector('.veil .emsg p').textContent`)) === 'Wrong Password' && applied() === mark);
          await submit(win, secret);
          await until('the protected file in the list', async () => (await listed(win)).endsWith('Grid protected.pdf'));
          check(`${theme}: the right password closes its card and lists the file in the Add files card`, (await js(win, `document.querySelectorAll('.veil').length === 1 && !document.querySelector('.veil input')`)) && applied() === mark);
          await inCard(win, 'Add to document');
          await arrives(win, '-,1,2,3,4,5,6,1s,2s,-,-');
          await settled(win);
          check(`${theme}: Add to document puts its page in at the end`, (await grid(win)).cells === 11 && applied() === mark + 1, JSON.stringify(await grid(win)));
          check(`${theme}: and that page wears the tag`, (await tagged(win)) === '1,8,9,10,11', await tagged(win));

          answer(protectedFile);
          await addFiles(win);
          await inCard(win, CHOOSE);
          await askedFor(win);
          await js(win, `[...document.querySelector('.veil input').closest('.card').querySelectorAll('.btn')].find((b) => !b.classList.contains('primary')).click()`);
          await sleep(500);
          check(`${theme}: Cancel on the password card leaves the file out of the list`, (await listed(win)) === path.basename(doc) && (await js(win, `document.querySelectorAll('.veil').length`)) === 1);
          await inCard(win, 'Cancel');
          await sleep(300);
          check(`${theme}: and nothing is added`, (await js(win, `!document.querySelector('.veil')`)) && applied() === mark + 1 && (await grid(win)).cells === 11);

          await clickCell(win, 2);
          await clickCell(win, 3, ['control']);
          const saved = path.join(root, `Grid extracted ${theme}.pdf`);
          const asked = [];
          dialog.showSaveDialog = async (_win, options) => { asked.push(options); return { canceled: false, filePath: saved }; };
          notices.length = 0;
          const before = applied();
          await extractButton(win);
          await until('the extracted file', async () => fs.existsSync(saved) && notices.length > 0, 20000);
          const extracted = await PDFDocument.load(fs.readFileSync(saved));
          g = await grid(win);
          check(`${theme}: Extract asks where to save, writes the two pages as a new file, says so in the corner, and leaves the document and its selection alone`, asked[0].title === 'Extract pages' && /\(pages 2-3\)\.pdf$/.test(asked[0].defaultPath) && extracted.getPageCount() === 2 && notices.at(-1).title === 'Pages extracted' && notices.at(-1).detail === path.basename(saved) && applied() === before && g.selected === '2,3' && g.cells === 11 && !(await bar(win)).busy, JSON.stringify([asked[0], notices, g]));
          notices.length = 0;
          fs.rmSync(saved);
          dialog.showSaveDialog = async () => ({ canceled: true });
          await extractButton(win);
          await sleep(500);
          check(`${theme}: closing the save dialog writes nothing and says nothing`, !fs.existsSync(saved) && notices.length === 0 && !(await bar(win)).busy);
          dialog.showSaveDialog = realSave;

          const drops = win.webContents.debugger;
          if (!drops.isAttached()) drops.attach('1.3');
          const dropOn = async (n, side, files) => {
            const c = await centre(win, n);
            const width = await js(win, `document.querySelector('.cell[data-n="${n}"] .sheet').getBoundingClientRect().width`);
            const x = Math.round(c.x + (side === 'right' ? width / 4 : -width / 4));
            const data = { items: [], files, dragOperationsMask: 1 };
            for (const type of ['dragEnter', 'dragOver', 'drop']) await drops.sendCommand('Input.dispatchDragEvent', { type, x, y: c.y, data });
            await sleep(900);
          };
          const tabs = () => js(win, `document.querySelectorAll('#tabs .tab').length`);
          const tabsBefore = await tabs();
          await dropOn(1, 'left', [first]);
          await arrives(win, '-,-,1,2,3,4,5,6,1s,2s,-,-');
          await settled(win);
          g = await grid(win);
          check(`${theme}: a picture dropped on the left half of page 1 goes in front of it, is selected, and no new tab opens`, g.selected === '1' && g.cells === 12 && (await tabs()) === tabsBefore, JSON.stringify([g, await tabs()]));
          check(`${theme}: the tags follow the pages when more go in before them`, (await tagged(win)) === '1,2,9,10,11,12', await tagged(win));
          delay = 1500;
          await dropOn(12, 'right', [source]);
          const spinning = await js(win, `(() => { const b = document.querySelector('.addgroup .opt'); const s = getComputedStyle(b, '::before'); return { adding: b.classList.contains('adding'), turning: s.animationName, size: s.width, plus: getComputedStyle(b.querySelector('.i')).display, word: b.textContent }; })()`);
          check(`${theme}: while a dropped file is added, the plus of Add turns into a spinner and the word stays`, spinning.adding && spinning.turning === 'rot' && spinning.size === '12px' && spinning.plus === 'none' && spinning.word === 'Add', JSON.stringify(spinning));
          delay = 0;
          await arrives(win, '-,-,1,2,3,4,5,6,1s,2s,-,-,1s,2s');
          check(`${theme}: and turns back into the plus once the pages are in`, await js(win, `!document.querySelector('.addgroup .opt').classList.contains('adding') && getComputedStyle(document.querySelector('.addgroup .opt .i')).display !== 'none'`));
          await settled(win);
          check(`${theme}: a PDF dropped on the right half of the last page goes after it`, (await grid(win)).selected === '13,14' && (await grid(win)).cells === 14, JSON.stringify(await grid(win)));
          check(`${theme}: and the pages dropped at the end are tagged`, (await tagged(win)) === '1,2,9,10,11,12,13,14', await tagged(win));
          await shot(win, `workspace-grid-dropped-${theme}.png`);
          await dropOn(3, 'right', [notAPdf]);
          await sleep(500);
          check(`${theme}: a file dropped on the grid that is not a PDF, a picture or a document changes nothing, and Add does not keep spinning`, (await grid(win)).cells === 14 && (await tabs()) === tabsBefore && (await js(win, `!document.querySelector('.addgroup .opt').classList.contains('adding')`)));
          notices.length = 0;
          drops.detach();
          await js(win, `document.querySelector('.cell').focus()`);
          await press(win, 's', ['control']);
          await until('the question', () => js(win, `document.querySelector('.veil h3')?.textContent === 'Replace the original?'`));
          await js(win, `[...document.querySelectorAll('.veil .row button')].find((b) => b.textContent === 'Replace').click()`);
          await until('the save', async () => !(await bar(win)).save);
          await sleep(300);
          check(`${theme}: Replace saves the file with its new pages, and the Added tags go, the grid staying as it is`, (await tagged(win)) === '' && (await grid(win)).cells === 14 && (await grid(win)).shown && (await PDFDocument.load(fs.readFileSync(doc), { ignoreEncryption: true, updateMetadata: false })).getPageCount() === 14, JSON.stringify([await tagged(win), (await grid(win)).cells]));
          await clickCell(win, 3);
          await addMenu(win);
          await choose(win, 'Blank page');
          await until('the blank page', async () => (await grid(win)).cells === 15);
          await settled(win);
          check(`${theme}: a page put in after the save is the only one tagged`, (await tagged(win)) === '4', await tagged(win));
          await push(win, 'Undo');
          await settled(win);
          check(`${theme}: undoing it goes back to the file as saved, with no tag and nothing to save`, (await tagged(win)) === '' && !(await bar(win)).save && (await grid(win)).cells === 14);
          dialog.showOpenDialog = realOpen;
          win.destroy();
          await sleep(500);
          forgetSize();
        }
        nativeTheme.themeSource = 'light';
      }

      console.log('the grid: splitting and adding files');
      {
        const sized = async (name, pages, [width, height]) => {
          const made = await PDFDocument.create();
          for (let n = 0; n < pages; n++) made.addPage([width, height]);
          const file = path.join(root, name);
          fs.writeFileSync(file, await made.save({ useObjectStreams: false }));
          return file;
        };
        const counted = async (file) => (await PDFDocument.load(fs.readFileSync(file))).getPageCount();
        const pushed = (win, title) => js(win, `[...document.querySelectorAll('.optbar .opt')].find((x) => x.title === ${JSON.stringify(title)}).click()`);
        const veil = (win) => js(win, `(() => { const c = document.querySelector('.veil .card'); if (!c) return null; const go = c.querySelector('.btn.primary'); const field = c.querySelector('input.fld');
          return { title: c.querySelector('h3').textContent, files: [...c.querySelectorAll('.cfile:not(.loading)')].map((f) => f.querySelector('.cname').title + (f.classList.contains('me') ? '*' : '')).join('|'),
            radios: [...c.querySelectorAll('[role="radio"]')].map((r) => r.textContent + '=' + r.getAttribute('aria-checked')).join('|'), field: field ? [field.hidden, field.placeholder, field.value, field.getAttribute('aria-invalid')].join('|') : '',
            go: go.textContent, goOff: go.disabled, note: c.querySelector('.note')?.textContent ?? '', error: c.querySelector('.cnote.bad')?.textContent ?? '', line: c.querySelector('.cnote')?.textContent ?? '', addOff: c.querySelector('.addfiles')?.disabled ?? null, focusedField: document.activeElement === field,
            height: Math.round(c.getBoundingClientRect().height), described: field ? document.getElementById(field.getAttribute('aria-describedby'))?.textContent ?? '' : '', mark: [...c.querySelectorAll('.cfile')].findIndex((f) => f.classList.contains('me')),
            wide: c.scrollWidth <= c.clientWidth, inside: c.getBoundingClientRect().left >= 0 && c.getBoundingClientRect().right <= innerWidth && c.getBoundingClientRect().bottom <= innerHeight }; })()`);
        const gone = (win) => until('the card to close', () => js(win, `!document.querySelector('.veil')`));
        const typed = (win, text) => js(win, `(() => { const f = document.querySelector('.veil input.fld'); f.value = ${JSON.stringify(text)}; f.dispatchEvent(new Event('input')); })()`);
        const radio = (win, label) => js(win, `[...document.querySelectorAll('.veil [role="radio"]')].find((r) => r.textContent === ${JSON.stringify(label)}).click()`);
        const cardButton = (win, label) => js(win, `[...document.querySelectorAll('.veil .btn, .veil .addfiles')].find((b) => b.textContent === ${JSON.stringify(label)}).click()`);
        const removeRow = (win, name) => js(win, `[...document.querySelectorAll('.veil .cfile')].find((f) => f.querySelector('.cname').title === ${JSON.stringify(name)}).querySelector('.cremove').click()`);
        const addFiles = async (win) => { await js(win, `document.querySelector('.addgroup .opt').click()`); await js(win, `[...document.querySelectorAll('.addgroup .mi')].find((x) => x.textContent === 'Files…').click()`); await until('the Add files card', () => js(win, `document.querySelector('.veil h3')?.textContent === 'Add files'`)); };
        const CHOOSE = 'Drop PDFs, pictures or documents, or choose files';
        const strip = async (win) => { await sleep(250); return js(win, `(() => { const s = document.querySelector('.veil .sstrip'); const b = s.getBoundingClientRect(); const parts = [...s.children].map((p) => { const r = p.getBoundingClientRect(); return { text: p.textContent, left: (r.left - b.left) / b.width, width: r.width / b.width, px: r.width, top: Math.round(r.top - b.top), bottom: Math.round(b.bottom - r.bottom), colour: getComputedStyle(p).backgroundColor, ink: getComputedStyle(p).color }; });
          const look = getComputedStyle(s); return { label: s.getAttribute('aria-label') ?? '', role: s.getAttribute('role'), parts, height: Math.round(b.height), shown: s.checkVisibility(), bare: look.backgroundColor === 'rgba(0, 0, 0, 0)' && look.boxShadow === 'none' && look.borderTopStyle === 'none' }; })()`); };
        // Each part stands where its pages are in the document and is as wide as their share of it, within 1 % of the strip, in one row.
        const spans = (s, total, ...expected) => s.parts.length === expected.length && s.parts.every((p) => p.top === 0 && p.bottom === 0) && expected.every(([from, to], i) => Math.abs(s.parts[i].left - (from - 1) / total) < 0.01 && Math.abs(s.parts[i].width - (to - from + 1) / total) < 0.01);
        const lum = (css) => css.match(/[\d.]+/g).slice(0, 3).map((v) => { const x = Number(v) / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }).reduce((sum, v, n) => sum + v * [0.2126, 0.7152, 0.0722][n], 0);
        const legible = (s) => s.parts.every((p) => { const [a, b] = [lum(p.colour), lum(p.ink)]; return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5; });
        const realOpen = dialog.showOpenDialog;
        const realSave = dialog.showSaveDialog;
        const secret = `Pw-${crypto.randomBytes(6).toString('hex')}`;
        const protectedFile = path.join(root, 'Grid join protected.pdf');
        fs.writeFileSync(protectedFile, encryptedPdf(secret));

        const split = await makePdf('Grid split.pdf', 12);
        const outlined = await makeOutlinePdf('Grid split outline.pdf');
        const partsOf = (name) => fs.readdirSync(root).filter((f) => f.startsWith(`${name} (`) && f.endsWith('.pdf')).sort();

        for (const theme of ['light', 'dark']) {
          nativeTheme.themeSource = theme;
          const win = await openAndWait(fresh({ solid: true }), split);
          win.setSize(900, 600);
          await sleep(600);
          await openGrid(win);
          await sheetsDrawn(win, 6);
          const buttons = await js(win, `[...document.querySelectorAll('.optbar .opt')].filter((x) => x.title === 'Split…').map((x) => ({ text: x.textContent, icons: x.querySelectorAll('svg').length, off: x.disabled, height: x.getBoundingClientRect().height, colour: getComputedStyle(x).color === getComputedStyle(document.body).color }))`);
          check(`${theme}: Split… carries an icon and its word, and is on with nothing selected`, JSON.stringify(buttons) === JSON.stringify([{ text: 'Split…', icons: 1, off: false, height: 30, colour: true }]), JSON.stringify(buttons));
          check(`${theme}: the bar fits a 900 px window`, await js(win, `(() => { const b = document.querySelector('.optbar').getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth; })()`));

          await pushed(win, 'Split…');
          await sleep(400);
          let c = await veil(win);
          check(`${theme}: Split opens a card with By ranges, Every N pages and At bookmarks, By ranges on, the field focused with its hint, and Split off until something is typed`, c.title === 'Split' && c.radios === 'By ranges=true|Every N pages=false|At bookmarks=false' && c.field === 'false|1-3, 4-9, 10-||' && c.focusedField && c.goOff && c.go === 'Split' && c.note === 'The files are saved in the same folder' && c.wide && c.inside, JSON.stringify(c));
          check(`${theme}: under the field a line that stays while typing says what to type, and the field is described by it (the placeholder was the only hint)`, c.line === 'One file for each range, separated by commas' && c.described === c.line, JSON.stringify(c));
          let s = await strip(win);
          check(`${theme}: under the field an empty row is kept for the strip, read out as a picture, with nothing drawn in it (it looked like a second field)`, s.shown && s.role === 'img' && s.parts.length === 0 && s.height === 22 && s.bare, JSON.stringify(s));
          const heights = [c.height];
          await shot(win, `workspace-split-${theme}.png`);
          await typed(win, 'x');
          await press(win, 'Return');
          await sleep(500);
          c = await veil(win);
          heights.push(c.height);
          check(`${theme}: a range that is not page numbers is answered in the card, which stays, with the field marked and selected`, c.error === 'Use page numbers such as 1-3, 7' && c.field.endsWith('|x|true') && c.focusedField && !c.goOff, JSON.stringify(c));
          await shot(win, `workspace-split-error-${theme}.png`);
          await typed(win, '1-3, 13-20');
          await press(win, 'Return');
          await sleep(500);
          c = await veil(win);
          check(`${theme}: ranges that run past the end are answered with the number of pages (they were told to use page numbers)`, c.error === 'This document has 12 pages' && c.field.endsWith('|true'), JSON.stringify(c));
          s = await strip(win);
          check(`${theme}: ranges the document cannot give draw nothing in the strip`, s.parts.length === 0, JSON.stringify(s));
          await typed(win, '1-3, 4-9, 10-');
          await sleep(80);
          const coming = await js(win, `[...document.querySelectorAll('.veil .spart')].map((p) => p.getAnimations().length).join()`);
          s = await strip(win);
          check(`${theme}: the boxes fade in as the ranges are typed`, coming.split(',').some((n) => Number(n) > 0), coming);
          check(`${theme}: as ranges are typed the strip shows a box for each file, in its own colour, over the pages it takes, with its pages written in it`, spans(s, 12, [1, 3], [4, 9], [10, 12]) && s.parts.map((p) => p.text).join('|') === '1-3|4-9|10-12' && new Set(s.parts.map((p) => p.colour)).size === 3 && s.label === '1-3, 4-9, 10-12', JSON.stringify(s));
          check(`${theme}: the pages written in the boxes read at 4.5:1 or better on every colour`, legible(s), JSON.stringify(s.parts));
          await shot(win, `workspace-split-preview-${theme}.png`);
          await typed(win, '1-3, 4-9,');
          await sleep(150);
          const held = await js(win, `document.querySelectorAll('.veil .spart').length`);
          await sleep(700);
          const after = await js(win, `document.querySelectorAll('.veil .spart').length`);
          check(`${theme}: half-typed ranges (\`1-3, 4-9,\`) keep the boxes a moment before they fade, so typing does not make them blink`, held >= 2 && after === 0, JSON.stringify([held, after]));
          await typed(win, '2, 5-6');
          s = await strip(win);
          check(`${theme}: pages no file takes are left empty in the strip, and a box under 30 px carries no number`, spans(s, 12, [2, 2], [5, 6]) && s.parts[0].text === '' && s.parts[1].text === '5-6', JSON.stringify(s));
          await radio(win, 'Every N pages');
          c = await veil(win);
          heights.push(c.height);
          check(`${theme}: another way of splitting clears the message and changes the hint`, c.error === '' && c.radios === 'By ranges=false|Every N pages=true|At bookmarks=false' && c.field.startsWith('false|Pages in each file|') && c.line === 'The last file takes the pages left over', JSON.stringify(c));
          await typed(win, '5');
          s = await strip(win);
          check(`${theme}: every 5 pages shows files of 5, 5 and 2 pages in the strip`, spans(s, 12, [1, 5], [6, 10], [11, 12]) && s.label === '1-5, 6-10, 11-12', JSON.stringify(s));
          await radio(win, 'At bookmarks');
          await sleep(400);
          c = await veil(win);
          heights.push(c.height);
          check(`${theme}: At bookmarks in a document with none leaves the strip empty`, (await strip(win)).parts.length === 0);
          check(`${theme}: the card keeps one height in every mode and with a message, so its buttons stay under the pointer (${heights.join(', ')} px; it was 239, 263, 239 and 207)`, heights.every((h) => h === heights[0]), JSON.stringify(heights));
          await press(win, 'Escape');
          await gone(win);
          check(`${theme}: Esc closes the card and writes nothing`, partsOf('Grid split').length === 0 && notices.length === 0);
          win.destroy();
          await sleep(500);
          forgetSize();
        }
        nativeTheme.themeSource = 'light';

        {
          const win = await openAndWait(fresh({ solid: true }), split);
          win.setSize(900, 600);
          await sleep(600);
          await openGrid(win);
          await sheetsDrawn(win, 6);
          const before = applied();
          notices.length = 0;
          await pushed(win, 'Split…');
          await sleep(300);
          await typed(win, '1-3, 4-9, 10-');
          await cardButton(win, 'Split');
          await gone(win);
          const names = partsOf('Grid split');
          check('ranges make one file each, named by their pages, next to the document, with those pages', JSON.stringify(names) === '["Grid split (1-3).pdf","Grid split (10-12).pdf","Grid split (4-9).pdf"]' && (await counted(path.join(root, names[0]))) === 3 && (await counted(path.join(root, names[1]))) === 3 && (await counted(path.join(root, names[2]))) === 6, JSON.stringify(names));
          check('the corner says how many files were made and where, and the document, its tab and its Save button are as they were', notices.at(-1)?.title === 'Split into 3 files' && notices.at(-1).detail === 'Saved next to Grid split.pdf' && applied() === before && !(await bar(win)).save && (await grid(win)).cells === 12, JSON.stringify([notices, await bar(win)]));
          notices.length = 0;
          await pushed(win, 'Split…');
          await sleep(300);
          await typed(win, '1-3');
          await cardButton(win, 'Split');
          await gone(win);
          check('splitting into a name that is taken makes another file and leaves the first alone', partsOf('Grid split').length === 4 && notices.at(-1)?.title === 'Split into 1 file', JSON.stringify([partsOf('Grid split'), notices]));
          for (const name of partsOf('Grid split')) fs.rmSync(path.join(root, name));
          notices.length = 0;

          await pushed(win, 'Split…');
          await sleep(300);
          await radio(win, 'Every N pages');
          await typed(win, '12');
          await cardButton(win, 'Split');
          await sleep(500);
          let c = await veil(win);
          check('every 12 pages in a document of 12 is answered in the card and writes nothing', c.error === 'Use a number of pages such as 5' && partsOf('Grid split').length === 0, JSON.stringify(c));
          await typed(win, '5');
          await press(win, 'Return');
          await gone(win);
          const fives = partsOf('Grid split');
          check('every 5 pages makes files of 5, 5 and 2 pages', JSON.stringify(fives) === '["Grid split (1-5).pdf","Grid split (11-12).pdf","Grid split (6-10).pdf"]' && (await counted(path.join(root, fives[1]))) === 2 && notices.at(-1)?.title === 'Split into 3 files', JSON.stringify(fives));
          for (const name of fives) fs.rmSync(path.join(root, name));
          notices.length = 0;

          await pushed(win, 'Split…');
          await sleep(300);
          await radio(win, 'At bookmarks');
          await sleep(400);
          c = await veil(win);
          check('At bookmarks in a document with none says so in place of the field, which it hides, and leaves Split off', c.line === 'No bookmarks to split at.' && c.note === 'The files are saved in the same folder' && c.field.startsWith('true|') && c.goOff, JSON.stringify(c));
          await press(win, 'Escape');
          await gone(win);
          win.destroy();
          await sleep(500);
          forgetSize();
        }

        {
          const win = await openAndWait(fresh({ solid: true }), outlined);
          win.setSize(900, 600);
          await sleep(600);
          await openGrid(win);
          await sheetsDrawn(win, 5);
          await pushed(win, 'Split…');
          await sleep(300);
          await radio(win, 'At bookmarks');
          await until('the bookmarks to be read', async () => (await veil(win)).line.startsWith('3 files'));
          const c = await veil(win);
          check('At bookmarks counts a file for each top-level bookmark that has a page, and the first file starts at page 1', c.line === '3 files, one for each top-level bookmark.' && !c.goOff && c.field.startsWith('true|'), JSON.stringify(c));
          const s = await strip(win);
          check('the strip shows the files the bookmarks make, where the field would be', spans(s, 5, [1, 1], [2, 3], [4, 5]) && s.parts.map((p) => p.text).join('|') === '1|2-3|4-5', JSON.stringify(s));
          await shot(win, 'workspace-split-bookmarks.png');
          await cardButton(win, 'Split');
          await gone(win);
          const names = partsOf('Grid split outline');
          check('and splits there, into pages 1, 2 to 3 and 4 to 5', JSON.stringify(names) === '["Grid split outline (1).pdf","Grid split outline (2-3).pdf","Grid split outline (4-5).pdf"]' && (await counted(path.join(root, names[1]))) === 2 && (await counted(path.join(root, names[2]))) === 2, JSON.stringify(names));
          notices.length = 0;
          win.destroy();
          await sleep(500);
          forgetSize();
        }

        {
          const long = await makePdf('Grid split long.pdf', 500);
          const win = await openAndWait(fresh({ solid: true }), long);
          win.setSize(900, 600);
          await sleep(600);
          await openGrid(win, 1500);
          await pushed(win, 'Split…');
          await sleep(300);
          await typed(win, '1, 2-250, 251-');
          const s = await strip(win);
          check(`500 pages still make one row: a file of one page is a sliver in its place, too narrow for its number, and the others are true to their share (${s.parts.map((p) => p.px.toFixed(1)).join(', ')} px)`, spans(s, 500, [1, 1], [2, 250], [251, 500]) && s.parts[0].px >= 2 && s.parts[0].text === '' && s.parts[1].text === '2-250' && s.label === '1, 2-250, 251-500', JSON.stringify(s));
          await shot(win, 'workspace-split-long.png');
          await press(win, 'Escape');
          await gone(win);
          win.destroy();
          await sleep(500);
          forgetSize();
          fs.rmSync(long, { force: true });
        }

        for (const theme of ['light', 'dark']) {
          nativeTheme.themeSource = theme;
          const doc = await makePdf(`Grid add ${theme}.pdf`, 3);
          const first = await sized(`Grid join A ${theme}.pdf`, 2, [400, 300]);
          const second = await sized(`Grid join B ${theme}.pdf`, 2, [300, 400]);
          let lag = 0;
          const win = await openAndWait(fresh({ solid: true, probeLocked: async (file) => { await sleep(lag); return probeLocked(file); }, runPdfTool: async (...args) => { await sleep(lag); return runPdfTool(...args); } }), doc);
          win.setSize(900, 600);
          await sleep(600);
          await openGrid(win);
          await sheetsDrawn(win, 3);
          const before = applied();
          await addFiles(win);
          await sleep(300);
          let c = await veil(win);
          check(`${theme}: Files… opens the Add files card with the open document alone, and Add to document off`, c.title === 'Add files' && c.files === `Grid add ${theme}.pdf*` && c.goOff && c.go === 'Add to document' && c.addOff === false && c.wide && c.inside, JSON.stringify(c));
          const row = await js(win, `(() => { const r = document.querySelector('.veil .cfile.me'); return { edge: getComputedStyle(r).borderTopColor, current: r.getAttribute('aria-current'), tag: r.querySelector('.ctag')?.textContent, remove: !!r.querySelector('.cremove'), grip: r.querySelector('.grip').getAttribute('aria-label'), meta: r.querySelector('.cmeta').textContent }; })()`);
          check(`${theme}: the document's row has an accent edge, the This document tag, its number of pages and a handle to move it, and no Remove button`, row.current === 'true' && row.edge === 'rgb(232, 77, 111)' && row.tag === 'This document' && !row.remove && row.grip === `Move Grid add ${theme}.pdf (Alt+Up, Alt+Down)` && row.meta === '3 pages', JSON.stringify(row));
          const tagInk = await inkContrast(win, '.veil .cfile.me .ctag');
          check(`${theme}: the tag fits and reads at ${tagInk.ratio.toFixed(2)}:1, at least 4.5`, tagInk.text <= tagInk.box && tagInk.ratio >= 4.5, JSON.stringify(tagInk));
          const picked = [];
          dialog.showOpenDialog = async (_win, options) => { picked.push(options); return { canceled: false, filePaths: [first, second] }; };
          lag = 700;
          await cardButton(win, CHOOSE);
          await sleep(500);
          const reading = await js(win, `(() => { const rows = [...document.querySelectorAll('.veil .cfile.loading')]; const go = document.querySelector('.veil .primary'); return { rows: rows.length, shown: rows.every((r) => Number(getComputedStyle(r).opacity) > 0.9), pulse: rows.every((r) => [...r.querySelectorAll('.sk')].length === 3 && getComputedStyle(r.querySelector('.sk')).animationName === 'pulse'), busy: document.querySelector('.veil .files').getAttribute('aria-busy'), goOff: go.disabled, chooseOff: document.querySelector('.veil .addfiles').disabled }; })()`);
          check(`${theme}: while the files chosen are read, a pulsing row stands in for each, and Add to document and the choose button wait`, reading.rows === 2 && reading.shown && reading.pulse && reading.busy === 'true' && reading.goOff && reading.chooseOff, JSON.stringify(reading));
          await shot(win, `workspace-add-files-reading-${theme}.png`);
          await until('the files to be listed', async () => (await veil(win)).files.split('|').length === 3);
          lag = 0;
          check(`${theme}: the rows give way to the files once they are read`, await js(win, `!document.querySelector('.veil .cfile.loading') && document.querySelector('.veil .files').getAttribute('aria-busy') === 'false'`));
          c = await veil(win);
          check(`${theme}: the files chosen are listed after the document in the order chosen, with Add to document on`, c.files === `Grid add ${theme}.pdf*|Grid join A ${theme}.pdf|Grid join B ${theme}.pdf` && !c.goOff, JSON.stringify(c));
          const icons = await js(win, `[...document.querySelectorAll('.veil .cfile')].map((r) => ({ shapes: r.querySelectorAll('.cicon .picon *').length, meta: r.querySelector('.cmeta').textContent, remove: r.querySelector('.cremove')?.getAttribute('aria-label') ?? '', whole: (() => { const n = r.querySelector('.cname'); const probe = document.createElement('span'); probe.style.cssText = 'position: absolute; white-space: pre; font: ' + getComputedStyle(n).font; probe.textContent = n.title; document.body.append(probe); const full = probe.getBoundingClientRect().width; probe.remove(); return Math.abs(full - (n.querySelector('.head').scrollWidth + n.querySelector('.tail').getBoundingClientRect().width)) < 1.5; })() }))`);
          check(`${theme}: a name cut next to a space keeps the space (Grid add read Gridadd)`, icons.every((i) => i.whole), JSON.stringify(icons));
          check(`${theme}: every row shows Pomelo's file icon, its number of pages, and a Remove button named for its file`, icons.every((i) => i.shapes > 2) && icons.map((i) => i.meta).join() === '3 pages,2 pages,2 pages' && icons[1].remove === `Remove: Grid join A ${theme}.pdf`, JSON.stringify(icons));
          const gripAt = await js(win, `(() => { const r = document.querySelector('.veil .cfile.me .grip').getBoundingClientRect(); const rows = [...document.querySelectorAll('.veil .cfile')].map((x) => x.getBoundingClientRect()); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), step: Math.round(rows[1].top - rows[0].top) }; })()`);
          mouse(win, 'mouseMove', gripAt);
          mouse(win, 'mouseDown', gripAt);
          for (let y = gripAt.y; y <= gripAt.y + gripAt.step + 8; y += 6) { mouse(win, 'mouseMove', { x: gripAt.x, y }); await sleep(16); }
          await sleep(300);
          const held = await js(win, `(() => { const r = document.querySelector('.veil .cfile.lift'); return { lifted: !!r, name: r?.querySelector('.cname').title, order: [...document.querySelectorAll('.veil .cfile .cname')].map((n) => n.title).join('|'), shadow: r ? getComputedStyle(r).boxShadow !== 'none' : false }; })()`);
          check(`${theme}: the document's row follows the pointer, lifted with a shadow, and the row below makes way while it is dragged`, held.lifted && held.name === `Grid add ${theme}.pdf` && held.shadow && held.order === `Grid join A ${theme}.pdf|Grid add ${theme}.pdf|Grid join B ${theme}.pdf`, JSON.stringify(held));
          await shot(win, `workspace-add-files-drag-${theme}.png`);
          mouse(win, 'mouseUp', { x: gripAt.x, y: gripAt.y + gripAt.step + 8 });
          await sleep(400);
          c = await veil(win);
          check(`${theme}: letting go keeps the new order and nothing is lifted any more`, c.files === `Grid join A ${theme}.pdf|Grid add ${theme}.pdf*|Grid join B ${theme}.pdf` && (await js(win, `!document.querySelector('.veil .cfile.lift')`)), JSON.stringify(c));
          await shot(win, `workspace-add-files-${theme}.png`);
          lag = 1500;
          await cardButton(win, 'Add to document');
          await sleep(400);
          const adding = await js(win, `(() => { const go = document.querySelector('.veil .primary'); return { open: !!go, spin: !!go?.querySelector('.spin'), word: go?.textContent, busy: go?.getAttribute('aria-busy'), focused: document.activeElement === go, still: document.querySelector('.veil .files').inert, dim: Number(getComputedStyle(document.querySelector('.veil .files')).opacity) < 0.7, cancelOff: [...document.querySelectorAll('.veil .btn')].find((b) => b.textContent === 'Cancel').disabled }; })()`);
          check(`${theme}: while the files are added, the card stays with a spinner beside Add to document, the list dimmed and still, and Cancel off`, adding.open && adding.spin && adding.word === 'Add to document' && adding.busy === 'true' && adding.focused && adding.still && adding.dim && adding.cancelOff, JSON.stringify(adding));
          await shot(win, `workspace-add-files-adding-${theme}.png`);
          await press(win, 'Escape');
          check(`${theme}: Esc does not close the card while the files are added`, await js(win, `!!document.querySelector('.veil .primary .spin')`));
          lag = 0;
          await gone(win);
          await until('the pages to be added', async () => (await grid(win)).cells === 7);
          await settled(win);
          const last = calls.filter((x) => x.channel === 'pdfws:apply').at(-1);
          const added = await js(win, `[...document.querySelectorAll('.cell.added')].map((x) => x.dataset.n).join()`);
          check(`${theme}: Add to document puts the file above the document in front of page 1 and the one below it at the end, in one change, and those pages wear the Added tag`, applied() === before + 1 && JSON.stringify(last.args[1].map((o) => [o.op, o.before, o.sources.length])) === '[["pages.insert",4,1],["pages.insert",1,1]]' && added === '1,2,6,7' && (await bar(win)).save, JSON.stringify([last.args, added]));
          const sizes = await js(win, `(async () => { const d = workspaceViewer.viewer.pdfDocument; const out = []; for (let i = 1; i <= d.numPages; i++) { const v = (await d.getPage(i)).view; out.push(Math.round(v[2] - v[0]) + 'x' + Math.round(v[3] - v[1])); } return out.join(); })()`);
          check(`${theme}: and the pages keep their sizes, in the order of the list`, sizes === '400x300,400x300,595x842,595x842,595x842,300x400,300x400', sizes);
          dialog.showOpenDialog = realOpen;
          win.destroy();
          await sleep(500);
          forgetSize();
        }
        nativeTheme.themeSource = 'light';

        {
          const doc = await makePdf('Grid add more.pdf', 2);
          const plain = await sized('Grid join C.pdf', 1, [500, 500]);
          const win = await openAndWait(fresh({ solid: true }), doc);
          win.setSize(900, 600);
          await sleep(600);
          await openGrid(win);
          await sheetsDrawn(win, 2);
          await addFiles(win);
          await sleep(300);
          dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [protectedFile, plain] });
          await cardButton(win, CHOOSE);
          await until('the password card', () => js(win, `!!document.querySelector('.veil input[type="password"]')`));
          check('a protected file asks for its password, by name, before it is listed', (await js(win, `document.querySelector('.veil .fname')?.textContent`)) === 'Grid join protected.pdf');
          await js(win, `(() => { const f = document.querySelector('.veil input'); f.value = ${JSON.stringify(secret)}; f.dispatchEvent(new Event('input')); f.closest('.card').querySelector('.primary').click(); })()`);
          await until('both files to be listed', async () => (await veil(win))?.files?.split('|').length === 3);
          let c = await veil(win);
          check('with the right password it is listed, and the file after it as well', c.files === 'Grid add more.pdf*|Grid join protected.pdf|Grid join C.pdf', JSON.stringify(c));
          await removeRow(win, 'Grid join protected.pdf');
          c = await veil(win);
          check('Remove takes a file out of the list and the focus goes to the row now in its place', c.files === 'Grid add more.pdf*|Grid join C.pdf' && (await js(win, `document.activeElement.closest('.cfile')?.querySelector('.cname').title`)) === 'Grid join C.pdf', JSON.stringify(c));
          await js(win, `document.querySelector('.veil .cfile:not(.me) .grip').focus()`);
          await press(win, 'Up', ['alt']);
          c = await veil(win);
          check('Alt+Up moves a file above the document', c.files === 'Grid join C.pdf|Grid add more.pdf*', JSON.stringify(c));
          const gripAt = await js(win, `(() => { const r = document.querySelector('.veil .cfile .grip').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
          mouse(win, 'mouseMove', gripAt);
          mouse(win, 'mouseDown', gripAt);
          for (let y = gripAt.y; y <= gripAt.y + 60; y += 6) { mouse(win, 'mouseMove', { x: gripAt.x, y }); await sleep(16); }
          await press(win, 'Escape');
          await sleep(300);
          c = await veil(win);
          check('Esc while dragging puts the rows back as they were and keeps the card open', c && c.files === 'Grid join C.pdf|Grid add more.pdf*' && (await js(win, `!document.querySelector('.veil .cfile.lift')`)), JSON.stringify(c));
          mouse(win, 'mouseUp', { x: gripAt.x, y: gripAt.y + 60 });
          await sleep(200);

          const debug = win.webContents.debugger;
          debug.attach('1.3');
          const middle = await js(win, `(() => { const r = document.querySelector('.veil .card').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 30) }; })()`);
          const drag = (type, files, at = middle) => debug.sendCommand('Input.dispatchDragEvent', { type, ...at, data: { items: [], files, dragOperationsMask: 1 } });
          const over = () => js(win, `(() => { const c = document.querySelector('.veil .card'); const o = c.querySelector('.dropover'); const a = c.getBoundingClientRect(); const b = o.getBoundingClientRect(); return { on: c.classList.contains('dropping'), text: o.textContent, opacity: getComputedStyle(o).opacity, covers: b.left - a.left <= 7 && a.right - b.right <= 7 && b.top - a.top <= 7 && a.bottom - b.bottom <= 7 }; })()`);
          await drag('dragEnter', [plain]);
          await drag('dragOver', [plain]);
          await sleep(300);
          let o = await over();
          check('a file dragged over the card turns the whole card into one place that says Drop here', o.on && o.text === 'Drop here' && o.opacity === '1' && o.covers, JSON.stringify(o));
          await shot(win, 'workspace-add-files-drop.png');
          await drag('dragOver', [plain], { x: 60, y: middle.y });
          await sleep(400);
          o = await over();
          check('a drag that moves off the card without dropping puts the card back as it was', !o.on && o.opacity === '0', JSON.stringify(o));
          await drag('dragCancel', [plain]);
          await drag('dragEnter', [plain]);
          await drag('dragOver', [plain]);
          await drag('dragCancel', [plain]);
          await sleep(1500);
          o = await over();
          check('a drag cancelled over the card puts the card back within a second, though no dragleave comes', !o.on && o.opacity === '0', JSON.stringify(o));
          await drag('dragEnter', [plain]);
          await drag('dragOver', [plain]);
          await drag('drop', [plain]);
          await until('the dropped file to be listed', async () => (await veil(win))?.files?.split('|').length === 3);
          c = await veil(win);
          check('a PDF dropped on the card is listed last, the card is itself again, and nothing more is said', c.files === 'Grid join C.pdf|Grid add more.pdf*|Grid join C.pdf' && !(await over()).on && c.line === '', JSON.stringify(c));
          const zipped = path.join(root, 'Grid join notes.zip');
          fs.writeFileSync(zipped, 'not a pdf');
          const letter = path.join(root, 'Grid join letter.docx');
          const { Document, Packer, Paragraph } = require('docx');
          fs.writeFileSync(letter, await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('A letter in Word')] }] })));
          await drag('dragEnter', [zipped, letter]);
          await drag('dragOver', [zipped, letter]);
          await drag('drop', [zipped, letter]);
          await until('the document of the two to be listed', async () => (await veil(win))?.files?.split('|').length === 4);
          c = await veil(win);
          const word = await js(win, `(() => { const r = [...document.querySelectorAll('.veil .cfile')].at(-1); return { meta: r.querySelector('.cmeta').textContent, shapes: r.querySelectorAll('.cicon .picon *').length }; })()`);
          check('a Word document is listed, with its icon, to be made into PDF pages', c.files.endsWith('|Grid join letter.docx') && word.meta === 'Made into PDF pages' && word.shapes > 2, JSON.stringify([c, word]));
          check('a file that cannot be added, dropped with one that can, is left out and the card says so', c.line === 'Only PDFs, pictures and documents can be added', JSON.stringify(c));
          debug.detach();
          await removeRow(win, 'Grid join C.pdf');
          await removeRow(win, 'Grid join C.pdf');
          const before = applied();
          await cardButton(win, 'Add to document');
          await gone(win);
          await until('the pages of the letter', async () => (await grid(win)).cells > 2, 60000);
          await settled(win);
          const last = calls.filter((x) => x.channel === 'pdfws:apply').at(-1);
          check('the document is made into a PDF and its pages go in at the end, tagged, and the engine is sent no path', applied() === before + 1 && last.args[1].length === 1 && last.args[1][0].before === 3 && !JSON.stringify(last.args).includes(letter) && (await js(win, `[...document.querySelectorAll('.cell.added')].map((x) => x.dataset.n).join()`)) === Array.from({ length: (await grid(win)).cells - 2 }, (_, i) => i + 3).join(), JSON.stringify([last.args, await grid(win)]));
          check('the PDF it was made into is not left beside the letter', fs.readdirSync(root).filter((f) => f.startsWith('Grid join letter') && f.endsWith('.pdf')).length === 0);

          const long = await sized('Annual statements and the auditors report for the year ended 31 December 2026 final.pdf', 1, [500, 500]);
          const arabic = await sized('تقرير الميزانية السنوية للعام المالي ألفين وستة النهائي.pdf', 1, [500, 500]);
          await addFiles(win);
          await sleep(300);
          dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [long, arabic, plain, plain, plain, plain] });
          await cardButton(win, CHOOSE);
          await until('the seven files to be listed', async () => (await veil(win))?.files?.split('|').length === 7);
          const listed = () => js(win, `(() => { const l = document.querySelector('.veil .files'); const rows = [...l.children].map((r) => r.getBoundingClientRect()); const box = l.getBoundingClientRect(); const name = l.children[1].querySelector('.cname');
            return { height: Math.round(l.clientHeight), whole: rows.filter((r) => r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5).length, cut: rows.filter((r) => r.top < box.bottom - 0.5 && r.bottom > box.bottom + 0.5).length, more: l.classList.contains('more'),
              shown: name.querySelector('.tail').textContent, cutsMiddle: name.querySelector('.head').scrollWidth > name.querySelector('.head').clientWidth, full: name.textContent, title: name.title, rtl: (() => { const n = l.children[2].querySelector('.cname'); return n.querySelector('.head').getBoundingClientRect().left > n.querySelector('.tail').getBoundingClientRect().left; })() }; })()`);
          let list = await listed();
          check(`seven files show as five whole rows with the last fading, no row cut in half (232 px showed four rows and half of the fifth) (${list.height} px)`, list.whole === 5 && list.cut === 0 && list.more, JSON.stringify(list));
          check('a long name loses its middle, so its end and the extension stay in view, and the whole name is in its tooltip and read out (the end was cut)', list.shown === '2026 final.pdf' && list.cutsMiddle && list.full === path.basename(long) && list.title === path.basename(long), JSON.stringify(list));
          check('a long right-to-left name is cut in its middle too, with its start on the right, so it reads in order (the cut put its start on the left)', list.rtl, JSON.stringify(list));
          await js(win, `document.querySelector('.veil .files').scrollTop = 10000`);
          await sleep(200);
          list = await listed();
          check('scrolled to the end the last row no longer fades', !list.more, JSON.stringify(list));
          await press(win, 'Escape');
          await gone(win);
          dialog.showSaveDialog = realSave;
          dialog.showOpenDialog = realOpen;
          win.destroy();
          await sleep(500);
          forgetSize();
        }
        notices.length = 0;
      }

      console.log('the grid: 3 000 pages');
      {
        const big = await makePdf('Grid change big.pdf', 3000);
        const win = await openAndWait(fresh({ solid: true }), big);
        await openGrid(win, 1500);
        await sheetsDrawn(win, 6);
        await clickCell(win, 1);
        const released = await pull(win, 1, ['left', 8]);
        await settled(win);
        const moved = Date.now() - released;
        check(`a page moved in a file of 3 000 pages is in place in under 6 seconds (${moved} ms)`, moved < 6000 && (await js(win, `document.querySelectorAll('.cell:not(.leaving)').length`)) === 3000 && (await grid(win)).selected === '7', JSON.stringify(await grid(win)));
        await press(win, 'A', ['control']);
        await clickCell(win, 1, ['control']);
        const began = Date.now();
        await press(win, 'Delete');
        await until('the one page', async () => (await js(win, `document.querySelectorAll('.cell:not(.leaving)').length`)) === 1, 20000);
        await settled(win);
        const deleted = Date.now() - began;
        check(`deleting 2 999 pages of 3 000 leaves the one page in under 6 seconds (${deleted} ms)`, deleted < 6000 && (await pages(win)) === '2', `${deleted} ${await pages(win)}`);
        win.destroy();
        await sleep(500);
        fs.rmSync(big, { force: true });
      }
    }
  }

  console.log('the Document panel');
  {
    const engine = !!detectEngines().pdf;
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([595, 842]).drawText('Document panel page', { x: 60, y: 700, size: 22, font });
    doc.setTitle('Annual report');
    doc.setAuthor('Mina Okafor');
    doc.setCreator('Writer');
    const named = path.join(root, 'Report one.pdf');
    fs.writeFileSync(named, await doc.save({ useObjectStreams: false }));
    fs.copyFileSync(named, path.join(root, 'Report two.pdf'));
    const CARDS = engine ? 'File,Description,Document,Security,Fonts' : 'File,Description';

    for (const theme of ['light', 'dark']) {
      nativeTheme.themeSource = theme;
      const win = await openAndWait(fresh(), named);
      const state = () => js(win, `(() => { const g = (id) => document.getElementById(id); const p = g('docpanel'); const b = g('docbtn'); const cards = [...g('docbody').querySelectorAll('section')];
        const card = (title) => cards.find((c) => c.querySelector('h4').textContent === title);
        const facts = (title) => { const s = card(title); return s ? [...s.querySelectorAll('.facts > span')].map((x) => x.textContent).join('|') : null; };
        const name = g('docbody').querySelector('.namefld input');
        return { width: p.getBoundingClientRect().width, pressed: b.getAttribute('aria-pressed'), disabled: b.disabled, title: b.title, head: p.querySelector('h3').textContent, cards: cards.map((c) => c.querySelector('h4').textContent).join(),
          nameValue: name ? name.value : null, ext: name ? name.parentElement.querySelector('span').textContent : null, nameFocused: !!name && document.activeElement === name,
          file: facts('File'), description: facts('Description'), document: facts('Document'), security: facts('Security'), fonts: card('Fonts') ? card('Fonts').querySelector('summary').textContent : null,
          fields: [...g('docbody').querySelectorAll('.fld')].map((i) => i.getAttribute('aria-label') + '=' + i.value).join(), other: g('hitpanel').getBoundingClientRect().width, show: [...g('docbody').querySelectorAll('.pillbtn')].map((x) => x.textContent).join() }; })()`);
      let s = await state();
      check(`${theme}: the title row has a Document info button with its key in the tooltip, and the panel is shut`, s.pressed === 'false' && !s.disabled && s.title === 'Document info (Ctrl+D)' && s.width === 0 && s.cards === '', JSON.stringify(s));
      await js(win, `window.seen = new Set(); new MutationObserver(() => window.seen.add(document.getElementById('docbody').children.length)).observe(document.getElementById('docbody'), { childList: true })`);
      await js(win, `document.getElementById('docbtn').click()`);
      await until('the cards', async () => (await state()).cards === CARDS);
      await sleep(500);
      s = await state();
      check(`${theme}: the button opens a panel headed Document, 312 px wide, with ${CARDS.replace(/,/g, ', ')}`, s.width === 312 && s.pressed === 'true' && s.head === 'Document' && s.cards === CARDS, JSON.stringify(s));
      check(`${theme}: the File card has the name without its extension, the extension beside it, the place, the size, the date and Show`, s.nameValue === 'Report one' && s.ext === '.pdf' && s.file.startsWith('Location|') && s.file.includes('|Size|') && s.file.includes('|Modified|') && s.show === 'Show', JSON.stringify(s));
      check(`${theme}: the Description card holds the four texts of the file, as fields to type in with the engine and as plain text without it`, engine ? s.fields === 'Title=Annual report,Author=Mina Okafor,Subject=,Keywords=' && s.description === 'Title|Author|Subject|Keywords' : s.fields === '' && s.description === 'Title|Annual report|Author|Mina Okafor|Subject|Not set|Keywords|Not set', JSON.stringify([s.fields, s.description]));
      if (engine) {
        const parts = s.document.split('|');
        check(`${theme}: the Document card says the pages, the paper, the version and who made it`, parts[0] === 'Pages' && parts[1] === '1' && parts[3] === 'A4 · 210 × 297 mm' && parts[4] === 'PDF version' && /^\d\.\d$/.test(parts[5]) && parts[7].endsWith('Writer'), JSON.stringify(s.document));
        check(`${theme}: the Security card says there is no password, nothing is held back and there are no signatures, and the Fonts card counts the fonts`, s.security === 'Password|None|Permissions|Everything allowed|Signatures|None' && /^1 font, /.test(s.fonts), JSON.stringify([s.security, s.fonts]));
      }
      const grid = await js(win, `(() => { const cards = [...document.querySelectorAll('#docbody section')]; const rows = []; let lefts = new Set(); for (const c of cards) { const cells = [...c.querySelectorAll('.facts > *')]; for (let i = 0; i + 1 < cells.length; i += 2) { const a = cells[i].getBoundingClientRect(); const b = cells[i + 1].getBoundingClientRect(); rows.push(Math.abs(a.top - b.top)); const cs = getComputedStyle(cells[i + 1]); lefts.add(Math.round(cells[i + 1].matches('.fld') ? b.left + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth) : b.left)); } } const field = document.querySelector('#docbody .namefld').getBoundingClientRect(); const next = document.querySelector('#docbody .facts').getBoundingClientRect(); return { worst: Math.max(...rows), lefts: [...lefts], gap: Math.round(next.top - field.bottom) }; })()`);
      check(`${theme}: in every card a label is level with its value, every value starts at the same left edge, the text in a Description field too, and the name field has 10 px of air below it`, grid.worst < 1 && grid.lefts.length === 1 && grid.gap === 10, JSON.stringify(grid));
      const ink = await js(win, `(() => { const c = (q) => { const e = document.querySelector(q); return e ? getComputedStyle(e) : null; }; return { heading: c('#docbody section > h4').color, ext: c('#docbody .namefld span').color, nameEdge: c('#docbody .namefld').borderBottomColor, fieldEdge: c('#docbody .fld')?.borderBottomColor ?? null, fieldSide: c('#docbody .fld')?.borderLeftColor ?? null, unset: [...document.querySelectorAll('#docbody .unset')].map((e) => getComputedStyle(e).color) }; })()`);
      const muted = theme === 'light' ? 'rgba(0, 0, 0, 0.64)' : 'rgba(255, 255, 255, 0.76)';
      const edge = theme === 'light' ? 'rgba(0, 0, 0, 0.44)' : 'rgba(255, 255, 255, 0.4)';
      check(`${theme}: card headings and the .pdf beside the name are the muted text (measured 6.6:1 light, 8.0:1 dark on the card, where the faint text was 4.0:1 and 5.1:1)`, ink.heading === muted && ink.ext === muted, JSON.stringify(ink));
      check(`${theme}: the name field and the Description fields have a darker bottom edge, at least 3:1 against the field and the card (measured 3.1:1 light and dark, where the line all round was 1.4:1 and 1.65:1), and keep the faint line on their other sides`, ink.nameEdge === edge && (engine ? ink.fieldEdge === edge && ink.fieldSide !== edge : ink.fieldEdge === null), JSON.stringify(ink));
      check(`${theme}: without the engine an empty entry says Not set in the muted text, not in the colour of a value`, engine ? ink.unset.length === 0 : ink.unset.length === 2 && ink.unset.every((c) => c === muted), JSON.stringify(ink));
      const seen = await js(win, `[...window.seen]`);
      check(`${theme}: the cards arrive together, never one and then the rest`, seen.length > 0 && seen.every((n) => n === 0 || n === CARDS.split(',').length), JSON.stringify(seen));
      await shot(win, `workspace-document-${theme}.png`);

      await js(win, `document.getElementById('linksbtn').click()`);
      await sleep(600);
      s = await state();
      check(`${theme}: opening Links shuts the Document panel, so two panels never share the right edge`, s.pressed === 'false' && s.width === 0 && s.other === 300, JSON.stringify(s));
      await js(win, `document.getElementById('linksbtn').click()`);
      await sleep(600);
      await press(win, 'D', ['control']);
      await until('the panel by key', async () => (await state()).width === 312);
      check(`${theme}: Ctrl+D opens the panel`, (await state()).pressed === 'true');
      await press(win, 'D', ['control']);
      await sleep(500);
      s = await state();
      check(`${theme}: and the same key shuts it`, s.pressed === 'false' && s.width === 0, JSON.stringify(s));

      await js(win, `document.getElementById('docname').click()`);
      await until('the name field', async () => (await state()).nameFocused);
      s = await state();
      check(`${theme}: a click on the file name opens the panel with the name ready to type over`, s.pressed === 'true' && s.nameFocused && s.nameValue === 'Report one', JSON.stringify(s));
      const go = () => js(win, `(() => { const b = document.querySelector('#docbody .namefld button'); const c = getComputedStyle(b); return { shown: !b.hidden, text: b.textContent, colour: c.color, height: b.getBoundingClientRect().height, name: document.querySelector('#docbody .namefld input').value }; })()`);
      const before = await go();
      await js(win, `document.execCommand('insertText', false, 'Report one draft')`);
      const typed = await go();
      check(`${theme}: a Rename button shows in the name field only once the name differs, its text at 4.7:1 on its tint in light and 5.9:1 in dark (the accent ink alone was 3.7:1 there)`, !before.shown && typed.shown && typed.text === 'Rename' && typed.height === 24 && typed.colour === (theme === 'light' ? 'rgb(194, 43, 79)' : 'color(srgb 1 0.790196 0.839216)'), JSON.stringify([before, typed]));
      await shot(win, `workspace-document-rename-${theme}.png`);
      await press(win, 'Escape');
      await sleep(200);
      const dropped = await go();
      check(`${theme}: Esc puts the name back and hides Rename`, !dropped.shown && dropped.name === 'Report one', JSON.stringify(dropped));
      await closeAndWait(win);
    }

    nativeTheme.themeSource = 'light';
    const ws = fresh();
    const win = await openAndWait(ws, named);
    const typeName = async (text) => {
      await js(win, `(() => { const i = document.querySelector('#docbody .namefld input'); i.focus(); i.select(); })()`);
      await js(win, `document.execCommand('insertText', false, ${JSON.stringify(text)})`);
      await press(win, 'Return');
    };
    const hint = () => js(win, `document.querySelector('#docbody .hintline') ? document.querySelector('#docbody .hintline').textContent : ''`);
    const shownName = () => js(win, `document.getElementById('docname').textContent`);
    await js(win, `document.getElementById('docbtn').click()`);
    await until('the name field', () => js(win, `!!document.querySelector('#docbody .namefld input')`));
    await typeName('Report two');
    await sleep(300);
    check('a name another file has is refused in words and nothing is renamed', (await hint()) === 'A file with that name is already there' && fs.existsSync(named) && (await shownName()) === 'Report one.pdf', await hint());
    await typeName('bad:name');
    await sleep(300);
    check('a name Windows cannot hold is refused in words', (await hint()) === "That name can't be used" && fs.existsSync(named), await hint());
    await js(win, `(() => { const i = document.querySelector('#docbody .namefld input'); i.focus(); i.select(); })()`);
    await js(win, `document.execCommand('insertText', false, 'Report middle')`);
    await js(win, `document.querySelector('#docbody .namefld input').blur()`);
    await sleep(300);
    check('a typed name stays in the field when the field is left without Enter, with Rename still showing', await js(win, `document.querySelector('#docbody .namefld input').value === 'Report middle' && !document.querySelector('#docbody .namefld button').hidden`) && fs.existsSync(named));
    await js(win, `document.querySelector('#docbody .namefld button').click()`);
    await until('the name from the button', async () => (await shownName()) === 'Report middle.pdf');
    check('the Rename button renames the file', fs.existsSync(path.join(root, 'Report middle.pdf')) && !fs.existsSync(named));
    await sleep(300);
    await typeName('Report final');
    await until('the new name', async () => (await shownName()) === 'Report final.pdf');
    await sleep(500);
    const renamed = await js(win, `({ title: document.title, field: document.querySelector('#docbody .namefld input').value, said: document.querySelector('#docbody .hintline').textContent })`);
    check('a new name renames the file, the title row and the window, and the panel says Renamed', fs.existsSync(path.join(root, 'Report final.pdf')) && !fs.existsSync(named) && renamed.title === 'Report final.pdf - Pomelo' && renamed.field === 'Report final' && renamed.said === 'Renamed', JSON.stringify(renamed));
    await js(win, `document.querySelector('#docbody .pillbtn').click()`);
    await sleep(300);
    check('Show asks Explorer for the renamed file and no other', shown.length === 1 && shown[0] === path.join(root, 'Report final.pdf'), JSON.stringify(shown));
    check('no message about the panel carries a path', calls.filter((c) => /^pdfws:(properties|details|rename|show)$/.test(c.channel)).every((c) => c.args.every((a) => typeof a !== 'string' || !a.includes(root))));

    if (engine) {
      await until('the fields', () => js(win, `!!document.querySelector('#docbody .fld')`));
      await js(win, `window.keptPage = document.querySelector(".page"); window.keptPdf = workspaceViewer.viewer.pdfDocument; 0`);
      await js(win, `(() => { const i = document.querySelector('#docbody .fld'); i.focus(); i.select(); })()`);
      await js(win, `document.execCommand('insertText', false, 'Quarterly report')`);
      await press(win, 'Tab');
      await js(win, `window.author = document.querySelectorAll('#docbody .fld')[1]; document.execCommand('insertText', false, 'Mina Okafor Lee')`);
      await until('the unsaved mark', async () => (await js(win, `!document.getElementById('docdot').hidden`)), 15000);
      await sleep(800);
      const edited = await js(win, `({ dot: !document.getElementById('docdot').hidden, save: !document.getElementById('savebtn').hidden, title: document.querySelector('#docbody .fld').value, author: window.author.value, kept: document.querySelectorAll('#docbody .fld')[1] === window.author, focused: document.activeElement === window.author })`);
      check('a changed Title is a change to the document: the unsaved mark and Save show, and the field keeps what was typed', edited.dot && edited.save && edited.title === 'Quarterly report', JSON.stringify(edited));
      check('text typed in the next field while the change is made stays there, and so does the focus', edited.author === 'Mina Okafor Lee' && edited.kept && edited.focused, JSON.stringify(edited));
      check('the pages are not read again for it: the same page and the same document are still on show', await js(win, `document.querySelector('.page') === window.keptPage && workspaceViewer.viewer.pdfDocument === window.keptPdf`));
      await shot(win, 'workspace-document-edited.png');
      await press(win, 'Escape');
      await sleep(300);
      const backed = await js(win, `({ author: window.author.value, focused: document.activeElement === window.author, open: document.getElementById('docbtn').getAttribute('aria-pressed') })`);
      check('Esc in a Description field puts back its saved text and leaves the field, and the panel stays open', backed.author === 'Mina Okafor' && !backed.focused && backed.open === 'true', JSON.stringify(backed));
      await js(win, `(() => { const i = document.querySelector('#docbody .fld'); i.focus(); i.select(); })()`);
      await js(win, `document.execCommand('insertText', false, 'Annual report')`);
      await press(win, 'Tab');
      await until('no unsaved mark', async () => (await js(win, `document.getElementById('docdot').hidden`)), 15000);
      const reverted = await js(win, `({ save: !document.getElementById('savebtn').hidden, title: document.querySelector('#docbody .fld').value })`);
      check('typing the Title back as the file had it leaves nothing to save: the mark and Save go', !reverted.save && reverted.title === 'Annual report', JSON.stringify(reverted));

      await ws.open([path.join(root, 'Report two.pdf')]);
      await until('the second tab', () => js(win, `document.querySelectorAll('#tabs .tab').length === 2`));
      await js(win, `document.querySelectorAll('#tabs .tab')[0].click()`);
      await until('the first tab\'s fields', () => js(win, `document.querySelectorAll('#docbody .fld').length === 4 && document.querySelector('#docbody .namefld input').value === 'Report final'`));
      await js(win, `(() => { const i = document.querySelectorAll('#docbody .fld')[2]; i.focus(); i.select(); })()`);
      await js(win, `document.execCommand('insertText', false, 'Plans')`);
      await press(win, 'Tab');
      await js(win, `document.querySelectorAll('#tabs .tab')[1].click()`);
      await sleep(3000);
      const other = await js(win, `({ cards: [...document.querySelectorAll('#docbody section h4')].map((h) => h.textContent).join(), name: document.querySelector('#docbody .namefld input')?.value })`);
      check('changing tab while a change is made shows the other document\'s cards, all of them', other.cards === CARDS && other.name === 'Report two', JSON.stringify(other));
      await js(win, `document.querySelectorAll('#tabs .tab')[0].click()`);
      await until('the first tab again', () => js(win, `document.querySelectorAll('#docbody .fld').length === 4 && document.querySelector('#docbody .namefld input').value === 'Report final'`));
      check('and the change was made', (await js(win, `document.querySelectorAll('#docbody .fld')[2].value`)) === 'Plans');
    }
    await js(win, `document.getElementById('docclose').click()`);
    await sleep(500);
    check('the close button in the panel shuts it', (await js(win, `document.getElementById('docbtn').getAttribute('aria-pressed')`)) === 'false');
    win.close();
    await sleep(500);
    if (engine) {
      check('closing with the changed Subject asks first', await js(win, `!!document.querySelector('.card') && document.querySelector('.card h3').textContent === 'Save changes to Report final.pdf?'`));
      await js(win, `[...document.querySelectorAll('.card button')].find((b) => b.textContent === "Don't save").click()`);
      await sleep(500);
    }

    const deep = path.join(root, 'Computer Science Coursework 2026 Semester Two', 'Assignment submissions and marked feedback from the tutors');
    fs.mkdirSync(deep, { recursive: true });
    const longPlace = path.join(deep, 'Report two.pdf');
    fs.copyFileSync(path.join(root, 'Report two.pdf'), longPlace);
    for (const theme of ['light', 'dark']) {
      nativeTheme.themeSource = theme;
      const far = await openAndWait(fresh(), longPlace);
      await js(far, `document.getElementById('docbtn').click()`);
      await until('the folder', () => js(far, `!!document.querySelector('#docbody .folder') && document.querySelector('#docbody .folder').textContent !== ''`));
      await sleep(500);
      const place = await js(far, `(() => { const f = document.querySelector('#docbody .folder').getBoundingClientRect(); const b = document.querySelector('#docbody .pillbtn').getBoundingClientRect(); const panel = document.getElementById('docpanel').getBoundingClientRect(); const row = document.querySelector('#docbody .where').getBoundingClientRect(); const label = document.querySelector('#docbody .facts > span').getBoundingClientRect(); return { height: Math.round(f.height), button: Math.round(b.height), inside: b.right <= panel.right && f.right <= b.left, level: Math.abs(label.top - row.top) < 1, full: document.querySelector('#docbody .folder').title, text: document.querySelector('#docbody .folder').textContent, lines: [...document.querySelectorAll('#docbody .folder > span')].map((s) => Math.round(s.getBoundingClientRect().height / 20)) }; })()`);
      check(`${theme}: a long place wraps beside Show, stops at three lines and keeps its label level with the first line`, place.height <= 68 && place.height > 28 && place.button === 24 && place.inside && place.level, JSON.stringify(place));
      check(`${theme}: the outer folder takes one line and the folder that holds the file the other two, so a long outer folder can no longer hide it, and the tooltip has both`, place.lines.join() === '1,2' && place.text === 'Computer Science Coursework 2026 Semester Two › Assignment submissions and marked feedback from the tutors' && place.full === place.text, JSON.stringify(place));
      await shot(far, `workspace-document-long-place-${theme}.png`);
      await closeAndWait(far);
    }
    nativeTheme.themeSource = 'light';

    const slowly = fresh({ runPdfTool: async (script, ...rest) => { if (script === 'pdf_info.py') await sleep(3000); return runPdfTool(script, ...rest); } });
    const slow = await openAndWait(slowly, path.join(root, 'Report two.pdf'));
    await js(slow, `document.getElementById('docbtn').click()`);
    await sleep(700);
    const waiting = await js(slow, `({ line: !document.getElementById('docloading').hidden, moving: getComputedStyle(document.getElementById('docloading'), '::after').animationName, cards: document.querySelectorAll('#docbody section').length })`);
    check('while a slow engine is asked about the document, a moving line under the heading says the panel is loading (it stayed blank for 2.2 s)', waiting.line && waiting.moving === 'scan' && waiting.cards === 0, JSON.stringify(waiting));
    await shot(slow, 'workspace-document-loading.png');
    await until('the cards after a slow engine', () => js(slow, `[...document.querySelectorAll('#docbody section h4')].map((h) => h.textContent).join() === ${JSON.stringify(CARDS)}`), 15000);
    check('and the line goes once the cards are in', await js(slow, `document.getElementById('docloading').hidden`));
    await closeAndWait(slow);

    const fit = await openAndWait(fresh(), path.join(root, 'Report two.pdf'));
    await press(fit, '0', ['control']);
    await sleep(800);
    await js(fit, `window.renders = 0; workspaceViewer.viewer.eventBus.on('pagerendered', () => window.renders++); document.getElementById('docbtn').click()`);
    await sleep(1200);
    const drawn = await js(fit, `({ renders: window.renders, zoom: workspaceViewer.viewer.currentScaleValue })`);
    check('at Fit width the page is drawn again once the panel has slid in, not on every frame of the slide (it was 21 times)', drawn.zoom === 'page-width' && drawn.renders >= 1 && drawn.renders <= 2, JSON.stringify(drawn));
    await closeAndWait(fit);
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

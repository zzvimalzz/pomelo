// SPDX-License-Identifier: AGPL-3.0-or-later
// Opens the real workspace window on PDFs drawn here: the window's size, place and look in both themes (glass and the opaque
// window of Windows 10), the options pdf.js is given, how many bytes a 40 MB, 300-page file costs to show its first page and while
// idle, a file that is not a PDF, a file that is not there, and that the page is cut off from the network. Saves screenshots.
//   npx electron test/ui/workspace-shot.js
const { app, BrowserWindow, ipcMain, nativeTheme, screen } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument, PDFRawStream, StandardFonts, rgb } = require('pdf-lib');
const { createWorkspace } = require('../../src/features/pdf-workspace');
const { expect: check, failed } = require('../support/expect');
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
const setSettings = (patch) => { settings = { ...settings, ...patch }; };

// One workspace per scenario: the IPC handlers belong to one at a time.
const fresh = (options = {}) => {
  for (const channel of ['pdfws:state', 'pdfws:read']) ipcMain.removeHandler(channel);
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

const inkOnFirstPage = (win) => js(win, `(() => { const c = document.querySelector('.page canvas'); if (!c) return -1; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let dark = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 100 && d[i + 1] < 100 && d[i + 2] < 100) dark++; return dark; })()`);
const closeAndWait = async (win) => { win.close(); await sleep(500); };

app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  const small = await makePdf('Small.pdf', 3);
  const workArea = screen.getPrimaryDisplay().workArea;

  console.log('the window opens on a PDF: size, place, title and page');
  for (const theme of ['light', 'dark']) {
    nativeTheme.themeSource = theme;
    settings = { pdfView: { window: null } };
    const workspace = fresh();
    const win = await openAndWait(workspace, small);
    const b = win.getBounds();
    check(`${theme}: it opens at 1200 x 800 in the middle of the main screen`, b.width === 1200 && b.height === 800 && Math.abs(b.x - (workArea.x + (workArea.width - 1200) / 2)) <= 1 && Math.abs(b.y - (workArea.y + (workArea.height - 800) / 2)) <= 1, JSON.stringify([b, workArea]));
    check(`${theme}: it is resizable down to 900 x 600 and shows the file's name`, win.isResizable() && win.getMinimumSize().join('x') === '900x600' && win.getTitle() === 'Small.pdf - Pomelo' && win.isVisible(), `${win.getMinimumSize()} ${win.getTitle()}`);
    const ui = await js(win, `({ name: document.getElementById('docname').textContent, failure: document.getElementById('failure').hidden, pages: document.querySelectorAll('.page').length,
      text: document.querySelector('.textLayer')?.textContent || '', solid: document.documentElement.classList.contains('solid'), glass: getComputedStyle(document.querySelector('.window')).backgroundColor,
      fit: (() => { const p = document.querySelector('.page').getBoundingClientRect(); const s = document.getElementById('scroller').getBoundingClientRect(); return p.top >= s.top - 1 && p.bottom <= s.bottom + 1; })() })`);
    check(`${theme}: the title row names the file, there is no failure, and the document has its three pages`, ui.name === 'Small.pdf' && ui.failure && ui.pages === 3, JSON.stringify(ui));
    check(`${theme}: the first page is drawn with ink on it, its text is selectable, and it fits the window`, (await inkOnFirstPage(win)) > 500 && /Pomelo test page 1 of 3/.test(ui.text) && ui.fit, `${await inkOnFirstPage(win)} ${ui.text} fit ${ui.fit}`);
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
    check(`${theme}: and still shows the page`, (await inkOnFirstPage(win)) > 500);
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
    check('a saved place that is on no screen opens in the middle of the main screen at 1200 x 800', lost.width === 1200 && lost.height === 800 && Math.abs(lost.x - (workArea.x + (workArea.width - 1200) / 2)) <= 1 && !win.isMaximized(), JSON.stringify(lost));
    await closeAndWait(win);
    settings = { pdfView: 'not a place' };
    win = await openAndWait(fresh(), small);
    check('a stored value that is not a place is ignored', win.getBounds().width === 1200);
    await closeAndWait(win);
  }

  console.log('a big file costs nothing until it is read');
  {
    const big = await makePdf('Big.pdf', 300, { extraBytes: 40 * 1048576 });
    const size = fs.statSync(big).size;
    const workspace = fresh();
    const win = await openAndWait(workspace, big);
    await sleep(500);
    const first = workspace.served();
    const canvases = await js(win, `document.querySelectorAll('.page canvas').length`);
    check(`opening ${Math.round(size / 1048576)} MB with 300 pages serves under 4 MB to draw the first page (${(first / 1048576).toFixed(2)} MB)`, first > 0 && first < 4 * 1048576, String(first));
    check('the document has 300 pages and fewer than 20 of them are drawn', (await js(win, `document.querySelectorAll('.page').length`)) === 300 && canvases > 0 && canvases < 20, String(canvases));
    await sleep(5000);
    check('five idle seconds later nothing more has been read', workspace.served() === first, `${first} -> ${workspace.served()}`);
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

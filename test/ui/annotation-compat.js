// SPDX-License-Identifier: AGPL-3.0-or-later
// Select, Highlight, Draw and Text in the real workspace window, drawn with the mouse and keyboard and saved: where each mark lands on pages that are
// upright, turned, offset or cropped, what another reader (PyMuPDF) finds in the saved file, and that the engine's way of writing never calls
// pdf.js's own save. Without the engine pdf.js writes the file for files up to the save limit; a larger file asks for the engine and writes
// nothing. Needs the PDF engine for most of it (that part is skipped without it).
//   npx electron test/ui/annotation-compat.js
const { app, ipcMain } = require('electron');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { PDFDocument, PDFName, PDFNumber, PDFRawStream, StandardFonts, degrees } = require('pdf-lib');
const { createWorkspace } = require('../../src/features/pdf-workspace');
const { NO_ENGINE_SAVE_LIMIT } = require('../../src/features/pdf-workspace/documents');
const { uniquePath, runPdfTool, detectEngines, probeLocked, checkPassword, asPdf, pdfSourceExts, convertFile, targetsFor, explainNoTargets } = require('../../src/features/conversion');
const { expect: check, failed } = require('../support/expect');
const finish = require('../support/finish');
const { dir: tmpDir } = require('../support/tmp');

app.on('window-all-closed', () => {});
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const asset = (n) => path.join(__dirname, '..', '..', 'assets', n);
const root = tmpDir('annotation-compat');
const python = detectEngines().pdf;
const notices = [];
const handle = ipcMain.handle.bind(ipcMain);
const calls = [];
ipcMain.handle = (channel, fn) => handle(channel, (event, ...args) => { calls.push(channel); return fn(event, ...args); });
const CHANNELS = ['pdfws:state', 'pdfws:read', 'pdfws:unlock', 'pdfws:close', 'pdfws:drop', 'pdfws:focus', 'pdfws:dock', 'pdfws:view', 'pdfws:check-link', 'pdfws:open-link', 'pdfws:copy-link', 'pdfws:copy-links', 'pdfws:put-revision', 'pdfws:apply', 'pdfws:undo', 'pdfws:redo', 'pdfws:save', 'pdfws:save-as', 'pdfws:choose-sources', 'pdfws:drop-sources', 'pdfws:unlock-source', 'pdfws:extract', 'pdfws:split-plan', 'pdfws:split', 'pdfws:reload', 'pdfws:close-window', 'pdfws:properties', 'pdfws:details', 'pdfws:rename', 'pdfws:show', 'pdfws:engine', 'pdfws:install-engine', 'pdfws:convert-targets', 'pdfws:convert'];
const js = (win, code) => win.webContents.executeJavaScript(code);
const until = async (what, fn, ms = 20000) => {
  for (let waited = 0; waited < ms; waited += 100) { if (await fn()) return true; await sleep(100); }
  console.log(`  (gave up waiting for ${what})`);
  return false;
};

function fresh(engine) {
  for (const channel of CHANNELS) ipcMain.removeHandler(channel);
  const workspace = createWorkspace({
    hasPdfEngine: () => engine, asset, getSettings: () => ({ pdfView: { window: null } }), setSettings: () => {}, notify: (m) => notices.push(m), log: () => {},
    openExternal: () => Promise.resolve(), copyText: () => {}, uniquePath, runPdfTool, probeLocked, checkPassword, asPdf, pdfSourceExts,
    makePdf: (src, outDir, signal) => convertFile(src, 'pdf', { outDir, signal }), showInFolder: () => {}, targetsFor: (file) => targetsFor([file]), explainNoTargets, convert: () => {},
  });
  workspace.registerIpc();
  return workspace;
}

// A page with two lines of text and, when asked, the page conditions that move where things sit: a turn, a media box that does not start
// at 0, 0, a smaller crop box, a user unit, an annotation made by another program.
async function makeDoc(name, { turn = 0, media = [0, 0, 595, 842], crop = null, unit = 0, link = false, bytes = 0 } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.setMediaBox(...media);
  if (crop) page.setCropBox(...crop);
  const [x, y, , h] = crop ?? media;
  page.drawText('Alpha beta gamma delta', { x: x + 60, y: y + h - 120, size: 20, font });
  page.drawText('Second line of the page', { x: x + 60, y: y + h - 260, size: 20, font });
  if (turn) page.setRotation(degrees(turn));
  if (unit) page.node.set(PDFName.of('UserUnit'), PDFNumber.of(unit));
  if (link) page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [x + 60, y + h - 125, x + 200, y + h - 100], Border: [0, 0, 0], A: { S: 'URI', URI: 'https://example.com/' } }))]));
  if (bytes) doc.context.register(PDFRawStream.of(doc.context.obj({}), crypto.randomBytes(bytes)));
  const file = path.join(root, name);
  fs.writeFileSync(file, await doc.save({ useObjectStreams: false }));
  return file;
}

// What a file holds, as PyMuPDF reads it: the annotations (kind, rectangle, colour, opacity, text, vertices) and the first line's words, all in
// the page as it is shown, from its top left corner, with the page's size and whether the file was repaired.
const SEE = String.raw`import json, sys, pymupdf
d = pymupdf.open(sys.argv[1])
p = d[0]
turn = p.rotation_matrix
def shown(r): r = pymupdf.Rect(r) * turn; r.normalize(); return [r.x0, r.y0, r.x1, r.y1]
notes = []
for a in p.annots():
    pts = []
    for s in (a.vertices or []):
        if isinstance(s, tuple): pts.append(tuple(pymupdf.Point(s) * turn))
        else: pts.extend(tuple(pymupdf.Point(q) * turn) for q in s)
    notes.append({"type": a.type[1], "rect": shown(a.rect), "colors": a.colors, "opacity": a.opacity, "content": a.info.get("content", ""), "border": a.border, "points": pts, "ap": bool(d.xref_get_key(a.xref, "AP")[0] != "null"), "da": d.xref_get_key(a.xref, "DA")[1]})
words = [{"text": w[4], "rect": shown(w[:4])} for w in p.get_text("words")]
print(json.dumps({"annots": notes, "links": len(p.get_links()), "words": words, "size": [p.rect.width, p.rect.height], "repaired": d.is_repaired, "rotation": p.rotation}))`;
const see = (file) => {
  const r = childProcess.spawnSync(python, ['-W', 'ignore', '-c', SEE, file], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
};

const mouse = (win, type, x, y) => win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, modifiers: type === 'mouseUp' ? [] : ['leftButtonDown'] });
const drag = async (win, from, to) => {
  win.webContents.focus();
  mouse(win, 'mouseMove', ...from);
  mouse(win, 'mouseDown', ...from);
  for (let i = 1; i <= 10; i++) { mouse(win, 'mouseMove', from[0] + ((to[0] - from[0]) * i) / 10, from[1] + ((to[1] - from[1]) * i) / 10); await sleep(25); }
  mouse(win, 'mouseUp', ...to);
  await sleep(500);
};
const type = async (win, text) => { for (const ch of text) for (const t of ['keyDown', 'char', 'keyUp']) win.webContents.sendInputEvent({ type: t, keyCode: ch }); await sleep(300); };
const press = async (win, keyCode, modifiers = []) => { win.webContents.focus(); for (const t of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type: t, keyCode, modifiers }); await sleep(300); };
const tool = (win, title) => js(win, `[...document.querySelectorAll('.dock .tool')].find((b) => b.getAttribute('aria-label') === ${JSON.stringify(title)}).click()`).then(() => sleep(500));
const barOf = (win) => js(win, `(() => { const bar = document.querySelector('.optbar:not([hidden])'); return bar ? [...bar.querySelectorAll('button, .size')].map((b) => b.title || b.textContent).join('|') : ''; })()`);
const state = (win) => js(win, `({ save: !document.getElementById('savebtn').hidden, dot: !document.getElementById('docdot').hidden, tools: [...document.querySelectorAll('.dock .tool')].map((b) => b.title).join('|'), on: [...document.querySelectorAll('.dock .tool.on')].map((b) => b.getAttribute('aria-label')).join() })`);
const closeAndWait = async (win) => { win.close(); await sleep(500); };
const click = async (win, a, b) => {
  if (typeof a === 'number') { mouse(win, 'mouseMove', a, b); mouse(win, 'mouseDown', a, b); mouse(win, 'mouseUp', a, b); } else await js(win, `[...document.querySelectorAll('.optbar:not([hidden]) button')].find((x) => x.title === ${JSON.stringify(a)} || x.textContent === ${JSON.stringify(a)}).click()`);
  await sleep(400);
};
const push = (win, title) => js(win, `[...document.querySelectorAll('.editpill button')].find((b) => b.title.startsWith(${JSON.stringify(title)})).click()`).then(() => sleep(500));

async function open(workspace, file) {
  await workspace.open([file]);
  const win = workspace.getWindow();
  await until('the first page', () => js(win, `!!document.querySelector('.page[data-loaded="true"] canvas') && !!document.querySelector('.textLayer span')`));
  await sleep(500);
  return win;
}

// Where things are on screen: the first page's box and the first line's text, in client pixels, and the pixels of one point of the page.
const where = (win, needle = 'Alpha', centre = false) => js(win, `(() => { const n = [...document.querySelectorAll('.textLayer span')].find((s) => s.textContent.includes(${JSON.stringify(needle)}));
  if (${centre}) { n.scrollIntoView({ block: 'start' }); n.closest('.page').parentElement.parentElement.scrollBy(0, -120); } else document.querySelector('.page').scrollIntoView({ block: 'start' });
  const p = document.querySelector('.page').getBoundingClientRect(); const s = n.getBoundingClientRect();
  return { page: [p.left, p.top, p.width, p.height], line: [s.left, s.top, s.right, s.bottom] }; })()`);

async function typeBox(win, click) {
  await tool(win, 'Text');
  mouse(win, 'mouseMove', ...click);
  mouse(win, 'mouseDown', ...click);
  mouse(win, 'mouseUp', ...click);
  await sleep(400);
  await type(win, 'Hello cafe');
}

// The floating option bar covers the lower part of a page that fits the window, where the first line of a page turned 180 lies; it is
// let through for the drag over the text.
// Highlights the first line, draws a stroke and types a text box, then saves over the file. Returns what was meant: the stroke and the click
// in points of the page as shown, and what the file now holds.
async function mark(win, file, { turn = 0, text = true }) {
  await tool(win, 'Highlight');
  const first = await where(win, 'Alpha', true);
  await js(win, `document.querySelectorAll('.optbar').forEach((b) => { b.style.pointerEvents = 'none'; })`);
  await drag(win, ...along(first.line, turn));
  await js(win, `document.querySelectorAll('.optbar').forEach((b) => { b.style.pointerEvents = ''; })`);
  const at = await where(win);
  await tool(win, 'Draw');
  const [px, py, pw, ph] = at.page;
  const stroke = [[px + pw * 0.2, py + ph * 0.5], [px + pw * 0.6, py + ph * 0.6]];
  await drag(win, stroke[0], stroke[1]);
  const click = [px + pw * 0.2, py + ph * 0.75];
  if (text) await typeBox(win, click);
  const before = fs.statSync(file).mtimeMs;
  await js(win, `document.getElementById('savebtn').click()`);
  await until('the question about the original', () => js(win, `!!document.querySelector('.card .btn.primary')`), 15000);
  await js(win, `[...document.querySelectorAll('.card .btn')].find((b) => b.textContent === 'Replace').click()`);
  await until('the saved file', () => fs.statSync(file).mtimeMs !== before, 15000);
  await sleep(500);
  return { stroke, click, at };
}

const near = (a, b, by) => a.every((v, i) => Math.abs(v - b[i]) <= by);

// The two ends of a drag along a line of text, in the direction the page's turn makes it read.
const along = ([x0, y0, x1, y1], turn) => {
  const [mx, my] = [(x0 + x1) / 2, (y0 + y1) / 2];
  const [gx, gy] = [(x1 - x0) * 0.1, (y1 - y0) * 0.1];
  return { 0: [[x0 + gx, my], [x1 - gx, my]], 90: [[mx, y0 + gy], [mx, y1 - gy]], 180: [[x1 - gx, my], [x0 + gx, my]], 270: [[mx, y1 - gy], [mx, y0 + gy]] }[turn];
};
const union = (words) => [0, 1, 2, 3].map((i) => (i < 2 ? Math.min : Math.max)(...words.map((w) => w.rect[i])));

async function conditions() {
  const turned = (turn) => ({ turn });
  const cases = {
    upright: {}, 'turned 90': turned(90), 'turned 180': turned(180), 'turned 270': turned(270),
    'a media box that does not start at 0, 0': { media: [100, 60, 595, 842] }, 'a crop box inside the media box': { crop: [40, 50, 500, 700] },
    'a user unit of 2': { unit: 2, text: false }, 'an annotation made by another program': { link: true },
  };
  for (const [name, options] of Object.entries(cases)) {
    console.log(`with the PDF engine: ${name}`);
    const file = await makeDoc(`${name.replace(/\W+/g, '-')}.pdf`, options);
    const original = fs.readFileSync(file);
    const workspace = fresh(true);
    const win = await open(workspace, file);
    await js(win, `window.counted = 0; const pdf = workspaceViewer.viewer.pdfDocument; for (const call of ['saveDocument', 'getData']) { const was = pdf[call].bind(pdf); pdf[call] = (...a) => { window.counted++; return was(...a); }; } null`);
    const meant = await mark(win, file, options);
    check('pdf.js was never asked to write or copy the file', (await js(win, 'window.counted')) === 0);
    const saved = see(file);
    const kinds = saved.annots.map((a) => a.type);
    const mine = saved.annots.filter((a) => ['Highlight', 'Ink', 'FreeText'].includes(a.type));
    const expected = options.text === false ? ['Highlight', 'Ink'] : ['Highlight', 'Ink', 'FreeText'];
    check('the file holds what was drawn, and what was there before', kinds.join() === expected.join() && saved.links === (options.link ? 1 : 0), JSON.stringify([kinds, saved.links]));
    check('it was added to the end of the file and reads without repair', fs.readFileSync(file).subarray(0, original.length).equals(original) && !saved.repaired);
    const line = union(saved.words.filter((w) => ['Alpha', 'beta', 'gamma', 'delta'].includes(w.text)));
    const highlight = mine.find((a) => a.type === 'Highlight');
    const margin = options.unit ? 16 : 9;
    const long = line[2] - line[0] > line[3] - line[1] ? 0 : 1;
    check('the highlight lies on the line it was dragged over and covers most of it', highlight && highlight.rect.every((v, i) => (i < 2 ? v >= line[i] - margin : v <= line[i] + margin))
      && highlight.rect[long + 2] - highlight.rect[long] >= 0.7 * (line[long + 2] - line[long]), JSON.stringify([highlight?.rect, line]));
    check('it is yellow, has an appearance and no unwanted transparency', highlight && near(highlight.colors.stroke.map((c) => Math.round(c * 255)), [255, 216, 77], 2) && highlight.ap, JSON.stringify(highlight?.colors));
    const ink = mine.find((a) => a.type === 'Ink');
    const scale = meant.at.page[2] / saved.size[0];
    const wanted = meant.stroke.map(([x, y]) => [(x - meant.at.page[0]) / scale, (y - meant.at.page[1]) / scale]);
    const xs = ink?.points.map((p) => p[0]) ?? [];
    const ys = ink?.points.map((p) => p[1]) ?? [];
    check('the stroke lies along the line that was drawn', ink && near([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], [wanted[0][0], wanted[0][1], wanted[1][0], wanted[1][1]], 4), JSON.stringify([ink?.rect, wanted]));
    if (options.text !== false) {
      const text = mine.find((a) => a.type === 'FreeText');
      const sat = [(meant.click[0] - meant.at.page[0]) / scale, (meant.click[1] - meant.at.page[1]) / scale];
      check('the text box holds what was typed and starts where the page was clicked', text && text.content === 'Hello cafe' && near(text.rect.slice(0, 2), sat, 16), JSON.stringify([text?.content, text?.rect, sat]));
    }
    await closeAndWait(win);
  }
}

async function otherTab() {
  console.log('markup and another tab');
  const first = await makeDoc('Tab one.pdf');
  const second = await makeDoc('Tab two.pdf');
  const workspace = fresh(true);
  const win = await open(workspace, first);
  await tool(win, 'Highlight');
  await drag(win, ...along((await where(win)).line, 0));
  await workspace.open([second]);
  await until('the second tab', () => js(win, `document.querySelectorAll('#tabs .tab').length === 2 && document.querySelector('#tabs .tab.on')?.textContent.includes('Tab two')`));
  await sleep(800);
  const other = await state(win);
  check('the other tab shows no change and no tool', !other.save && other.on === '', JSON.stringify(other));
  await js(win, `document.querySelectorAll('#tabs .tab')[0].click()`);
  await until('the first tab', () => js(win, `!!document.querySelector('.page[data-loaded="true"] canvas')`));
  await sleep(800);
  const back = await state(win);
  const drawn = await js(win, `document.querySelectorAll('.annotationLayer section').length`);
  check('leaving a tab wrote its markup: coming back, the page draws the highlight and the tab has a change to save', back.save && drawn === 1, JSON.stringify([back, drawn]));
  await closeAndWait(win);
}

async function scaledPageText() {
  console.log('a text box on a page with a user unit of 2');
  const file = await makeDoc('Unit-text.pdf', { unit: 2 });
  const bytes = fs.readFileSync(file);
  const win = await open(fresh(true), file);
  const at = await where(win);
  await typeBox(win, [at.page[0] + at.page[2] * 0.2, at.page[1] + at.page[3] * 0.3]);
  await js(win, `document.getElementById('savebtn').click()`);
  const card = await until('the card', () => js(win, `[...document.querySelectorAll('.card h3')].some((h) => h.textContent === "Can't save this markup")`), 15000);
  check('it is not saved, a card says so, and the file is untouched', card && fs.readFileSync(file).equals(bytes));
  await closeAndWait(win);
}

async function withoutEngine() {
  console.log('without the PDF engine');
  const small = await makeDoc('Small.pdf');
  const bytes = fs.readFileSync(small);
  const win = await open(fresh(false), small);
  await tool(win, 'Highlight');
  const at = await where(win);
  await drag(win, [at.line[0] + 2, (at.line[1] + at.line[3]) / 2], [at.line[2] - 2, (at.line[1] + at.line[3]) / 2]);
  check('a highlight made without the engine marks the document as changed', (await state(win)).save);
  await js(win, `document.getElementById('savebtn').click()`);
  await until('the question about the original', () => js(win, `!!document.querySelector('.card .btn.primary')`), 15000);
  await js(win, `[...document.querySelectorAll('.card .btn')].find((b) => b.textContent === 'Replace').click()`);
  await until('the saved file', () => !fs.readFileSync(small).equals(bytes), 15000);
  const kept = fs.readFileSync(small).subarray(0, bytes.length).equals(bytes);
  if (python) {
    const saved = see(small);
    check('pdf.js wrote it: the file holds the highlight after the original bytes, and reads without repair', saved.annots.map((a) => a.type).join() === 'Highlight' && kept && !saved.repaired);
  } else {
    check('pdf.js wrote it after the original bytes', kept);
  }
  await closeAndWait(win);

  const large = await makeDoc('Large.pdf', { bytes: NO_ENGINE_SAVE_LIMIT + 1024 * 1024 });
  const before = fs.statSync(large).size;
  calls.length = 0;
  const big = await open(fresh(false), large);
  await tool(big, 'Highlight');
  const there = await where(big);
  await drag(big, [there.line[0] + 2, (there.line[1] + there.line[3]) / 2], [there.line[2] - 2, (there.line[1] + there.line[3]) / 2]);
  await js(big, `document.getElementById('savebtn').click()`);
  const card = await until('the engine card', () => js(big, `[...document.querySelectorAll('.card h3')].some((h) => h.textContent === 'Saving changes to a file this large needs the PDF engine.')`), 20000);
  check('a file over the limit asks for the engine, and nothing is written', card && fs.statSync(large).size === before && !calls.includes('pdfws:put-revision'), JSON.stringify([card, calls]));
  await closeAndWait(big);
}

async function bars() {
  console.log('the tools and their option bars');
  const file = await makeDoc('Bars.pdf');
  const win = await open(fresh(true), file);
  const idle = await state(win);
  check('the dock has Select, Highlight, Draw, Text and Eraser, and nothing is on', ['Select (V)', 'Highlight (H)', 'Draw (D)', 'Text (T)', 'Eraser (E)'].every((t) => idle.tools.includes(t)) && idle.on === '' && !idle.save, JSON.stringify(idle));
  check('the title row has only Save and the document buttons', (await js(win, `!document.getElementById('undobtn') && !document.getElementById('redobtn') && !document.getElementById('clearbtn')`)));
  await tool(win, 'Select');
  check('Select and Eraser have no option bar', (await barOf(win)) === '' && (await tool(win, 'Eraser'), (await barOf(win)) === '') && (await tool(win, 'Eraser'), true), await barOf(win));
  await tool(win, 'Highlight');
  check('Highlight shows three colours and More colours', (await barOf(win)) === 'Yellow|Green|Pink|More colours', await barOf(win));
  await tool(win, 'Draw');
  check('Draw shows Pen and Marker, three colours with More colours, and three thicknesses', (await barOf(win)) === 'Pen|Marker|Black|Red|Blue|More colours|1 pt|2 pt|4 pt', await barOf(win));
  await tool(win, 'Text');
  check('Text shows its size with Smaller and Larger, three colours with More colours, and three fonts', (await barOf(win)) === 'Smaller|12 pt|Larger|Black|Red|Blue|More colours|Helvetica|Times|Courier', await barOf(win));
  await tool(win, 'Text');
  check('choosing the tool in use again puts it down', (await state(win)).on === '' && (await barOf(win)) === '');
  await press(win, 'h');
  check('the H key picks Highlight, and Esc puts it down', (await state(win)).on === 'Highlight' && (await press(win, 'Escape'), (await state(win)).on === ''));
  await press(win, 'v');
  check('the V key picks Select', (await state(win)).on === 'Select');
  await press(win, 'Escape');

  const at = await where(win);
  await tool(win, 'Highlight');
  await drag(win, ...along(at.line, 0));
  await drag(win, ...along((await where(win, 'Second')).line, 0));
  check('a highlight puts the dot and the Save button up', (await state(win)).save && (await state(win)).dot);
  const entries = () => js(win, `workspaceViewer.viewer.pdfDocument.annotationStorage.serializable.map?.size ?? 0`);
  const two = await entries();
  await push(win, 'Undo');
  check('Undo takes the last mark away and the document is still changed', two === 2 && (await entries()) === 1 && (await state(win)).save, JSON.stringify([two, await entries(), await state(win)]));
  await push(win, 'Undo');
  await sleep(300);
  check('Undo again and there is nothing to save', (await entries()) === 0 && !(await state(win)).save);
  await closeAndWait(win);
}

async function behaviour() {
  console.log('choices, the floating buttons, the colour panels and the Select tool');
  const file = await makeDoc('Behaviour.pdf');
  const win = await open(fresh(true), file);
  const entries = () => js(win, `[...(workspaceViewer.viewer.pdfDocument.annotationStorage.serializable.map?.values() ?? [])].map((e) => ({ opacity: e.opacity, quads: !!e.quadPoints, strokes: e.paths?.points?.length ?? 0, kind: e.annotationType }))`);
  const head = () => js(win, `['Undo', 'Redo', 'Clear all'].map((t) => [...document.querySelectorAll('.editpill button')].find((b) => b.title.startsWith(t)).disabled).join()`);
  check('Undo, Redo and Clear all float over the page, all off while there is nothing to change', !(await js(win, `document.querySelector('.editpill').hidden`)) && (await head()) === 'true,true,true', await head());
  check('they stand clear of the title row and of the dock', await js(win, `(() => { const p = document.querySelector('.editpill').getBoundingClientRect(); const d = document.querySelector('.dock').getBoundingClientRect(); return p.bottom < d.top || p.top > d.bottom || p.right < d.left || p.left > d.right; })()`));

  const at = await where(win);
  const [px, py, pw, ph] = at.page;
  const line = at.line;
  await tool(win, 'Highlight');
  mouse(win, 'mouseMove', px + pw * 0.5, py + ph * 0.22);
  await sleep(200);
  const dot = await js(win, `(() => { const d = document.querySelector('.hdot'); return { shown: !d.hidden, colour: getComputedStyle(d).backgroundColor, layer: getComputedStyle(document.querySelector('.textLayer')).cursor }; })()`);
  check('over the empty page the highlighter is a dot of its colour and the pointer is hidden', dot.shown && dot.colour === 'rgb(255, 216, 77)' && dot.layer === 'none', JSON.stringify(dot));
  mouse(win, 'mouseMove', line[0] + 40, (line[1] + line[3]) / 2);
  await sleep(200);
  const over = await js(win, `({ shown: !document.querySelector('.hdot').hidden, cursor: getComputedStyle([...document.querySelectorAll('.textLayer span')].find((s) => s.textContent.includes('Alpha'))).cursor })`);
  check('over a word the dot is gone and the text cursor shows', !over.shown && over.cursor !== 'none', JSON.stringify(over));

  await drag(win, ...along(line, 0));
  mouse(win, 'mouseMove', line[0] + 40, (line[1] + line[3]) / 2);
  mouse(win, 'mouseDown', line[0] + 40, (line[1] + line[3]) / 2);
  mouse(win, 'mouseUp', line[0] + 40, (line[1] + line[3]) / 2);
  await sleep(500);
  check('in Highlight nothing is selected, not the new highlight and not one that was pressed', (await js(win, `document.querySelectorAll('.selectedEditor').length`)) === 0);
  await drag(win, [px + pw * 0.15, py + 8], [px + pw * 0.8, py + 24]);
  check('nor is a free-form highlight', (await js(win, `document.querySelectorAll('.selectedEditor').length`)) === 0);
  const second = (await where(win, 'Second')).line;
  const sy = (second[1] + second[3]) / 2;
  mouse(win, 'mouseMove', second[0] + 3, sy);
  await sleep(300);
  check('just before the first letter the highlighter is still the words cursor, not the dot', await js(win, `document.querySelector('.hdot').hidden`));
  const textMarks = async () => (await entries()).filter((e) => e.quads).length;
  const had = await textMarks();
  await drag(win, [second[0] + 3, sy], [second[0] + 100, sy]);
  check('a drag from there takes the first letter in', (await textMarks()) === had + 1);
  mouse(win, 'mouseMove', second[0] + 20, sy);
  mouse(win, 'mouseDown', second[0] + 20, sy);
  mouse(win, 'mouseMove', px + pw * 0.5, py + ph * 0.3);
  await sleep(300);
  const away = await js(win, `({ dot: document.querySelector('.hdot').hidden, text: getComputedStyle(document.querySelector('.textLayer')).cursor })`);
  mouse(win, 'mouseUp', px + pw * 0.5, py + ph * 0.3);
  await sleep(500);
  check('a drag that began on a word keeps the words cursor when it leaves the text', away.dot && away.text.includes('cursor-editorTextHighlight'), JSON.stringify(away));
  const [lx, ly] = [line[0] + 40, (line[1] + line[3]) / 2];
  mouse(win, 'mouseMove', lx, ly);
  await sleep(300);
  const under = await js(win, `(() => { const e = document.elementFromPoint(${lx}, ${ly}); return [!e.closest('.highlightEditor'), document.querySelectorAll('.hovered').length, getComputedStyle(e).cursor !== 'pointer']; })()`);
  check('a highlight under the highlighter takes no pointer and shows no outline', under.join() === 'true,0,true', under.join());
  await click(win, 'Pink');
  await drag(win, ...along(line, 0));
  const pixels = await win.webContents.capturePage({ x: Math.round(line[0]), y: Math.round(line[1]), width: Math.round(line[2] - line[0]), height: Math.round(line[3] - line[1]) });
  const bmp = pixels.toBitmap();
  const { width, height } = pixels.getSize();
  const colours = new Set();
  for (let x = 0; x < width; x += 3) { const i = (Math.floor(height * 0.15) * width + x) * 4; colours.add(`${bmp[i + 2]},${bmp[i + 1]},${bmp[i]}`); }
  check('a second colour laid over the first mixes with it', [...colours].some((c) => { const [r, g, b] = c.split(',').map(Number); return r > 240 && g > 100 && g < 200 && b < 100; }), [...colours].join(' '));
  await click(win, 'Yellow');
  check('a drag over empty page makes a free-form highlight', (await entries()).some((e) => !e.quads), JSON.stringify(await entries()));
  await tool(win, 'Highlight');

  console.log('  colour panels');
  for (const [name, count] of [['Highlight', 20], ['Draw', 20], ['Text', 20]]) {
    await tool(win, name);
    await click(win, 'More colours');
    const panel = await js(win, `[...document.querySelectorAll('.palette button')].map((b) => b.title)`);
    check(`${name} has a panel of at least ${count} colours`, panel.length >= count && new Set(panel).size === panel.length, String(panel.length));
    await press(win, 'Escape');
    check(`Esc shuts the ${name} panel and leaves the tool on`, !(await js(win, `!!document.querySelector('.palette')`)) && (await state(win)).on === name);
  }
  await tool(win, 'Draw');
  await click(win, 'More colours');
  check('Draw offers white', await js(win, `!!document.querySelector('.palette button[title="White"]')`));
  await js(win, `document.querySelector('.palette button[title="White"]').click()`);
  await sleep(300);
  const more = await js(win, `(() => { const b = document.querySelector('.sw.more'); return [getComputedStyle(b).backgroundColor, b.getAttribute('aria-checked'), !!document.querySelector('.palette')]; })()`);
  check('picking a colour shuts the panel and the button shows the colour', more[0] === 'rgb(255, 255, 255)' && more[1] === 'true' && !more[2], JSON.stringify(more));
  await click(win, 'Black');

  console.log('  drawing on');
  const before = (await entries()).length;
  const start = [px + pw * 0.2, py + ph * 0.62];
  await drag(win, start, [px + pw * 0.5, py + ph * 0.62]);
  await drag(win, [px + pw * 0.35, py + ph * 0.62], [px + pw * 0.35, py + ph * 0.68]);
  await tool(win, 'Select');
  const added = (await entries()).slice(before);
  check('lifting the pen and drawing from a point on the stroke adds a second stroke and moves nothing', added.reduce((sum, e) => sum + e.strokes, 0) === 2, JSON.stringify(added));

  await tool(win, 'Draw');
  await click(win, 'Pen');
  await drag(win, [px + pw * 0.2, py + ph * 0.4], [px + pw * 0.5, py + ph * 0.45]);
  await click(win, 'Marker');
  await drag(win, [px + pw * 0.2, py + ph * 0.5], [px + pw * 0.5, py + ph * 0.55]);
  await click(win, 'Pen');
  const kinds = (await entries()).slice(before + added.length).map((e) => e.opacity).join();
  check('choosing Marker after a Pen stroke, and Pen after that, leaves each stroke as it was drawn', kinds === '1,0.4', kinds);

  await js(win, `[...document.querySelectorAll('.dock .tool')].find((b) => b.getAttribute('aria-label') === 'More').click()`);
  await sleep(500);
  check('the option bar steps aside while a dock menu is open', (await js(win, `getComputedStyle(document.querySelector('.optbar:not([hidden])')).opacity`)) === '0');
  await press(win, 'Escape');
  await tool(win, 'Draw');

  console.log('  the Select tool');
  await tool(win, 'Select');
  const stroke = () => js(win, `(() => { const near = (e) => { const r = e.getBoundingClientRect(); return Math.abs(r.top + r.height / 2 - ${py + ph * 0.425}); }; const r = [...document.querySelectorAll('.inkEditor')].sort((a, b) => near(a) - near(b))[0].getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()`);
  const first = await stroke();
  const centre = [first[0] + first[2] / 2, first[1] + first[3] / 2];
  await click(win, ...centre);
  check('a click on a stroke selects it', (await js(win, `document.querySelectorAll('.inkEditor.selectedEditor').length`)) === 1);
  await drag(win, centre, [centre[0] + 40, centre[1]]);
  const moved = await js(win, `document.querySelector('.inkEditor.selectedEditor').getBoundingClientRect().left`);
  check('a drag in Select moves it', Math.abs(moved - first[0] - 40) < 6, JSON.stringify([first, moved]));
  const marks = (await entries()).length;
  await tool(win, 'Eraser');
  check('the Eraser tool is on, and nothing is selected', (await state(win)).on === 'Eraser' && (await js(win, `document.body.dataset.tool === 'eraser' && document.querySelectorAll('.selectedEditor').length === 0`)));
  const hit = await js(win, `(() => { const r = document.querySelector('.inkEditor').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  mouse(win, 'mouseMove', ...hit);
  await sleep(500);
  check('the pointer is an eraser, drawn by the page', await js(win, `!document.querySelector('.ecur').hidden && !!document.querySelector('.ecur svg') && getComputedStyle(document.querySelector('.inkEditor')).cursor === 'none'`));
  await click(win, ...hit);
  check('a click on a mark with the Eraser takes it away', (await entries()).length === marks - 1, JSON.stringify([marks, (await entries()).length]));
  await push(win, 'Undo');
  check('Undo brings it back', (await entries()).length === marks);
  await push(win, 'Redo');
  await drag(win, [px + pw * 0.4, py + ph * 0.3], [px + pw * 0.4, py + ph * 0.75]);
  check('dragging the Eraser across marks takes each away', (await entries()).length < marks - 1, String((await entries()).length));
  await press(win, 'Escape');

  console.log('  Undo, Redo and Clear all');
  check('Undo and Clear all are on and Redo is off', (await head()) === 'false,true,false', await head());
  await tool(win, 'Draw');
  const all = (await entries()).length;
  await push(win, 'Clear all');
  check('Clear all takes every mark away and leaves nothing to save', (await entries()).length === 0 && !(await state(win)).save, JSON.stringify([await entries(), await state(win)]));
  await push(win, 'Undo');
  check('Undo brings them back', (await entries()).length === all, String((await entries()).length));

  await tool(win, 'Text');
  await click(win, 'Times');
  mouse(win, 'mouseMove', px + pw * 0.2, py + ph * 0.75);
  mouse(win, 'mouseDown', px + pw * 0.2, py + ph * 0.75);
  mouse(win, 'mouseUp', px + pw * 0.2, py + ph * 0.75);
  await sleep(400);
  await type(win, 'Hello cafe');
  check('a text box takes the font chosen', (await js(win, `document.querySelector('.freeTextEditor')?.dataset.font`)) === 'Times');
  await tool(win, 'Select');
  const written = (await entries()).length;
  const textHighlights = (await entries()).filter((e) => e.quads).length;
  const before2 = fs.statSync(file).mtimeMs;
  await js(win, `document.getElementById('savebtn').click()`);
  await until('the question about the original', () => js(win, `!!document.querySelector('.card .btn.primary')`), 15000);
  await js(win, `[...document.querySelectorAll('.card .btn')].find((b) => b.textContent === 'Replace').click()`);
  await until('the saved file', () => fs.statSync(file).mtimeMs !== before2, 15000);
  const saved = see(file);
  const note = saved.annots.find((a) => a.type === 'FreeText');
  check('the saved text box is in that font', !!note && note.da.includes('/TiRo '), note?.da);
  check('every mark in the window is in the file, the free-form highlight as an ink stroke', saved.annots.length === written && saved.annots.filter((a) => a.type === 'Ink').length === written - textHighlights - 1, JSON.stringify([written, saved.annots.map((a) => a.type)]));
  await closeAndWait(win);
}

app.whenReady().then(async () => {
  if (!python) console.log('  PDF engine not installed: the engine scenarios are skipped');
  if (python) { await bars(); await behaviour(); await conditions(); await scaledPageText(); await otherTab(); }
  await withoutEngine();
  console.log(failed() ? `\n${failed()} failed` : '\nall passed');
  finish();
}).catch((e) => { console.error(e); finish(2); });

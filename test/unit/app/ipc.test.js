// SPDX-License-Identifier: AGPL-3.0-or-later
// Every IPC module is registered against a fake ipcMain, and the channels the preloads use are compared with the channels that got
// a handler: no page can ask for something nobody answers, and nobody listens for a message no page sends.
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { expect } = require('../../support/expect');
const finish = require('../../support/finish');

const unlockRequests = [];
const cards = [];
const registered = { handle: new Set(), on: new Set(), once: new Set() };
const handlers = {};
const ipcMain = Object.fromEntries(['handle', 'on', 'once'].map((kind) => [kind, (channel, fn) => { registered[kind].add(channel); handlers[channel] = fn; }]));
const noop = () => {};
const fakeElectron = {
  ipcMain, dialog: {}, clipboard: {}, shell: {}, screen: {}, BrowserWindow: class {}, app: {},
};
const realLoad = Module._load;
Module._load = (request, ...rest) => (request === 'electron' ? fakeElectron : realLoad(request, ...rest));

const features = path.join(__dirname, '..', '..', '..', 'src', 'features');
const quiet = { log: noop, sendToSettings: noop };

console.log('registering the IPC modules');
require(path.join(features, 'gesture', 'wheel.ipc')).registerWheelIpc({ onLog: noop, onReady: noop, onDrop: noop, onPick: noop, onCancel: noop, onUnlock: (request) => { unlockRequests.push(request); return { state: 'ok' }; }, onCard: (rect) => cards.push(rect), isWheel: (sender) => sender === 'the wheel page' });
require(path.join(features, 'jobs', 'toast.ipc')).registerToastIpc({ onReady: noop, onRemove: noop, onCancel: noop, onClick: noop });
const stored = [];
require(path.join(features, 'settings', 'settings.ipc')).registerSettingsIpc({ store: { get: () => ({}), set: (patch) => stored.push(patch) }, getState: noop, onChange: noop, logPath: noop, describe: noop, history: noop });
const served = [];
const unlocked = [];
const focused = [];
const docks = [];
const opened = [];
const copied = [];
const views = [];
const closed = [];
const dropped = [];
const revisions = [];
require(path.join(features, 'pdf-workspace', 'workspace.ipc')).registerWorkspaceIpc({
  documents: { read: (...args) => { served.push(args); return 'bytes'; }, unlock: (...args) => { unlocked.push(args); } }, state: () => ({ documents: [] }), closeDocument: (token) => closed.push(token), openDropped: (paths) => dropped.push(paths),
  putRevision: (...args) => { revisions.push(['put', ...args]); return { info: {} }; }, apply: (...args) => { revisions.push(['apply', ...args]); return { info: {} }; }, undo: (token) => revisions.push(['undo', token]), redo: (token) => revisions.push(['redo', token]), save: (token) => revisions.push(['save', token]),
  saveAs: (token) => revisions.push(['save-as', token]), reload: (token) => revisions.push(['reload', token]), closeWindow: () => revisions.push(['close-window']),
  properties: (token) => revisions.push(['properties', token]), details: (token) => revisions.push(['details', token]), rename: (...args) => revisions.push(['rename', ...args]), showInFolder: (token) => revisions.push(['show', token]),
  engine: () => { revisions.push(['engine']); return true; }, installEngine: () => { revisions.push(['install-engine']); return { ok: true }; },
  chooseSources: (kind) => revisions.push(['choose-sources', kind]), dropSources: (paths) => revisions.push(['drop-sources', paths]), unlockSource: (...args) => revisions.push(['unlock-source', ...args]), extract: (...args) => revisions.push(['extract', ...args]),
  setFocus: (on) => focused.push(on), setDock: (side) => docks.push(side), setView: (patch) => views.push(patch), checkLink: (url) => (url === 'https://ok.test/' ? url : null), openLink: (url) => opened.push(url), copyLink: (url) => copied.push(url), copyLinks: (urls) => { copied.push(urls); return urls.length; }, isWorkspace: (sender) => sender === 'the workspace page',
});
const imaged = [];
require(path.join(features, 'image-editor', 'editor.ipc')).registerEditorIpc({
  images: { pixels: (...args) => { imaged.push(['pixels', ...args]); return 'bytes'; }, pixelsDone: (token) => imaged.push(['pixels-done', token]) },
  state: () => ({ images: [] }), closeImage: (token) => imaged.push(['close', token]), openDropped: (paths) => imaged.push(['drop', paths]), showInFolder: (token) => imaged.push(['show', token]),
  setView: (patch) => imaged.push(['view', patch]), setFullScreen: (on) => imaged.push(['full-screen', on]), closeWindow: () => imaged.push(['close-window']), isEditor: (sender) => sender === 'the editor page',
});
require(path.join(features, 'engine-setup', 'engine-setup.ipc')).registerEngineSetupIpc({ installer: {}, getEngines: noop, ...quiet });
require(path.join(features, 'updates', 'updates.ipc')).registerUpdatesIpc({ current: '0.0.0', autoCheck: {}, onChecked: noop, isPackaged: false, execPath: '', isSettingsOpen: noop, downloader: {}, stopForUpdate: noop, exit: noop, ...quiet });
require(path.join(features, 'uninstall', 'uninstall.ipc')).registerUninstallIpc({ installer: {}, getWindow: noop, setLoginItem: noop, isPackaged: false, execPath: '', quit: noop, log: noop });
Module._load = realLoad;

// A page can clear the output folder but never set one: only the folder dialog stores a path.
handlers['settings:set']({}, { theme: 'dark', outputDir: 'C:/somewhere' });
handlers['settings:set']({}, { outputDir: '' });
expect('a page cannot choose the output folder, only clear it', stored[0].outputDir === undefined && stored[0].theme === 'dark' && stored[1].outputDir === '', JSON.stringify(stored));
handlers['settings:set']({}, { enabled: 'yes', theme: 'neon', autoUpdate: true, lastUpdateCheck: 1, constructor: true, toString: true });
handlers['settings:set']({}, null);
expect('a page can set only its own settings, and only to values they can hold', JSON.stringify(stored.slice(2)) === '[{"autoUpdate":true},{}]', JSON.stringify(stored.slice(2)));

// Only the workspace window's own page may ask for a document's bytes.
const refused = (call) => { try { call(); return false; } catch { return true; } };
expect('another page is refused the document state, the bytes and the password', refused(() => handlers['pdfws:state']({ sender: 'another page' })) && refused(() => handlers['pdfws:read']({ sender: 'another page' }, 'token', 0, 10))
  && refused(() => handlers['pdfws:unlock']({ sender: 'another page' }, 'token', 'secret')) && served.length === 0 && unlocked.length === 0);
expect('the workspace page is answered', handlers['pdfws:read']({ sender: 'the workspace page' }, 'token', 0, 10) === 'bytes' && JSON.stringify(served) === '[["token",0,10]]' && handlers['pdfws:state']({ sender: 'the workspace page' }).documents.length === 0);
handlers['pdfws:unlock']({ sender: 'the workspace page' }, 'token', 'secret');
expect('the workspace page can give the password of its document', JSON.stringify(unlocked) === '[["token","secret"]]');

// Only the workspace window's own page may close a tab or hand over a drop.
expect('another page cannot close a document or open files, the workspace page can', refused(() => handlers['pdfws:close']({ sender: 'another page' }, 'token')) && refused(() => handlers['pdfws:drop']({ sender: 'another page' }, ['C:/a.pdf'])) && closed.length === 0 && dropped.length === 0
  && (handlers['pdfws:close']({ sender: 'the workspace page' }, 'token'), handlers['pdfws:drop']({ sender: 'the workspace page' }, ['C:/a.pdf']), JSON.stringify(closed) === '["token"]' && JSON.stringify(dropped) === '[["C:/a.pdf"]]'), JSON.stringify([closed, dropped]));

// Only the workspace window's own page may move the dock; the value is checked where the setting is kept.
expect('another page cannot move the dock, the workspace page can', refused(() => handlers['pdfws:dock']({ sender: 'another page' }, 'left')) && docks.length === 0 && (handlers['pdfws:dock']({ sender: 'the workspace page' }, 'left'), JSON.stringify(docks) === '["left"]'));

// Only the workspace window's own page may ask for full screen, and only with a plain true or false.
expect('another page cannot change full screen', refused(() => handlers['pdfws:focus']({ sender: 'another page' }, true)) && focused.length === 0);
for (const on of [true, false, 'yes', 1, undefined]) handlers['pdfws:focus']({ sender: 'the workspace page' }, on);
expect('the workspace page can enter and leave full screen, and anything but true leaves it', JSON.stringify(focused) === '[true,false,false,false,false]', JSON.stringify(focused));

// Only the workspace window's own page may ask about or open a link; what is checked and opened is decided by the functions it is given.
expect('another page cannot change the remembered view, the workspace page can', refused(() => handlers['pdfws:view']({ sender: 'another page' }, { zoom: 1 })) && views.length === 0 && (handlers['pdfws:view']({ sender: 'the workspace page' }, { zoom: 1 }), JSON.stringify(views) === '[{"zoom":1}]'));
expect('another page can neither check, open nor copy a link', refused(() => handlers['pdfws:check-link']({ sender: 'another page' }, 'https://ok.test/')) && refused(() => handlers['pdfws:open-link']({ sender: 'another page' }, 'https://ok.test/'))
  && refused(() => handlers['pdfws:copy-link']({ sender: 'another page' }, 'https://ok.test/')) && opened.length === 0 && copied.length === 0);
handlers['pdfws:copy-link']({ sender: 'the workspace page' }, 'https://ok.test/');
handlers['pdfws:open-link']({ sender: 'the workspace page' }, 'https://ok.test/');
expect('the workspace page can check a link and open one', handlers['pdfws:check-link']({ sender: 'the workspace page' }, 'https://ok.test/') === 'https://ok.test/' && handlers['pdfws:check-link']({ sender: 'the workspace page' }, 'file:///x') === null && JSON.stringify(opened) === '["https://ok.test/"]' && JSON.stringify(copied) === '["https://ok.test/"]');
expect('another page cannot copy a list of links, the workspace page can', refused(() => handlers['pdfws:copy-links']({ sender: 'another page' }, ['https://ok.test/'])) && copied.length === 1 && handlers['pdfws:copy-links']({ sender: 'the workspace page' }, ['a', 'b']) === 2 && JSON.stringify(copied.at(-1)) === '["a","b"]');

// Only the workspace window's own page may change a document's revisions, save it or close the window.
const revisionCalls = [['put-revision', 'token', new Uint8Array(4)], ['apply', 'token', [{ op: 'pages.delete', pages: [1] }]], ['undo', 'token'], ['redo', 'token'], ['save', 'token'], ['save-as', 'token'], ['reload', 'token'], ['close-window'], ['properties', 'token'], ['details', 'token'], ['rename', 'token', 'New name'], ['show', 'token'], ['engine'], ['install-engine'], ['choose-sources', 'pdf'], ['drop-sources', ['C:/a.pdf']], ['unlock-source', 'id', 'secret'], ['extract', 'token', [1, 2]]];
expect('another page cannot put a revision, ask for a change, step through them, save, reload, close the window, ask about a document, rename it, show it, ask about the PDF engine, install it, choose or drop files to insert, give a password for one or extract pages', revisionCalls.every(([channel, ...args]) => refused(() => handlers[`pdfws:${channel}`]({ sender: 'another page' }, ...args))) && revisions.length === 0);
for (const [channel, ...args] of revisionCalls) handlers[`pdfws:${channel}`]({ sender: 'the workspace page' }, ...args);
expect('the workspace page can', JSON.stringify(revisions.map((r) => r[0])) === '["put","apply","undo","redo","save","save-as","reload","close-window","properties","details","rename","show","engine","install-engine","choose-sources","drop-sources","unlock-source","extract"]' && revisions[0][1] === 'token' && revisions[0][2].length === 4, JSON.stringify(revisions));

// Only the image editor's own page may ask for a picture's pixels or change its window.
const editorCalls = [['state'], ['pixels', 'token', 0, 4], ['pixels-done', 'token'], ['close', 'token'], ['drop', ['C:/a.png']], ['show', 'token'], ['view', { panel: true }], ['full-screen', true], ['close-window']];
expect('another page cannot ask the editor for anything', editorCalls.every(([channel, ...args]) => refused(() => handlers[`imged:${channel}`]({ sender: 'another page' }, ...args))) && imaged.length === 0);
for (const [channel, ...args] of editorCalls) handlers[`imged:${channel}`]({ sender: 'the editor page' }, ...args);
handlers['imged:full-screen']({ sender: 'the editor page' }, 'yes');
expect('the editor page can, and full screen is only ever on or off', JSON.stringify(imaged.map((c) => c[0])) === '["pixels","pixels-done","close","drop","show","view","full-screen","close-window","full-screen"]' && imaged.at(-1)[1] === false && imaged[0][1] === 'token', JSON.stringify(imaged));

// Only the wheel page may send a password, and only in the one shape the card uses.
const unlockBad = [['another page', { token: 't', password: 'p', all: false }], ['the wheel page', null], ['the wheel page', { token: 1, password: 'p', all: false }], ['the wheel page', { token: 't', password: 5, all: false }], ['the wheel page', { token: 't', password: 'p', all: 'yes' }]];
expect('the password channel refuses another page and anything but a token, a string and a flag', unlockBad.every(([sender, request]) => refused(() => handlers['wheel:unlock']({ sender }, request))) && unlockRequests.length === 0);
expect('and passes on a well-formed request without the extra fields it was given', handlers['wheel:unlock']({ sender: 'the wheel page' }, { token: 't', password: 'p', all: true, path: 'C:/x' }).state === 'ok' && JSON.stringify(unlockRequests) === '[{"token":"t","password":"p","all":true}]');

const box = { x: 20, y: 30, width: 336, height: 200 };
for (const [sender, rect] of [['another page', box], ['the wheel page', undefined], ['the wheel page', 'big'], ['the wheel page', { ...box, width: 'wide' }], ['the wheel page', { ...box, y: NaN }], ['the wheel page', { x: 1, y: 2 }]]) handlers['wheel:card']({ sender }, rect);
handlers['wheel:card']({ sender: 'the wheel page' }, { ...box, extra: 'x' });
handlers['wheel:card']({ sender: 'the wheel page' }, null);
expect('only the wheel page can say where the card is, as four numbers or as none, and nothing else is passed on', JSON.stringify(cards) === JSON.stringify([box, null]), JSON.stringify(cards));

// What each preload sends to the main process, with ipcRenderer invoke or send
const asked = new Set();
const listened = new Set();
for (const dir of fs.readdirSync(features)) {
  const preload = path.join(features, dir, 'ui', 'preload.js');
  if (!fs.existsSync(preload)) continue;
  const src = fs.readFileSync(preload, 'utf8');
  for (const m of src.matchAll(/ipcRenderer\.(?:invoke|send)\(\s*'([^']+)'/g)) asked.add(m[1]);
  for (const m of src.matchAll(/ipcRenderer\.on\(\s*'([^']+)'/g)) listened.add(m[1]);
}
const handled = new Set([...registered.handle, ...registered.on, ...registered.once]);
const missing = [...asked].filter((c) => !handled.has(c));
const orphaned = [...handled].filter((c) => !asked.has(c));

expect(`every channel a page sends has a handler (${asked.size} channels)`, missing.length === 0, missing.join(', '));
expect('every handler answers a channel some page sends', orphaned.length === 0, orphaned.join(', '));
expect('invoke channels are handled with handle, so the page gets an answer', ['settings:get', 'settings:set', 'wheel:unlock', 'pdfws:state', 'pdfws:read', 'pdfws:unlock', 'pdfws:focus', 'pdfws:dock', 'pdfws:view', 'pdfws:check-link', 'pdfws:open-link', 'pdfws:copy-link', 'pdfws:copy-links', 'pdfws:put-revision', 'pdfws:apply', 'pdfws:undo', 'pdfws:redo', 'pdfws:save', 'pdfws:save-as', 'pdfws:reload', 'pdfws:close-window', 'pdfws:properties', 'pdfws:details', 'pdfws:rename', 'pdfws:show', 'pdfws:engine', 'pdfws:install-engine', 'pdfws:choose-sources', 'pdfws:drop-sources', 'pdfws:unlock-source', 'pdfws:extract', 'pdfws:split-plan', 'pdfws:split', 'engines:install', 'app:uninstall', 'updates:check', 'updates:download', 'updates:install'].every((c) => registered.handle.has(c)));

// What the main process sends to a page, with webContents.send or the sendToSettings helper, anywhere under src.
const sent = new Set();
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.js$/.test(e.name) ? [path.join(d, e.name)] : []));
for (const f of walk(path.join(features, '..'))) {
  for (const m of fs.readFileSync(f, 'utf8').matchAll(/(?:webContents\.send|sendToSettings)\(\s*'([^']+)'/g)) sent.add(m[1]);
}
const unsent = [...listened].filter((c) => !sent.has(c));
expect(`every message a page listens for is sent by the main process (${listened.size} channels)`, unsent.length === 0, unsent.join(', '));

finish();

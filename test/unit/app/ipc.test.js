// SPDX-License-Identifier: AGPL-3.0-or-later
// Every IPC module is registered against a fake ipcMain, and the channels the preloads use are compared with the channels that got
// a handler: no page can ask for something nobody answers, and nobody listens for a message no page sends.
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { expect } = require('../../support/expect');
const finish = require('../../support/finish');

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
require(path.join(features, 'gesture', 'wheel.ipc')).registerWheelIpc({ onLog: noop, onReady: noop, onDrop: noop, onPick: noop, onCancel: noop });
require(path.join(features, 'jobs', 'toast.ipc')).registerToastIpc({ onReady: noop, onRemove: noop, onCancel: noop, onClick: noop });
const stored = [];
require(path.join(features, 'settings', 'settings.ipc')).registerSettingsIpc({ store: { get: () => ({}), set: (patch) => stored.push(patch) }, getState: noop, onChange: noop, logPath: noop, onOpenGuide: noop });
require(path.join(features, 'engine-setup', 'engine-setup.ipc')).registerEngineSetupIpc({ installer: {}, getEngines: noop, ...quiet });
require(path.join(features, 'updates', 'updates.ipc')).registerUpdatesIpc({ current: '0.0.0', autoCheck: {}, onChecked: noop, isPackaged: false, execPath: '', isSettingsOpen: noop, downloader: {}, stopForUpdate: noop, exit: noop, ...quiet });
require(path.join(features, 'guide', 'guide.ipc')).registerGuideIpc({ getTargets: noop });
require(path.join(features, 'uninstall', 'uninstall.ipc')).registerUninstallIpc({ installer: {}, getWindow: noop, setLoginItem: noop, isPackaged: false, execPath: '', quit: noop, log: noop });
Module._load = realLoad;

// A page can clear the output folder but never set one: only the folder dialog stores a path.
handlers['settings:set']({}, { theme: 'dark', outputDir: 'C:/somewhere' });
handlers['settings:set']({}, { outputDir: '' });
expect('a page cannot choose the output folder, only clear it', stored[0].outputDir === undefined && stored[0].theme === 'dark' && stored[1].outputDir === '', JSON.stringify(stored));

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
expect('invoke channels are handled with handle, so the page gets an answer', ['settings:get', 'settings:set', 'engines:install', 'app:uninstall', 'updates:check', 'updates:download', 'updates:install'].every((c) => registered.handle.has(c)));

// What the main process sends to a page, with webContents.send or the sendToSettings helper, anywhere under src.
const sent = new Set();
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.js$/.test(e.name) ? [path.join(d, e.name)] : []));
for (const f of walk(path.join(features, '..'))) {
  for (const m of fs.readFileSync(f, 'utf8').matchAll(/(?:webContents\.send|sendToSettings)\(\s*'([^']+)'/g)) sent.add(m[1]);
}
const unsent = [...listened].filter((c) => !sent.has(c));
expect(`every message a page listens for is sent by the main process (${listened.size} channels)`, unsent.length === 0, unsent.join(', '));

finish();

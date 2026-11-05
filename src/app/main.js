// SPDX-License-Identifier: AGPL-3.0-or-later
// Pomelo's entry point (package.json "main"): starts the features and connects them. Features never import each other; what one
// needs from another is handed in here.
const path = require('path');
const { app } = require('electron');
const log = require('../shared/node/log');
const { userDataFile } = require('../shared/electron/user-data');

log.setFile(userDataFile('debug.log'));             // first, so everything below can log

const { APP_ROOT } = require('../shared/node/paths');
const conversion = require('../features/conversion');
const { createStore, openSettingsWindow, getSettingsWindow, registerSettingsIpc } = require('../features/settings');
const { InputHelper, Trigger, WheelWindow } = require('../features/gesture');
const { Jobs, Timings, Toast } = require('../features/jobs');
const updates = require('../features/updates');
const engineSetup = require('../features/engine-setup');
const { registerUninstallIpc } = require('../features/uninstall');
const { createTray } = require('./tray');
const { createDropFlow } = require('./drop-flow');
const { stopAll } = require('./shutdown');

const cli = engineSetup.parseCommandLine(process.argv);     // --install-engines / --uninstall-engines: run by the installer, no window, no tray
if (!cli && !app.requestSingleInstanceLock()) app.exit(0);
app.on('window-all-closed', () => { /* tray app: keep running */ });
app.on('second-instance', () => openSettings());

const asset = (n) => path.join(APP_ROOT, 'assets', n);
const settings = createStore(userDataFile('settings.json'));
const installer = engineSetup.createInstaller({ redetect: () => conversion.detectEngines() });
let tray, wheel, jobs, trigger, helper;

const openSettings = () => openSettingsWindow(asset);
const sendToSettings = (channel, payload) => getSettingsWindow()?.webContents.send(channel, payload);

// Looks for a newer version when the user has switched "Check automatically" on, and only says so: the download
// starts when the user presses the button in Settings.
const autoUpdate = new updates.AutoUpdate({
  getSettings: () => settings.get(),
  setSettings: (patch) => settings.set(patch),
  check: () => updates.check({ current: app.getVersion() }),
  onAvailable: (r) => {
    log('update available:', r.latest);
    sendToSettings('updates:found', r);          // an open Settings window switches to "Download update"
    jobs?.addInfo({ title: `Pomelo ${r.latest} is available`, detail: 'Open Settings from the tray icon and press Download update.' });
    updateTray();
  },
});
const updateTray = () => tray?.setTooltip(autoUpdate.available ? `Pomelo: version ${autoUpdate.available.latest} is available` : 'Pomelo');

// Login starts are silent (tray only). Running from source, Windows must be told which app folder to open.
const setLoginItem = (openAtLogin) => app.setLoginItemSettings({ openAtLogin, args: [...(app.isPackaged ? [] : [app.getAppPath()]), '--hidden'] });

function applySettings() {
  const s = settings.get();
  trigger.setKey(s.key);
  helper.setKey(s.key);
  trigger.setEnabled(s.enabled);
  setLoginItem(s.openAtLogin);
  tray?.refreshMenu();
}

app.whenReady().then(async () => {
  if (cli) {
    const say = (line) => { console.log(line); log('cli:', line); };
    const code = await engineSetup.runCommandLine(cli, { installer, setLoginItem, say, progress: engineSetup.fileProgress(cli.progressFile) });
    setTimeout(() => app.exit(code), 500);                  // lets the last lines of output reach a pipe before the process ends
    return;
  }
  settings.set({}); // materialise defaults
  log(`--- started v${app.getVersion()} build ${log.build.slice(0, 12)}; log at`, log.path());
  conversion.detectEngines();

  helper = new InputHelper();
  helper.start();

  const flow = createDropFlow({ conversion, getWheel: () => wheel, getJobs: () => jobs, log });
  wheel = new WheelWindow({ onDrop: flow.onDrop });
  wheel.create();
  jobs = new Jobs({
    formats: conversion.timingFormats,
    timings: new Timings(userDataFile('timings.json'), conversion.timingFormats.kinds),
    convert: (src, to, opts) => conversion.convertFile(src, to, opts).catch((e) => { log('convert failed:', path.basename(src), e.message); throw e; }),
  });
  const toast = new Toast({ onRemove: (id) => jobs.remove(id), onCancel: (id) => jobs.cancel(id) });
  toast.create();
  jobs.on('change', (view) => toast.update(view));

  trigger = new Trigger(helper);
  trigger.on('open', flow.onOpen);
  trigger.on('unsupported', () => jobs.addInfo({ title: 'Nothing to convert here', detail: 'Drag a file or folder from Explorer or the desktop.' }));
  trigger.on('release', () => wheel.releaseSoon());
  trigger.on('cancel', () => wheel.hide());
  trigger.start();

  tray = createTray({
    icon: asset('tray.png'), getSettings: () => settings.get(), onSettings: openSettings, onQuit: () => app.quit(),
    setEnabled: (enabled) => { settings.set({ enabled }); applySettings(); },
  });

  const setup = engineSetup.registerEngineSetupIpc({ installer, getEngines: conversion.getEngines, sendToSettings, log });
  registerSettingsIpc({
    store: settings,
    getState: () => ({ engines: conversion.getEngines(), installing: setup.getInstalling(), version: app.getVersion(), os: `Windows ${process.getSystemVersion()} ${process.arch}`, update: autoUpdate.available }),
    onChange: (patch) => { applySettings(); if ('autoUpdate' in patch) autoUpdate.apply(); },
    logPath: log.path,
  });
  registerUninstallIpc({ installer, getWindow: getSettingsWindow, setLoginItem, isPackaged: app.isPackaged, execPath: process.execPath, quit: () => app.quit(), log });
  updates.registerUpdatesIpc({
    current: app.getVersion(), autoCheck: autoUpdate, onChecked: updateTray, isPackaged: app.isPackaged, execPath: process.execPath,
    sendToSettings, stopForUpdate: () => stopAll(helper), exit: (code) => app.exit(code), log,
  });

  applySettings();
  autoUpdate.apply();
  updates.reportUpdate({ argv: process.argv, current: app.getVersion(), notify: (m) => jobs.addInfo(m), cleanup: updates.cleanup, log });   // started again by an in-app update
  log('ready');
  // Show the window on every manual launch so there is always a visible way in; login starts stay in the tray.
  if (!process.argv.includes('--hidden')) openSettings();
});

app.on('will-quit', () => stopAll(helper));

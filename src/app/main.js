// SPDX-License-Identifier: AGPL-3.0-or-later
// Pomelo's entry point (package.json "main"): starts the features and connects them. Features never import each other; what one
// needs from another is handed in here.
const fs = require('fs');
const path = require('path');
const { app, nativeTheme } = require('electron');
const log = require('#shared/node/log');
const { userDataFile } = require('#shared/electron/user-data');

log.setFile(userDataFile('debug.log'));             // first, so everything below can log

const { APP_ROOT } = require('#shared/node/paths');
const conversion = require('../features/conversion');
const { createStore, openSettingsWindow, getSettingsWindow, registerSettingsIpc } = require('../features/settings');
const { InputHelper, Trigger, WheelWindow } = require('../features/gesture');
const { Jobs, Timings, Toast } = require('../features/jobs');
const updates = require('../features/updates');
const engineSetup = require('../features/engine-setup');
const { registerUninstallIpc } = require('../features/uninstall');
const { createTray } = require('./tray');
const { createDropFlow } = require('./drop-flow');
const { createOutputDir, folderName } = require('./output-dir');
const { installShellMenu, removeShellMenu, convertPathsFromArgv, createBatcher } = require('./shell-menu');
const { stopAll } = require('./shutdown');

const cli = engineSetup.parseCommandLine(process.argv);     // --install-engines / --uninstall-engines: run by the installer, no window, no tray
if (!cli && !app.requestSingleInstanceLock()) app.exit(0);
app.on('window-all-closed', () => { /* tray app: keep running */ });
// Explorer's right-click menu starts Pomelo once per selected file: the primary instance gathers them and opens one wheel.
let flow;
const convertBatch = createBatcher(400, (files) => app.whenReady().then(() => flow.onOpen(files, true)));
app.on('second-instance', (_e, argv) => {
  const files = convertPathsFromArgv(argv);
  if (files.length) convertBatch.add(files); else openSettings();
});

const asset = (n) => path.join(APP_ROOT, 'assets', n);
const settingsFile = userDataFile('settings.json');
const firstRun = !fs.existsSync(settingsFile);         // checked before the store writes the file: only a new install opens on the Help page
const settings = createStore(settingsFile);
const installer = engineSetup.createInstaller({ redetect: () => conversion.detectEngines() });
let tray, wheel, jobs, trigger, helper;

const openSettings = (target) => openSettingsWindow(asset, target);
const sendToSettings = (channel, payload) => getSettingsWindow()?.webContents.send(channel, payload);
const downloader = new updates.Downloader({ asset });
const outputDir = createOutputDir({
  getDir: () => settings.get().outputDir,
  notify: (dir) => jobs?.addInfo({ title: "Can't save to the chosen folder", detail: `${folderName(dir)} is not available, so files are saved next to the original instead.` }),
});

// Looks for a newer version when the user has switched "Check automatically" on, and only says so: the toast opens Settings,
// and the download starts when the user presses the button there.
const autoUpdate = new updates.AutoUpdate({
  getSettings: () => settings.get(),
  setSettings: (patch) => settings.set(patch),
  check: () => updates.check({ current: app.getVersion() }),
  onAvailable: (r) => {
    log('update available:', r.latest);
    sendToSettings('updates:found', r);          // an open Settings window switches to "Download update"
    jobs?.addInfo({ title: `Update your Pomelo to v${r.latest}`, detail: 'Click to open Pomelo and download it.', onClick: () => openSettings({ page: 'updates' }) });
    updateTray();
  },
});
const updateTray = () => tray?.setTooltip(autoUpdate.available ? `Pomelo: version ${autoUpdate.available.latest} is available` : 'Pomelo');

// Login starts are silent (tray only). Running from source, Windows must be told which app folder to open.
const setLoginItem = (openAtLogin) => app.setLoginItemSettings({ openAtLogin, args: [...(app.isPackaged ? [] : [app.getAppPath()]), '--hidden'] });

function applySettings() {
  const s = settings.get();
  trigger.setEnabled(s.enabled);
  nativeTheme.themeSource = ['light', 'dark'].includes(s.theme) ? s.theme : 'system';
  setLoginItem(s.openAtLogin);
  tray?.refreshMenu();
}

app.whenReady().then(async () => {
  if (cli) {
    const say = (line) => { console.log(line); log('cli:', line); };
    const code = await engineSetup.runCommandLine(cli, { installer, setLoginItem, removeShellMenu: () => removeShellMenu({ exts: conversion.sourceExts }), say, progress: engineSetup.fileProgress(cli.progressFile) });
    setTimeout(() => app.exit(code), 500);                  // lets the last lines of output reach a pipe before the process ends
    return;
  }
  settings.set({}); // materialise defaults
  log(`--- started v${app.getVersion()} build ${log.build.slice(0, 12)}; log at`, log.path());
  conversion.detectEngines();

  helper = new InputHelper();
  helper.start();

  flow = createDropFlow({ conversion, getWheel: () => wheel, getJobs: () => jobs, log });
  wheel = new WheelWindow({ onDrop: flow.onDrop });
  wheel.create();
  jobs = new Jobs({
    formats: conversion.timingFormats,
    timings: new Timings(userDataFile('timings.json')),
    convert: (src, to, opts) => conversion.convertFile(src, to, { ...opts, outDir: outputDir() }).catch((e) => { log('convert failed:', path.basename(src), e.message); throw e; }),
  });
  const toast = new Toast({ onRemove: (id) => jobs.remove(id), onCancel: (id) => jobs.cancel(id), onClick: (id) => jobs.activate(id) });
  toast.create();
  jobs.on('change', (view) => toast.update(view));

  trigger = new Trigger(helper);
  trigger.on('open', flow.onOpen);
  trigger.on('unsupported', () => jobs.addInfo({ title: 'Nothing to convert here', detail: 'Drag a file or folder from Explorer or the desktop.' }));
  trigger.on('release', () => wheel.releaseSoon());
  trigger.on('cancel', () => wheel.hide());
  trigger.start();

  tray = createTray({
    icon: asset('tray.png'), getSettings: () => settings.get(), onOpen: openSettings, onQuit: () => app.quit(),
    onChange: (patch) => { settings.set(patch); applySettings(); sendToSettings('settings:changed', settings.get()); },
  });

  const setup = engineSetup.registerEngineSetupIpc({ installer, getEngines: conversion.getEngines, sendToSettings, log });
  let justUpdated = updates.updatedStart(process.argv, app.getVersion());      // Settings says so the first time it opens, not every time
  registerSettingsIpc({
    store: settings,
    getState: () => {
      const updated = justUpdated;
      justUpdated = false;
      return { engines: conversion.getEngines(), installing: setup.getInstalling(), version: app.getVersion(), os: `Windows ${process.getSystemVersion()} ${process.arch}`, update: autoUpdate.available, updated };
    },
    onChange: (patch) => { applySettings(); if ('autoUpdate' in patch) autoUpdate.apply(); },
    logPath: log.path,
    describe: (name) => {
      const ext = conversion.extOf(name);
      return { ext, group: conversion.groupOf(ext), targets: conversion.targetsFor([name]).map((t) => ({ ext: t.ext, label: t.label, sub: t.sub, group: conversion.groupOf(t.ext) })) };
    },
  });
  registerUninstallIpc({ installer, getWindow: getSettingsWindow, setLoginItem, removeShellMenu: () => removeShellMenu({ exts: conversion.sourceExts }), isPackaged: app.isPackaged, execPath: process.execPath, quit: () => app.quit(), log });
  updates.registerUpdatesIpc({
    current: app.getVersion(), autoCheck: autoUpdate, onChecked: updateTray, isPackaged: app.isPackaged, execPath: process.execPath,
    sendToSettings, isSettingsOpen: () => !!getSettingsWindow(), downloader, stopForUpdate: () => stopAll(helper), exit: (code) => app.exit(code), log,
  });

  applySettings();
  autoUpdate.apply();
  installShellMenu({ exe: process.execPath, launch: app.isPackaged ? [] : [app.getAppPath()], version: app.getVersion(), exts: conversion.sourceExts })
    .then((written) => { if (written) log('right-click menu entries written'); })
    .catch((e) => log('right-click menu not written:', e.message));
  const toConvert = convertPathsFromArgv(process.argv);
  if (toConvert.length) convertBatch.add(toConvert);
  // started again by an in-app update: add the engines the new version expects, then say it is done
  updates.reportUpdate({
    argv: process.argv, current: app.getVersion(), notify: (m) => jobs.addInfo(m), cleanup: updates.cleanup, log, ui: downloader,
    engines: { missing: () => installer.pending(conversion.getEngines()), add: setup.run },
  }).catch((e) => log('update follow-up failed:', e.message));
  log('ready');
  // Show the window on every manual launch so there is always a visible way in; login starts stay in the tray.
  if (!process.argv.includes('--hidden') && !toConvert.length) {
    openSettings(firstRun ? { page: 'help' } : undefined);
  }
});

app.on('will-quit', () => stopAll(helper));

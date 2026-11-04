// SPDX-License-Identifier: AGPL-3.0-or-later
const fs = require('fs');
const path = require('path');
const { app, Tray, Menu, ipcMain, nativeImage, dialog } = require('electron');
const settings = require('./settings');
const { APP_ROOT } = require('../shared/node/paths');
const { capitalize } = require('../shared/core/text');
const convert = require('./convert');
const { labelOf, extOf, groupOf } = require('./formats');
const { ExplorerHelper } = require('./explorer');
const { Trigger } = require('./trigger');
const { Overlay } = require('./overlay');
const { Toast } = require('./toast');
const { Jobs } = require('./jobs');
const { Timings } = require('./progress');
const updater = require('./updater');
const updateInstall = require('./updateInstall');
const { AutoUpdate } = require('./autoUpdate');
const log = require('./log');
const { killAll } = require('../shared/node/process');
const settingsWindow = require('./settingsWindow');
const { createInstaller, PACK } = require('./engineInstaller');
const uninstaller = require('./uninstall');
const engineCli = require('./engineCli');

const cli = engineCli.parse(process.argv);     // --install-engines / --uninstall-engines: run by the installer, no window, no tray
if (!cli && !app.requestSingleInstanceLock()) app.exit(0);
app.on('window-all-closed', () => { /* tray app: keep running */ });
app.on('second-instance', () => openSettings());

const asset = (n) => path.join(APP_ROOT, 'assets', n);
let tray, overlay, toast, jobs, trigger, helper;
let installing = null;   // { keys: [engine keys being installed], note } while an Install button is working
const installer = createInstaller({ redetect: () => convert.detectEngines() });

const openSettings = () => settingsWindow.open(asset);

// Looks for a newer version when the user has switched "Check automatically" on, and only says so: the download
// starts when the user presses the button in Settings.
const autoUpdate = new AutoUpdate({
  getSettings: () => settings.get(),
  setSettings: (patch) => settings.set(patch),
  check: () => updater.check(),
  onAvailable: (r) => {
    log('update available:', r.latest);
    settingsWindow.getWindow()?.webContents.send('updates:found', r);          // an open Settings window switches to "Download update"
    jobs?.addInfo({ title: `Pomelo ${r.latest} is available`, detail: 'Open Settings from the tray icon and press Download update.' });
    updateTray();
  },
});
const updateTray = () => tray?.setToolTip(autoUpdate.available ? `Pomelo: version ${autoUpdate.available.latest} is available` : 'Pomelo');

// Login starts are silent (tray only). Running from source, Windows must be told which app folder to open.
const setLoginItem = (openAtLogin) => app.setLoginItemSettings({ openAtLogin, args: [...(app.isPackaged ? [] : [app.getAppPath()]), '--hidden'] });

function applySettings() {
  const s = settings.get();
  trigger.setKey(s.key);
  helper.setKey(s.key);
  trigger.setEnabled(s.enabled);
  setLoginItem(s.openAtLogin);
  tray?.setContextMenu(buildMenu());
}

function buildMenu() {
  const s = settings.get();
  return Menu.buildFromTemplate([
    { label: 'Pomelo', enabled: false },
    { label: `Drag a file, then tap ${capitalize(s.key)}`, enabled: false },
    { type: 'separator' },
    { label: 'Enabled', type: 'checkbox', checked: s.enabled, click: (i) => { settings.set({ enabled: i.checked }); applySettings(); } },
    { label: 'Settings…', click: openSettings },
    { type: 'separator' },
    { label: 'Quit Pomelo', click: () => app.quit() },
  ]);
}

// Plain-language reason for "the wheel has nothing to offer for this selection".
function whyNothing(files) {
  const exts = [...new Set(files.map(extOf))];
  if (exts.length > 1) return { title: 'These items are different kinds', detail: 'Select items of the same kind, for example all documents or all images.' };
  const ext = exts[0];
  if (ext === 'lnk') return { title: "Shortcuts can't be converted", detail: 'Drag the file the shortcut points to instead.' };
  const what = ext === 'folder' ? 'folders' : ext ? `.${ext} files` : 'these files';
  if (!groupOf(ext)) return { title: `Can't convert ${what}`, detail: "Pomelo doesn't support this format yet." };
  return { title: `No converter available for ${what}`, detail: 'Open Pomelo settings to see which engines to add.' };
}

// Every file x target is its own job; jobs run in parallel and the toast shows them as a stack (see jobs.js).
function handleDrop(paths, to) {
  log('drop', to, paths);
  if (!convert.targetsFor(paths).some((t) => t.id === to)) {
    jobs.addInfo({ title: `Can't convert to ${labelOf(to)}`, detail: 'That format is not available for this selection.' });
    return;
  }
  for (const p of paths) jobs.addConversion(p, to, labelOf(to));
}

app.whenReady().then(async () => {
  if (cli) {
    const say = (line) => { console.log(line); log('cli:', line); };
    const code = await engineCli.run(cli, { installer, setLoginItem, say, progress: engineCli.fileProgress(cli.progressFile) });
    setTimeout(() => app.exit(code), 500);                  // lets the last lines of output reach a pipe before the process ends
    return;
  }
  settings.set({}); // materialise defaults
  log(`--- started v${app.getVersion()} build ${log.build.slice(0, 12)}; log at`, log.path());
  convert.detectEngines();

  helper = new ExplorerHelper();
  helper.start();

  overlay = new Overlay({ onDrop: handleDrop });
  overlay.create();
  jobs = new Jobs({
    timings: new Timings(path.join(app.getPath('userData'), 'timings.json')),
    convert: (src, to, opts) => convert.convertFile(src, to, opts).catch((e) => { log('convert failed:', path.basename(src), e.message); throw e; }),
  });
  toast = new Toast({ onRemove: (id) => jobs.remove(id), onCancel: (id) => jobs.cancel(id) });
  toast.create();
  jobs.on('change', (view) => toast.update(view));

  trigger = new Trigger(helper);
  trigger.on('open', (files) => {
    const targets = convert.targetsFor(files);
    if (targets.length) { overlay.openWheel(files, targets); return; }
    log('nothing to offer for', files);
    jobs.addInfo(whyNothing(files));
  });
  trigger.on('unsupported', () => jobs.addInfo({ title: 'Nothing to convert here', detail: 'Drag a file or folder from Explorer or the desktop.' }));
  trigger.on('release', () => overlay.releaseSoon());
  trigger.on('cancel', () => overlay.hide());
  trigger.start();

  tray = new Tray(nativeImage.createFromPath(asset('tray.png')));
  tray.setToolTip('Pomelo');
  tray.on('click', openSettings);

  ipcMain.handle('settings:get', () => ({ settings: settings.get(), engines: convert.getEngines(), installing, version: app.getVersion(), os: `Windows ${process.getSystemVersion()} ${process.arch}`, update: autoUpdate.available }));
  ipcMain.handle('engines:install', async (_e, key) => {
    if (!PACK[key]) return { ok: false, message: 'Unknown engine' };
    if (installing) return { ok: false, message: 'Another engine is still installing' };
    const tell = () => settingsWindow.getWindow()?.webContents.send('engines:progress', installing);
    installing = { keys: Object.keys(PACK).filter((k) => PACK[k] === PACK[key]), note: 'Starting…' };
    tell();
    const result = await installer.install(key, (note) => { if (installing) { installing.note = note; tell(); } });
    installing = null;
    log('engine install', key, result.ok ? 'ok' : `failed: ${result.message}`);
    return { ok: result.ok, message: result.message, engines: convert.getEngines() };
  });
  ipcMain.handle('settings:set', (_e, patch) => { settings.set(patch); applySettings(); if ('autoUpdate' in patch) autoUpdate.apply(); return settings.get(); });
  ipcMain.handle('app:uninstall', async () => {
    const win = settingsWindow.getWindow();
    const what = uninstaller.plan(installer);
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning', title: 'Uninstall Pomelo', message: 'Uninstall Pomelo?', detail: uninstaller.confirmText(what),
      buttons: ['Uninstall', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
    });
    if (response !== 0) return { ok: false };
    log('uninstalling', what.engines);
    const tell = (note) => win?.webContents.send('engines:progress', { keys: [], note });
    const unins = app.isPackaged && path.join(path.dirname(process.execPath), 'unins000.exe');
    const done = await uninstaller.uninstall({ installer, uninstaller: unins && fs.existsSync(unins) ? unins : null, setLoginItem, note: tell });
    if (!done.launched && done.engines.failed.length) {              // from source: no Windows uninstaller to report it
      await dialog.showMessageBox(win, { type: 'info', title: 'Uninstall Pomelo', message: 'The engines are removed, with one exception',
        detail: `These could not be removed automatically: ${done.engines.failed.join(', ')}.\nDelete the folder %LOCALAPPDATA%\\Pomelo\\engines, or use Windows Settings > Apps for Pandoc and Python.`, buttons: ['OK'] });
    }
    app.quit();                                                       // the Windows uninstaller carries on by itself
    return { ok: true };
  });
  ipcMain.handle('updates:check', async () => { const r = await updater.check(); autoUpdate.remember(r); updateTray(); return r; });
  ipcMain.handle('updates:download', (_e, url) => updater.openDownload(url));
  // "Download update": fetch the installer inside Pomelo, check it against the release's checksum, run it quietly and come
  // back. What to download comes from the check Pomelo itself made, never from the Settings window.
  let updating = false;
  ipcMain.handle('updates:install', async () => {
    const found = autoUpdate.available;
    if (!found) return { ok: false, message: 'Check for updates first' };
    if (!app.isPackaged) return { ok: false, message: 'Updating in place only works in the installed app', fallback: true };
    if (!found.installable) return { ok: false, message: 'This release cannot be installed from here', fallback: true };
    if (updating) return { ok: false, message: 'The update is already downloading' };
    updating = true;
    const tell = (p) => settingsWindow.getWindow()?.webContents.send('updates:progress', p);
    const startedAt = Date.now();
    try {
      log('update: downloading', found.latest);
      const file = await updateInstall.download({
        url: found.url, sha256: found.sha256, size: found.size, rules: updater.downloadRules(),
        onProgress: ({ received, total, fraction }) => {
          const secs = (Date.now() - startedAt) / 1000;
          const left = fraction > 0.02 && secs > 1 ? Math.round(secs * (1 - fraction) / fraction) : null;
          tell({ phase: 'download', received, total, fraction, left });
        },
      });
      tell({ phase: 'install' });
      log('update: installing', found.latest);
      updateInstall.launch(file, process.execPath, { version: found.latest });
      setTimeout(() => app.exit(0), 400);          // out of the installer's way; will-quit does not run on exit(), so stop the helpers here
      helper?.stop(); killAll();
      return { ok: true };
    } catch (e) {
      updating = false;
      log('update failed:', e.message);
      return { ok: false, message: e.message, fallback: true };
    }
  });

  applySettings();
  autoUpdate.apply();
  // Started again by an in-app update: say how it went, and drop the downloaded installer.
  const updated = process.argv.find((a) => a.startsWith('--updated'));
  if (updated) {
    const to = updated.split('=')[1];
    updateInstall.cleanup();
    if (!to || to === app.getVersion()) jobs.addInfo({ title: `Pomelo is now on version ${app.getVersion()}`, detail: 'The update is installed.' });
    else { log('update did not install; still on', app.getVersion(), 'wanted', to); jobs.addInfo({ title: 'The update could not be installed', detail: `Pomelo is still on version ${app.getVersion()}. Open Settings from the tray icon and try again.` }); }
  }
  // Show the window on every manual launch so there is always a visible way in; login starts stay in the tray.
  if (!process.argv.includes('--hidden')) openSettings();
});

app.on('will-quit', () => { helper?.stop(); killAll(); });

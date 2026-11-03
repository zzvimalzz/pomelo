// SPDX-License-Identifier: AGPL-3.0-or-later
const fs = require('fs');
const path = require('path');
const { app, Tray, Menu, ipcMain, nativeImage, dialog } = require('electron');
const settings = require('./settings');
const convert = require('./convert');
const { labelOf, extOf, groupOf } = require('./formats');
const { ExplorerHelper } = require('./explorer');
const { Trigger } = require('./trigger');
const { Overlay } = require('./overlay');
const { Toast } = require('./toast');
const { Jobs } = require('./jobs');
const updater = require('./updater');
const log = require('./log');
const { killAll } = require('./convert/util');
const settingsWindow = require('./settingsWindow');
const { createInstaller, PACK } = require('./engineInstaller');
const uninstaller = require('./uninstall');
const engineCli = require('./engineCli');

const cli = engineCli.parse(process.argv);     // --install-engines / --uninstall-engines: run by the installer, no window, no tray
if (!cli && !app.requestSingleInstanceLock()) app.exit(0);
app.on('window-all-closed', () => { /* tray app: keep running */ });
app.on('second-instance', () => openSettings());

const asset = (n) => path.join(__dirname, '..', '..', 'assets', n);
let tray, overlay, toast, jobs, trigger, helper;
let installing = null;   // { keys: [engine keys being installed], note } while an Install button is working
const installer = createInstaller({ redetect: () => convert.detectEngines() });

const openSettings = () => settingsWindow.open(asset);

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
    { label: `Drag a file, then tap ${s.key[0].toUpperCase() + s.key.slice(1)}`, enabled: false },
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
    app.exit(await engineCli.run(cli, { installer, setLoginItem, say, progress: engineCli.fileProgress(cli.progressFile) }));
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

  ipcMain.handle('settings:get', () => ({ settings: settings.get(), engines: convert.getEngines(), installing, version: app.getVersion(), os: `Windows ${process.getSystemVersion()} ${process.arch}` }));
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
  ipcMain.handle('settings:set', (_e, patch) => { settings.set(patch); applySettings(); return settings.get(); });
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
  ipcMain.handle('updates:check', () => updater.check());
  ipcMain.handle('updates:download', (_e, url) => updater.openDownload(url));

  applySettings();
  // Show the window on every manual launch so there is always a visible way in; login starts stay in the tray.
  if (!process.argv.includes('--hidden')) openSettings();
});

app.on('will-quit', () => { helper?.stop(); killAll(); });

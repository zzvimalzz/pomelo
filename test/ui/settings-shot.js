// SPDX-License-Identifier: AGPL-3.0-or-later
// Opens the real settings window with sample data: normal vs advanced view, layout/scrolling, the logo, spacing,
// the update button and version line, diagnostics. Saves screenshots.   npx electron test/ui/settings-shot.js
const { app, ipcMain, nativeTheme, screen, clipboard, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const settingsWindow = require('../../src/features/settings/settings.window');
const { registerSettingsIpc } = require('../../src/features/settings/settings.ipc');

app.on('window-all-closed', () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const asset = (n) => path.join(__dirname, '..', '..', 'assets', n);
const out = path.join(__dirname, '..', 'shots');

const LONG = 'C:\\Users\\someone-with-a-very-long-name\\OneDrive - Contoso Corporation\\Desktop\\Pomelo\\vendor\\pyenv\\Scripts\\python.exe';
const scenarios = {
  'all-ready': { settings: { enabled: true, openAtLogin: false, advanced: false }, engines: { soffice: 'C:\\Program Files\\LibreOffice\\program\\soffice.exe', pandoc: 'C:\\Users\\Example\\AppData\\Local\\Pandoc\\pandoc.exe', pdf: LONG, ocr: LONG, pdfmd: LONG, heic: LONG, ffmpeg: LONG } },
  'none-installed': { settings: { enabled: false, openAtLogin: true, advanced: false }, engines: { soffice: null, pandoc: null, pdf: null, ocr: null, pdfmd: null, heic: null, ffmpeg: null } },
};
let current = scenarios['all-ready'];
let nextUpdate = { state: 'unconfigured', current: '0.1.0' };
let guideAsked = 0;
const downloads = [];
// The real settings messages (get, set, fit the window, copy, open the log) on top of a fake store and fake state.
registerSettingsIpc({
  store: { get: () => current.settings, set: (patch) => { current = { ...current, settings: { ...current.settings, ...patch } }; return current.settings; } },
  getState: () => ({ engines: current.engines, version: '0.1.0', os: 'Windows 10.0.26300 x64' }),
  onChange: (patch) => { if (patch.theme) nativeTheme.themeSource = patch.theme; },
  logPath: () => path.join(out, 'debug.log'),
  onOpenGuide: () => { guideAsked++; },
});
const installs = [];
let installOutcome = { ok: true };
let uninstallAnswer = { ok: false };
const uninstalls = [];
ipcMain.handle('engines:install', async (e, key) => {
  installs.push(key);
  e.sender.send('engines:progress', { keys: [key], note: 'Pandoc: Downloading 38 MB…' });
  await sleep(500);
  if (installOutcome.ok) current = { ...current, engines: { ...current.engines, [key]: `C:/Pomelo/engines/${key}` } };
  return { ...installOutcome, engines: current.engines };
});
ipcMain.handle('app:uninstall', async () => { uninstalls.push(1); await sleep(200); return uninstallAnswer; });
ipcMain.handle('updates:check', async () => { await sleep(250); return nextUpdate; });
ipcMain.handle('updates:download', (_e, url) => { downloads.push(url); return { ok: true }; });

const { expect: check, failed } = require('../support/expect');
const finish = require('../support/finish');
const js = (win, code) => win.webContents.executeJavaScript(code);
const shot = async (win, name) => fs.writeFileSync(path.join(out, name), (await win.webContents.capturePage()).toPNG());
const dims = (win) => js(win, `({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, sh: document.documentElement.scrollHeight, ch: document.documentElement.clientHeight })`);
const fresh = async (scenario, theme) => {
  nativeTheme.themeSource = theme;
  current = JSON.parse(JSON.stringify(scenarios[scenario]));
  settingsWindow.open(asset);
  await sleep(1800);
  return settingsWindow.getWindow();
};

app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });

  console.log('normal view: only the everyday things');
  for (const theme of ['light', 'dark']) {
    for (const scenario of Object.keys(scenarios)) {
      const win = await fresh(scenario, theme);
      const d = await dims(win);
      check(`${theme}/${scenario}: fits without scrolling, ${win.getContentBounds().height}px tall`, d.sw <= d.cw && d.sh <= d.ch);
      const ui = await js(win, `({
        advancedHidden: document.getElementById('advanced').hidden,
        enginesShown: !!document.getElementById('engines').offsetParent,
        hasQuit: !!document.getElementById('quit'),
        hasLogButtonVisible: !!document.getElementById('logs').offsetParent,
        logoLoaded: (() => { const i = document.querySelector('.logo'); return i.tagName === 'IMG' && i.complete && i.naturalWidth > 0; })(),
        subtitle: document.querySelector('.titles .muted').textContent,
        version: document.getElementById('versionLine').textContent,
        updateBtn: !!document.getElementById('updateBtn').offsetParent,
        steps: document.querySelectorAll('.step').length,
        toggles: document.querySelectorAll('.switch').length,
        gap: (() => { const label = document.querySelector('#versionLine').closest('.label'); const b = label.querySelector('b'); const s = label.querySelector('small'); return s.getBoundingClientRect().top - b.getBoundingClientRect().bottom; })(),
      })`);
      if (theme === 'light' && scenario === 'all-ready') {
        check('engines, log and diagnostics are hidden', ui.advancedHidden && !ui.enginesShown && !ui.hasLogButtonVisible);
        check('no Quit button', !ui.hasQuit);
        check('real logo image is shown (not the orange circle)', ui.logoLoaded);
        check('3 steps, 3 preference controls, update button and its automatic-check switch', ui.steps === 3 && ui.toggles === 3 && ui.updateBtn);
        check('version lives in the Updates row, not the header', ui.version === 'Version 0.1.0' && !/Version/.test(ui.subtitle), `${ui.version} | header: "${ui.subtitle}"`);
        check(`space between a main line and its sub-text is at least 3px`, ui.gap >= 3, `${ui.gap.toFixed(1)}px`);
      }
      await shot(win, `settings-${theme}-${scenario}.png`);
      win.close();
      await sleep(300);
    }
  }

  console.log('Save conversions to: a dropdown of at most three choices');
  {
    const win = await fresh('all-ready', 'light');
    const choices = () => js(win, `({ options: [...document.querySelectorAll('#outputMenu [role="option"]')].map((o) => o.textContent), value: document.getElementById('outputText').textContent,
      selected: document.querySelectorAll('#outputMenu [aria-selected="true"]').length, note: document.getElementById('outputNote').hidden ? '' : document.getElementById('outputNote').textContent })`);
    const pick = async (value) => {
      await js(win, `document.getElementById('output').click()`);
      await sleep(60);
      await js(win, `document.querySelector('#outputMenu [data-value="${value}"]').click()`);
      await sleep(400);
      return choices();
    };
    const key = async (keyCode) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode }); await sleep(60); };
    const menu = () => js(win, `(() => { const m = document.getElementById('outputMenu'); const r = m.getBoundingClientRect();
      return { open: !m.hidden, expanded: document.getElementById('output').getAttribute('aria-expanded'), focused: document.activeElement.dataset?.value || document.activeElement.id,
        inside: r.left >= 0 && r.right <= innerWidth && r.bottom <= document.documentElement.clientHeight }; })()`);
    const answer = (filePaths) => { dialog.showOpenDialog = async () => (filePaths ? { canceled: false, filePaths } : { canceled: true, filePaths: [] }); };
    let c = await choices();
    check('nothing chosen: Default and Choose folder', c.options.join() === 'Default,Choose folder…' && c.value === 'Default' && c.note === '', JSON.stringify(c));
    answer(['C:\\Users\\Example\\Converted']);
    c = await pick('choose');
    check('a folder was chosen: Default, the folder, Choose folder, with the folder selected', c.options.join() === 'Default,Converted,Choose folder…' && c.value === 'Converted' && c.note === 'C:\\Users\\Example\\Converted', JSON.stringify(c));
    answer(['D:\\Photos']);
    c = await pick('choose');
    check('a second folder replaces the first, still three choices', c.options.join() === 'Default,Photos,Choose folder…' && c.value === 'Photos', JSON.stringify(c));
    answer(null);
    c = await pick('choose');
    check('closing the folder dialog changes nothing', c.options.join() === 'Default,Photos,Choose folder…' && c.value === 'Photos', JSON.stringify(c));
    check('exactly one choice is marked selected', c.selected === 1, JSON.stringify(c));
    await js(win, `document.getElementById('output').click()`);
    await sleep(250);
    let m = await menu();
    check('pressing the button opens the list on the chosen item, inside the window', m.open && m.expanded === 'true' && m.focused === 'current' && m.inside, JSON.stringify(m));
    await shot(win, 'settings-output-folder.png');
    await key('Escape');
    m = await menu();
    check('Escape closes it and returns to the button', !m.open && m.expanded === 'false' && m.focused === 'output', JSON.stringify(m));
    await key('Down');
    await key('Down');
    m = await menu();
    check('the arrow keys open it and move through the choices', m.open && m.focused === 'choose', JSON.stringify(m));
    await key('Home');
    await key('Return');
    await sleep(300);
    c = await choices();
    m = await menu();
    check('Enter on Default picks it and closes the list', !m.open && c.value === 'Default' && current.settings.outputDir === '', JSON.stringify([c, m]));
    answer(['D:\\Photos']);
    await pick('choose');
    await js(win, `document.getElementById('output').click()`);
    await sleep(100);
    await win.webContents.sendInputEvent({ type: 'mouseDown', x: 4, y: 4, button: 'left', clickCount: 1 });
    await win.webContents.sendInputEvent({ type: 'mouseUp', x: 4, y: 4, button: 'left', clickCount: 1 });
    await sleep(100);
    m = await menu();
    check('a click outside closes it', !m.open, JSON.stringify(m));
    const fonts = await js(win, `({ button: getComputedStyle(document.getElementById('output')).fontFamily, item: getComputedStyle(document.querySelector('#outputMenu [role="option"]')).fontFamily, body: getComputedStyle(document.body).fontFamily })`);
    check('the button and the list use the same font as the rest of the page', fonts.button === fonts.body && fonts.item === fonts.body, JSON.stringify(fonts));
    c = await pick('default');
    check('Default clears the folder and leaves two choices', c.options.join() === 'Default,Choose folder…' && c.value === 'Default' && current.settings.outputDir === '', JSON.stringify(c));
    const header = await js(win, `(() => { const t = document.querySelector('.titleline').getBoundingClientRect(); const h = document.getElementById('help').getBoundingClientRect(); const b = document.querySelector('.titleline h1').getBoundingClientRect();
      return { sameLine: Math.abs((h.top + h.height / 2) - (b.top + b.height / 2)) < 3, rightOfTitle: h.left > b.right, inside: h.right <= t.right + 1 }; })()`);
    check('the ? button sits on the title line, right of the name', header.sameLine && header.rightOfTitle && header.inside, JSON.stringify(header));
    await js(win, `document.getElementById('help').click()`);
    await sleep(200);
    check('and pressing it asks the app for the guide', guideAsked === 1);
    win.close();
    await sleep(300);
  }

  console.log('advanced view: engines, log, diagnostics');
  for (const theme of ['light', 'dark']) {
    for (const scenario of Object.keys(scenarios)) {
      const win = await fresh(scenario, theme);
      await js(win, `document.getElementById('advToggle').click()`);
      await sleep(900);
      const d = await dims(win);
      const ui = await js(win, `({ shown: !document.getElementById('advanced').hidden, rows: document.querySelectorAll('#engines .engine').length, expected: ENGINES.length, label: document.getElementById('advToggle').textContent, log: !!document.getElementById('logs').offsetParent, open: document.getElementById('enginesBox').open, listShown: !!document.getElementById('engines').offsetParent, summary: document.getElementById('engineSummary').textContent })`);
      check(`${theme}/${scenario}: shows ${ui.rows} engines + log, button says "${ui.label}"`, ui.shown && ui.rows === ui.expected && ui.log && ui.label === 'Hide advanced');
      check(`${theme}/${scenario}: the engines list starts closed, with its summary ("${ui.summary}") still visible`, !ui.open && /ready/.test(ui.summary));
      check(`${theme}/${scenario}: never scrolls sideways (${win.getContentBounds().height}px tall, content ${d.sh}px)`, d.sw <= d.cw);
      await shot(win, `settings-${theme}-${scenario}-advanced.png`);
      if (theme === 'dark' && scenario === 'all-ready') {
        await js(win, `document.getElementById('diag').click()`);
        await sleep(200);
        const text = String(await clipboard.readText());
        check('Copy puts version, Windows and engine info on the clipboard', /Pomelo 0\.1\.0/.test(text) && /Windows 10/.test(text) && /FFmpeg/.test(text) && /LibreOffice/.test(text), JSON.stringify(text.slice(0, 120)));
        await js(win, `document.querySelector('#enginesBox > summary').click()`);
        await sleep(500);
        const opened = await js(win, `({ open: document.getElementById('enginesBox').open, listShown: !!document.getElementById('engines').offsetParent, rows: [...document.querySelectorAll('#engines .engine')].filter((r) => r.offsetParent).length, expected: ENGINES.length })`);
        check('clicking the Conversion engines header opens the list', opened.open && opened.listShown && opened.rows === opened.expected, JSON.stringify(opened));
        await shot(win, `settings-${theme}-${scenario}-advanced-open.png`);
        await js(win, `document.querySelector('#enginesBox > summary').click()`);
        await sleep(300);
        check('and clicking it again closes it', await js(win, `!document.getElementById('enginesBox').open`));
        await js(win, `document.getElementById('advToggle').click()`);
        await sleep(700);
        const back = await js(win, `document.getElementById('advanced').hidden`);
        check('"Hide advanced" returns to the normal view', back === true);
        await js(win, `document.getElementById('advToggle').click()`);
        await sleep(300);
      }
      win.close();
      await sleep(300);
    }
  }

  console.log('Install buttons for engines that are not there yet');
  {
    const win = await fresh('none-installed', 'dark');
    await js(win, `document.getElementById('advToggle').click()`);
    await js(win, `document.getElementById('enginesBox').open = true`);      // the list starts closed
    await sleep(800);
    const rows = () => js(win, `[...document.querySelectorAll('#engines .engine')].map((r) => ({ name: r.querySelector('.name').textContent, chip: r.querySelector('.chip').textContent, button: r.querySelector('button.chip') ? !r.querySelector('button.chip').disabled : null, role: r.querySelector('.role').textContent }))`);
    const installable = await js(win, `ENGINES.filter((e) => e.install).map((e) => e.name)`);
    let r = await rows();
    check('missing optional engines say "Install", not "Ready"', installable.every((n) => r.find((x) => x.name === n).chip === 'Install'), r.map((x) => `${x.name}:${x.chip}`).join(' '));
    check('FFmpeg (ships with Pomelo) is not an Install button', r.find((x) => x.name === 'FFmpeg').button === null);
    await shot(win, 'settings-engines-install.png');
    await js(win, `[...document.querySelectorAll('#engines .engine')].find((r) => r.querySelector('.name').textContent === 'Pandoc').querySelector('button').click()`);
    await sleep(200);
    r = await rows();
    check('pressing Install shows "Installing…" with live progress text', r.find((x) => x.name === 'Pandoc').chip === 'Installing…' && /Downloading/.test(r.find((x) => x.name === 'Pandoc').role), r.find((x) => x.name === 'Pandoc').role);
    check('other Install buttons wait (one install at a time)', r.filter((x) => x.chip === 'Install').every((x) => x.button === false));
    await shot(win, 'settings-engines-installing.png');
    await sleep(700);
    r = await rows();
    check('when done the engine shows Ready and installs was requested once', r.find((x) => x.name === 'Pandoc').chip === 'Ready' && installs.join() === 'pandoc', installs.join());
    check('the others can be installed again', r.find((x) => x.name === 'LibreOffice').button === true);

    installOutcome = { ok: false, message: 'Windows Package Manager (winget) is not available on this PC' };
    await js(win, `[...document.querySelectorAll('#engines .engine')].find((r) => r.querySelector('.name').textContent === 'LibreOffice').querySelector('button').click()`);
    await sleep(900);
    r = await rows();
    const lo = r.find((x) => x.name === 'LibreOffice');
    check('a failed install shows the reason and a Retry button', lo.chip === 'Retry' && /winget/.test(lo.role), `${lo.chip} | ${lo.role}`);
    await shot(win, 'settings-engines-failed.png');
    installOutcome = { ok: true };

    console.log('Uninstall sits at the very bottom of Advanced');
    const pos = await js(win, `(() => { const adv = document.getElementById('advanced'); const last = adv.querySelector('section:last-of-type'); const b = document.getElementById('uninstall'); return { inLast: last.contains(b), belowEverything: b.getBoundingClientRect().top >= document.getElementById('logs').getBoundingClientRect().bottom, label: b.textContent, footerBelow: document.querySelector('footer').getBoundingClientRect().top > b.getBoundingClientRect().bottom }; })()`);
    check('the last card of Advanced, under Diagnostics', pos.inLast && pos.belowEverything && pos.footerBelow, JSON.stringify(pos));
    await shot(win, 'settings-advanced-uninstall.png');
    await js(win, `document.getElementById('uninstall').click()`);
    await sleep(500);
    const afterCancel = await js(win, `({ disabled: document.getElementById('uninstall').disabled, text: document.getElementById('uninstall').textContent })`);
    check('Uninstall asks the main process (native confirmation); cancelling leaves the button usable', uninstalls.length === 1 && !afterCancel.disabled && afterCancel.text === 'Uninstall');
    uninstallAnswer = { ok: true };
    await js(win, `document.getElementById('uninstall').click()`);
    await sleep(500);
    const afterGo = await js(win, `({ disabled: document.getElementById('uninstall').disabled, text: document.getElementById('uninstall').textContent })`);
    check('confirmed: the button shows "Uninstalling" until Pomelo quits', afterGo.disabled && afterGo.text === 'Uninstalling', afterGo.text);
    uninstallAnswer = { ok: false };
    await js(win, `document.getElementById('advToggle').click()`);
    await sleep(300);
    win.close();
    await sleep(300);
  }

  console.log('appearance: System, Light or Dark');
  {
    const win = await fresh('all-ready', 'dark');
    const checked = () => js(win, `[...document.querySelectorAll('#theme button')].filter((b) => b.getAttribute('aria-checked') === 'true').map((b) => b.dataset.theme).join()`);
    const isDark = () => js(win, `matchMedia('(prefers-color-scheme: dark)').matches`);
    check('with no theme stored, System is the selected option', (await checked()) === 'system', await checked());
    await shot(win, 'settings-appearance-default.png');
    for (const [theme, dark] of [['light', false], ['dark', true]]) {
      await js(win, `document.querySelector('#theme [data-theme="${theme}"]').click()`);
      await sleep(400);
      check(`choosing ${theme} stores it, marks only that button and switches the page`, current.settings.theme === theme && (await checked()) === theme && (await isDark()) === dark, `${current.settings.theme} | ${await checked()} | dark: ${await isDark()}`);
      await shot(win, `settings-appearance-${theme}.png`);
    }
    await js(win, `document.querySelector('#theme [data-theme="system"]').click()`);
    await sleep(400);
    check('choosing System stores it and marks only that button', current.settings.theme === 'system' && (await checked()) === 'system');
    await shot(win, 'settings-appearance-system.png');
    win.close();
    await sleep(300);
  }

  console.log('the choice is remembered');
  {
    const win = await fresh('all-ready', 'dark');
    await js(win, `document.getElementById('advToggle').click()`);
    await sleep(500);
    win.close();
    await sleep(400);
    settingsWindow.open(asset);
    await sleep(1800);
    const w2 = settingsWindow.getWindow();
    check('reopening keeps advanced on', (await js(w2, `!document.getElementById('advanced').hidden`)) === true);
    await js(w2, `document.getElementById('advToggle').click()`);
    await sleep(300);
    w2.close();
    await sleep(300);
  }

  console.log('update button states and the version line');
  let win = await fresh('all-ready', 'dark');
  const ui = () => js(win, `({ version: document.getElementById('versionLine').textContent, status: document.getElementById('updateStatus').hidden ? '' : document.getElementById('updateStatus').textContent, btn: document.getElementById('updateBtn').textContent, primary: document.getElementById('updateBtn').classList.contains('primary'), disabled: document.getElementById('updateBtn').disabled })`);
  const click = async () => { await js(win, `document.getElementById('updateBtn').click()`); };
  const first = await ui();
  check('before any check: "Version 0.1.0", button "Check for updates", no status line', first.version === 'Version 0.1.0' && first.btn === 'Check for updates' && first.status === '');
  for (const [label, update, want] of [
    ['not configured yet', { state: 'unconfigured', current: '0.1.0' }, (u) => /once Pomelo is released/.test(u.status) && u.btn === 'Check for updates' && u.version === 'Version 0.1.0'],
    ['up to date', { state: 'uptodate', current: '0.1.0' }, (u) => /up to date/.test(u.status) && u.btn === 'Check again' && u.version === 'Version 0.1.0'],
    ['update available', { state: 'available', current: '0.1.0', latest: '0.2.0', url: 'https://github.com/o/r/releases/download/v0.2.0/Pomelo-Setup-0.2.0.exe' }, (u) => /Version 0\.1\.0\s*>\s*Version 0\.2\.0/.test(u.version) && u.btn === 'Download update' && u.primary],
    ['server error', { state: 'error', current: '0.1.0', message: "Couldn't reach the update server. Check your internet connection" }, (u) => u.btn === 'Try again' && /reach the update server/.test(u.status) && u.version === 'Version 0.1.0'],
  ]) {
    await js(win, `update = { state: 'idle' }; renderUpdate();`);
    nextUpdate = update;
    await click();
    await sleep(60);
    const during = await ui();
    check(`${label}: shows "Checking…" while waiting`, during.btn === 'Checking…' && during.disabled);
    await sleep(600);
    const after = await ui();
    check(`${label}: [${after.version}] [${after.status}] button "${after.btn}"`, want(after));
    await shot(win, `settings-update-${label.replace(/\W+/g, '-')}.png`);
    if (update.state === 'available') {
      await click();
      await sleep(150);
      check('available: clicking "Download update" opens the download link', downloads[0] === update.url);
    }
  }
  const d = await dims(win);
  check('update area does not cause overflow', d.sw <= d.cw && d.sh <= d.ch);

  console.log('long page: scrolls vertically only');
  await js(win, `document.getElementById('advToggle').click(); const pad = document.createElement('div'); pad.id = 'pad'; pad.style.height = '1400px'; pad.textContent = 'very tall future content'; document.getElementById('app').appendChild(pad);`);
  await sleep(900);
  const tall = await dims(win);
  const wa = screen.getDisplayMatching(win.getBounds()).workArea;
  check(`window stays on screen (${win.getBounds().height}px of ${wa.height}px)`, win.getBounds().height <= wa.height);
  check('content is taller than the window, so it scrolls vertically', tall.sh > tall.ch);
  check('never scrolls sideways', tall.sw <= tall.cw);
  await js(win, `document.scrollingElement.scrollTop = 250`);
  await sleep(150);
  check('vertical scroll works', (await js(win, `document.scrollingElement.scrollTop`)) > 0);
  await shot(win, 'settings-long-page.png');
  win.close();

  console.log(failed() ? `\n${failed()} failed` : '\nall passed');
  finish();
}).catch((e) => { console.error(e); finish(2); });

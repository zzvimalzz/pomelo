// SPDX-License-Identifier: AGPL-3.0-or-later
// Opens the real settings window with sample data: every section in both themes, search, the output folder dropdown, engines,
// update states, uninstall, opening on a section, and the Help page (the animation, the questions and the pictures). Saves screenshots.
//   npx electron test/ui/settings-shot.js
const { app, ipcMain, nativeTheme, clipboard, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const settingsWindow = require('../../src/features/settings/settings.window');
const { registerSettingsIpc } = require('../../src/features/settings/settings.ipc');
const { expect: check, failed } = require('../support/expect');
const finish = require('../support/finish');

app.on('window-all-closed', () => {});
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const asset = (n) => path.join(__dirname, '..', '..', 'assets', n);
const out = path.join(__dirname, '..', 'shots');

const LONG = 'C:\\Users\\someone-with-a-very-long-name\\OneDrive - Contoso Corporation\\Desktop\\Pomelo\\vendor\\pyenv\\Scripts\\python.exe';
const scenarios = {
  'all-ready': { settings: { enabled: true, openAtLogin: false }, engines: { soffice: LONG, pandoc: LONG, pdf: LONG, ocr: LONG, heic: LONG, ffmpeg: LONG } },
  'none-installed': { settings: { enabled: false, openAtLogin: true }, engines: { soffice: null, pandoc: null, pdf: null, ocr: null, heic: null, ffmpeg: null } },
};
const SECTIONS = ['general', 'appearance', 'engines', 'updates', 'help', 'diagnostics', 'about'];
const target = (ext, label, sub, group) => ({ ext, label, sub, group });
const FORMATS = {
  docx: { group: 'doc', targets: [target('pdf', 'PDF', 'Portable doc', 'pdf'), target('md', 'MD', 'Markdown', 'doc'), target('txt', 'TXT', 'Plain text', 'doc'), target('html', 'HTML', 'Web page', 'doc'),
    target('epub', 'EPUB', 'E-book', 'doc'), target('png', 'PNG', 'Image', 'image'), target('jpg', 'JPG', 'Image', 'image'), target('rtf', 'RTF', 'Rich text', 'doc')] },
  xlsx: { group: 'sheet', targets: [target('csv', 'CSV', 'Comma-separated', 'sheet'), target('pdf', 'PDF', 'Portable doc', 'pdf'), target('ods', 'ODS', 'OpenDocument', 'sheet')] },
  png: { group: 'image', targets: [target('jpg', 'JPG', 'Image', 'image'), target('webp', 'WEBP', 'Image', 'image'), target('pdf', 'PDF', 'Portable doc', 'pdf'), target('gif', 'GIF', 'Animated', 'image')] },
};
const COMPOSITOR = new Set(['offset', 'computedOffset', 'easing', 'composite', 'opacity', 'translate', 'scale', 'rotate', 'strokeDashoffset']);

const HISTORY = [
  { version: '0.1.0', date: '09-11-2026', sections: [
    { name: 'Added', items: ['A sidebar, with `Ctrl+F` for search', 'Markup such as <b>x</b> is shown as text'] },
    { name: 'Fixed', items: ['A crash'] },
  ] },
  { version: '0.0.9', date: '03-11-2026', sections: [{ name: 'Changed', items: ['Older change'] }] },
];
let current = scenarios['all-ready'];
let nextUpdate = { state: 'unconfigured', current: '0.1.0' };
const downloads = [];
const checks = [];
const opened = [];
shell.openExternal = async (url) => { opened.push(url); };
registerSettingsIpc({
  store: { get: () => current.settings, set: (patch) => { current = { ...current, settings: { ...current.settings, ...patch } }; return current.settings; } },
  getState: () => ({ engines: current.engines, version: '0.1.0', os: 'Windows 10.0.26300 x64' }),
  onChange: (patch) => { if (patch.theme) nativeTheme.themeSource = patch.theme; },
  logPath: () => path.join(out, 'debug.log'),
  describe: (name) => ({ ext: name.split('.').pop(), ...FORMATS[name.split('.').pop()] }),
  history: () => HISTORY,
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
ipcMain.handle('updates:check', async () => { checks.push(1); await sleep(250); return nextUpdate; });
ipcMain.handle('updates:download', (_e, url) => { downloads.push(url); return { ok: true }; });

const js = (win, code) => win.webContents.executeJavaScript(code);
const shot = async (win, name) => fs.writeFileSync(path.join(out, name), (await win.webContents.capturePage()).toPNG());
const fresh = async (scenario, theme, goTo) => {
  nativeTheme.themeSource = theme;
  current = JSON.parse(JSON.stringify(scenarios[scenario]));
  settingsWindow.open(asset, goTo);
  await sleep(1800);
  return settingsWindow.getWindow();
};
const open = (win, id) => js(win, `document.querySelector('.nav[data-v="${id}"]').click()`);
const visiblePage = (win) => js(win, `[...document.querySelectorAll('.page')].filter((p) => !p.hidden).map((p) => p.id.slice(5)).join()`);

app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  const motion = (value) => settingsWindow.getWindow().webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value }] });

  console.log('the window: size, sidebar, every section in both themes');
  for (const theme of ['light', 'dark']) {
    for (const scenario of Object.keys(scenarios)) {
      const win = await fresh(scenario, theme);
      const size = win.getContentBounds();
      check(`${theme}/${scenario}: the window is 880 x 600 and cannot be resized`, size.width === 880 && size.height === 600 && !win.isResizable() && !win.isMaximizable(), `${size.width} x ${size.height}`);
      const ui = await js(win, `({ nav: [...document.querySelectorAll('.nav')].map((n) => n.dataset.v).join(), groups: [...document.querySelectorAll('.navgroup')].map((g) => g.textContent).join(),
        pages: document.querySelectorAll('.page').length, shown: [...document.querySelectorAll('.page')].filter((p) => !p.hidden).length, current: document.querySelector('.nav[aria-current="page"]').dataset.v,
        pill: document.getElementById('pill').textContent, ver: document.getElementById('ver').textContent, logo: (() => { const i = document.querySelector('.brand img'); return i.complete && i.naturalWidth > 0; })(),
        title: document.querySelector('.page:not([hidden]) h1').textContent, steps: document.querySelectorAll('.step').length })`);
      if (theme === 'light' && scenario === 'all-ready') {
        check('seven sections in three groups, General is open', ui.nav === SECTIONS.join() && ui.groups === 'Settings,Help,Advanced' && ui.current === 'general' && ui.shown === 1 && ui.title === 'General', JSON.stringify(ui));
        check('the sidebar shows the status and the version, and the logo is real', ui.pill === 'Running' && ui.ver === 'Version 0.1.0' && ui.logo);
        check('the three steps are on the General page', ui.steps === 3);
      }
      for (const id of SECTIONS) {
        await open(win, id);
        await sleep(id === 'help' ? 1200 : 350);
        const d = await js(win, `({ page: document.querySelector('.page:not([hidden])').id, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, cs: document.getElementById('content').scrollWidth, cc: document.getElementById('content').clientWidth })`);
        check(`${theme}/${scenario}: ${id} opens alone and nothing scrolls sideways`, d.page === `page-${id}` && d.sw <= d.cw && d.cs <= d.cc, JSON.stringify(d));
        await shot(win, `settings-${theme}-${scenario}-${id}.png`);
      }
      win.close();
      await sleep(300);
    }
  }

  console.log('settings that switch: Enabled, Start with Windows, the status follows');
  {
    const win = await fresh('all-ready', 'dark');
    await js(win, `(() => { const s = document.querySelector('[data-bind="enabled"]'); s.focus(); s.click(); })()`);
    await sleep(300);
    const ui = await js(win, `({ title: document.getElementById('statusTitle').textContent, pill: document.getElementById('pill').textContent, off: document.getElementById('pill').classList.contains('off') })`);
    check('Enabled off: stored, and the page and the sidebar say Paused', current.settings.enabled === false && ui.title === 'Pomelo is paused' && ui.pill === 'Paused' && ui.off, JSON.stringify(ui));
    const focus = await js(win, `document.activeElement.dataset.bind`);
    check('the switch keeps the focus after it is used', focus === 'enabled', String(focus));
    win.webContents.send('settings:changed', { ...current.settings, enabled: true });
    await sleep(200);
    check('the tray switching Pomelo on is shown at once', (await js(win, `document.getElementById('pill').textContent`)) === 'Running');
    await js(win, `document.querySelector('[data-bind="openAtLogin"]').click()`);
    await sleep(300);
    check('Start with Windows is stored', current.settings.openAtLogin === true);
    win.close();
    await sleep(300);
  }

  console.log('search');
  {
    const win = await fresh('all-ready', 'light');
    const type = async (text) => { await js(win, `(() => { const q = document.getElementById('q'); q.value = ${JSON.stringify(text)}; q.dispatchEvent(new Event('input')); })()`); await sleep(100); };
    const rows = () => js(win, `[...document.querySelectorAll('.page:not([hidden]) .row, .page:not([hidden]) .faq')].filter((r) => !r.hidden).map((r) => r.querySelector('b, .qt').textContent)`);
    await type('log');
    check('"log" finds the log file row, from any section', (await visiblePage(win)) === 'diagnostics' && (await rows()).join() === 'Log file', `${await visiblePage(win)} ${await rows()}`);
    await shot(win, 'settings-search.png');
    await type('upload');
    check('a question is found by its words', (await visiblePage(win)) === 'help' && (await rows()).join() === 'Does Pomelo upload my files?', `${await visiblePage(win)} ${await rows()}`);
    check('the animation is hidden while searching', await js(win, `document.getElementById('tour').hidden`));
    await type('zzzz');
    check('no match says so', (await js(win, `!document.getElementById('empty').hidden && /zzzz/.test(document.getElementById('empty').textContent)`)));
    await js(win, `document.getElementById('q').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(100);
    check('Esc clears the search and brings the section back', (await visiblePage(win)) === 'general' && (await js(win, `document.getElementById('q').value`)) === '');
    win.close();
    await sleep(300);
  }

  console.log('Save conversions to: a dropdown of at most three choices');
  {
    const win = await fresh('all-ready', 'light');
    const choices = () => js(win, `({ options: [...document.querySelectorAll('#outputMenu [role="option"]')].map((o) => o.textContent), value: document.getElementById('outputText').textContent,
      selected: document.querySelectorAll('#outputMenu [aria-selected="true"]').length, note: document.getElementById('outputNote').hidden ? '' : document.getElementById('outputNote').textContent })`);
    const pick = async (value) => {
      await js(win, `document.getElementById('output').click()`);
      await sleep(60);
      await js(win, `document.querySelector('#outputMenu [data-v="${value}"]').click()`);
      await sleep(400);
      return choices();
    };
    const key = async (keyCode) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode }); await sleep(60); };
    const menu = () => js(win, `(() => { const m = document.getElementById('outputMenu'); const r = m.getBoundingClientRect();
      return { open: !m.hidden, expanded: document.getElementById('output').getAttribute('aria-expanded'), focused: document.activeElement.dataset?.v || document.activeElement.id, inside: r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight }; })()`);
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
    check('closing the folder dialog changes nothing', c.options.join() === 'Default,Photos,Choose folder…' && c.value === 'Photos' && c.selected === 1, JSON.stringify(c));
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
    win.webContents.sendInputEvent({ type: 'mouseDown', x: 600, y: 500, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: 600, y: 500, button: 'left', clickCount: 1 });
    await sleep(100);
    check('a click outside closes it', !(await menu()).open);
    const fonts = await js(win, `({ button: getComputedStyle(document.getElementById('output')).fontFamily, item: getComputedStyle(document.querySelector('#outputMenu [role="option"]')).fontFamily, body: getComputedStyle(document.body).fontFamily })`);
    check('the button and the list use the same font as the rest of the page', fonts.button === fonts.body && fonts.item === fonts.body, JSON.stringify(fonts));
    c = await pick('default');
    check('Default clears the folder and leaves two choices', c.options.join() === 'Default,Choose folder…' && c.value === 'Default' && current.settings.outputDir === '', JSON.stringify(c));
    win.close();
    await sleep(300);
  }

  console.log('appearance: System, Light or Dark');
  {
    const win = await fresh('all-ready', 'dark');
    await open(win, 'appearance');
    const checked = () => js(win, `[...document.querySelectorAll('.tc')].filter((b) => b.getAttribute('aria-checked') === 'true').map((b) => b.dataset.v).join()`);
    const isDark = () => js(win, `matchMedia('(prefers-color-scheme: dark)').matches`);
    check('with no theme stored, System is the selected option', (await checked()) === 'system', await checked());
    for (const [theme, dark] of [['light', false], ['dark', true]]) {
      await js(win, `document.querySelector('.tc[data-v="${theme}"]').click()`);
      await sleep(400);
      check(`choosing ${theme} stores it, marks only that card and switches the page`, current.settings.theme === theme && (await checked()) === theme && (await isDark()) === dark, `${current.settings.theme} | ${await checked()} | dark: ${await isDark()}`);
      await shot(win, `settings-appearance-${theme}.png`);
    }
    await js(win, `document.querySelector('.tc[data-v="system"]').click()`);
    await sleep(400);
    check('choosing System stores it and marks only that card', current.settings.theme === 'system' && (await checked()) === 'system');
    win.close();
    await sleep(300);
  }

  console.log('engines: Install buttons, live progress, failure');
  {
    const win = await fresh('none-installed', 'dark');
    await open(win, 'engines');
    const rows = () => js(win, `[...document.querySelectorAll('#page-engines .row')].map((r) => ({ name: r.querySelector('b').textContent, chip: r.querySelector('.chip').textContent, button: r.querySelector('button.chip') ? !r.querySelector('button.chip').disabled : null, role: r.querySelector('small').textContent }))`);
    const press = (name) => js(win, `[...document.querySelectorAll('#page-engines .row')].find((r) => r.querySelector('b').textContent === '${name}').querySelector('button').click()`);
    const installable = await js(win, `ENGINES.filter((e) => e.install).map((e) => e.name)`);
    let r = await rows();
    check('missing optional engines say Install, and the meter counts the ready ones', installable.every((n) => r.find((x) => x.name === n).chip === 'Install') && (await js(win, `document.querySelector('#page-engines .group b').textContent`)) === '1 of 7 engines ready');
    check('FFmpeg (ships with Pomelo) is not an Install button', r.find((x) => x.name === 'FFmpeg').button === null);
    check('the meter fills in proportion', await js(win, `Math.abs(parseFloat(document.querySelector('.meter i').style.width) - 100 / 7) < 0.1`));
    await shot(win, 'settings-engines-install.png');
    await press('Pandoc');
    await sleep(200);
    r = await rows();
    check('pressing Install shows Installing with live progress text', r.find((x) => x.name === 'Pandoc').chip === 'Installing…' && /Downloading/.test(r.find((x) => x.name === 'Pandoc').role), r.find((x) => x.name === 'Pandoc').role);
    check('the other Install buttons wait (one install at a time)', r.filter((x) => x.chip === 'Install').every((x) => x.button === false));
    await shot(win, 'settings-engines-installing.png');
    await sleep(700);
    r = await rows();
    check('when done the engine shows Ready, and the install was asked for once', r.find((x) => x.name === 'Pandoc').chip === 'Ready' && installs.join() === 'pandoc', installs.join());
    installOutcome = { ok: false, message: 'Windows Package Manager (winget) is not available on this PC' };
    await press('LibreOffice');
    await sleep(900);
    r = await rows();
    const lo = r.find((x) => x.name === 'LibreOffice');
    check('a failed install shows the reason and a Retry button', lo.chip === 'Retry' && /winget/.test(lo.role), `${lo.chip} | ${lo.role}`);
    await shot(win, 'settings-engines-failed.png');
    installOutcome = { ok: true };
    win.close();
    await sleep(300);
  }

  console.log('updates: states and the version line');
  {
    const win = await fresh('all-ready', 'dark');
    await open(win, 'updates');
    const ui = () => js(win, `(() => { const r = document.querySelector('#page-updates .row'); const s = r.querySelector('small'); const b = r.querySelector('button');
      return { version: r.querySelector('b').textContent, status: s ? s.textContent : '', btn: b.textContent, primary: b.classList.contains('primary'), disabled: b.disabled }; })()`);
    const click = () => js(win, `document.querySelector('#page-updates [data-action="update"]').click()`);
    const first = await ui();
    check('before any check: "Version 0.1.0", Check for updates, no status line', first.version === 'Version 0.1.0' && first.btn === 'Check for updates' && first.status === '', JSON.stringify(first));
    for (const [label, update, want] of [
      ['not configured yet', { state: 'unconfigured', current: '0.1.0' }, (u) => /once Pomelo is released/.test(u.status) && u.btn === 'Check for updates'],
      ['up to date', { state: 'uptodate', current: '0.1.0' }, (u) => /up to date/.test(u.status) && u.btn === 'Check again'],
      ['update available', { state: 'available', current: '0.1.0', latest: '0.2.0', url: 'https://github.com/o/r/releases/download/v0.2.0/Pomelo-Setup-0.2.0.exe' }, (u) => /Version 0\.1\.0\s*>\s*Version 0\.2\.0/.test(u.version) && u.btn === 'Download update' && u.primary],
      ['server error', { state: 'error', current: '0.1.0', message: "Couldn't reach the update server. Check your internet connection" }, (u) => u.btn === 'Try again' && /reach the update server/.test(u.status)],
    ]) {
      await js(win, `update = { state: 'idle' }; renderUpdates();`);
      nextUpdate = update;
      await click();
      await sleep(60);
      const during = await ui();
      check(`${label}: shows Checking while waiting`, during.btn === 'Checking…' && during.disabled);
      await sleep(600);
      const after = await ui();
      check(`${label}: [${after.version}] [${after.status}] button "${after.btn}"`, want(after));
      await shot(win, `settings-update-${label.replace(/\W+/g, '-')}.png`);
      if (update.state === 'available') {
        await click();
        await sleep(150);
        check('available: Download update opens the download link', downloads[0] === update.url);
      }
    }
    await js(win, `update = { state: 'error', message: '<b>x</b>' }; renderUpdates();`);
    check('text from outside is shown as text, never as markup', (await js(win, `document.querySelectorAll('#updateControls b').length`)) === 2);
    win.close();
    await sleep(300);
  }

  console.log('updates: the release history');
  {
    const win = await fresh('all-ready', 'dark');
    await open(win, 'updates');
    await sleep(400);
    const h = await js(win, `({ heading: document.querySelector('#history h2').textContent, cards: [...document.querySelectorAll('.release')].map((r) => r.querySelector('.ver').textContent + ':' + r.open).join(),
      when: document.querySelector('.release .when').textContent, installed: [...document.querySelectorAll('.release')].map((r) => !!r.querySelector('.chip')).join(),
      kinds: [...document.querySelectorAll('.release:first-child .kind h3')].map((k) => k.textContent).join(), items: [...document.querySelectorAll('.release:first-child li')].map((li) => li.textContent).join('|'),
      code: document.querySelector('.release:first-child li code')?.textContent, markup: document.querySelectorAll('.release:first-child li b').length, subtext: document.querySelectorAll('.release li span, .release li small, .release li p').length,
      plain: getComputedStyle(document.querySelector('.release:first-child li')).color === getComputedStyle(document.body).color })`);
    check('newest release first and open, the older one folded, with its date written out', h.heading === 'Release history' && h.cards === '0.1.0:true,0.0.9:false' && h.when === '9 Nov 2026', JSON.stringify(h));
    check('the installed version is marked, and only that one', h.installed === 'true,false', h.installed);
    check('changes are grouped by kind and each is one line, with no subtext', h.kinds === 'Added,Fixed' && h.items === 'A sidebar, with Ctrl+F for search|Markup such as <b>x</b> is shown as text|A crash' && h.subtext === 0, JSON.stringify(h));
    check('code in a headline is drawn, other markup is shown as text', h.code === 'Ctrl+F' && h.markup === 0, JSON.stringify(h));
    check('a headline is full-strength text', h.plain);
    await shot(win, 'settings-updates-history.png');
    await js(win, `document.querySelectorAll('.release')[1].querySelector('summary').click()`);
    await sleep(300);
    check('opening another release closes the first', (await js(win, `[...document.querySelectorAll('.release')].map((r) => r.open).join()`)) === 'false,true');
    await js(win, `(() => { const q = document.getElementById('q'); q.value = 'older change'; q.dispatchEvent(new Event('input')); })()`);
    await sleep(100);
    check('search finds a change inside a release', (await visiblePage(win)) === 'updates' && (await js(win, `[...document.querySelectorAll('.release')].filter((r) => !r.hidden).length`)) === 1);
    win.close();
    await sleep(300);
  }

  console.log('diagnostics and about');
  {
    const win = await fresh('all-ready', 'dark');
    await open(win, 'diagnostics');
    await js(win, `document.getElementById('copyBtn').click()`);
    await sleep(200);
    const text = String(await clipboard.readText());
    check('Copy puts version, Windows and engine info on the clipboard', /Pomelo 0\.1\.0/.test(text) && /Windows 10/.test(text) && /FFmpeg/.test(text) && /LibreOffice/.test(text), JSON.stringify(text.slice(0, 120)));
    check('and the button says Copied', (await js(win, `document.getElementById('copyBtn').textContent`)) === 'Copied');
    await open(win, 'about');
    const about = await js(win, `({ version: /Version 0\\.1\\.0/.test(document.querySelector('.about').textContent), link: document.querySelector('#page-about a.btn').href, last: document.querySelector('#page-about .group:last-child').classList.contains('danger') })`);
    check('About shows the version and the licence link, with Uninstall in its own group at the bottom', about.version && about.link === 'https://github.com/zzvimalzz/pomelo#licence' && about.last, JSON.stringify(about));
    await js(win, `document.getElementById('uninstall').click()`);
    await sleep(500);
    const afterCancel = await js(win, `({ disabled: document.getElementById('uninstall').disabled, text: document.getElementById('uninstall').textContent })`);
    check('Uninstall asks the main process; cancelling leaves the button usable', uninstalls.length === 1 && !afterCancel.disabled && afterCancel.text === 'Uninstall');
    uninstallAnswer = { ok: true };
    await js(win, `document.getElementById('uninstall').click()`);
    await sleep(500);
    const afterGo = await js(win, `({ disabled: document.getElementById('uninstall').disabled, text: document.getElementById('uninstall').textContent })`);
    check('confirmed: the button shows Uninstalling until Pomelo quits', afterGo.disabled && afterGo.text === 'Uninstalling', afterGo.text);
    uninstallAnswer = { ok: false };
    win.close();
    await sleep(300);
  }

  console.log('opening on a section, as the tray does');
  {
    const win = await fresh('all-ready', 'dark', { page: 'help' });
    check('opened with a target: that section is showing', (await visiblePage(win)) === 'help');
    settingsWindow.open(asset, { page: 'updates', check: true });
    await sleep(700);
    check('already open: the same window moves to the section and starts an update check', settingsWindow.getWindow() === win && (await visiblePage(win)) === 'updates' && checks.length > 0, `${await visiblePage(win)} ${checks.length}`);
    win.close();
    await sleep(300);
    const before = checks.length;
    const w2 = await fresh('all-ready', 'dark', { page: 'updates', check: true });
    await sleep(600);
    check('a new window opened with check: true checks at once', (await visiblePage(w2)) === 'updates' && checks.length === before + 1, `${checks.length - before}`);
    w2.close();
    await sleep(300);
    nativeTheme.themeSource = 'dark';
    settingsWindow.open(asset);
    settingsWindow.open(asset, { page: 'diagnostics' });
    await sleep(1800);
    check('asked for a section while the window is still loading: it still gets there', (await visiblePage(settingsWindow.getWindow())) === 'diagnostics');
    settingsWindow.getWindow().close();
    await sleep(300);
  }

  console.log('Help: the animation');
  const win = await fresh('all-ready', 'dark', { page: 'help' });
  win.webContents.debugger.attach('1.3');
  await motion('no-preference');
  await sleep(500);
  const at = (t) => js(win, `document.getAnimations().forEach((a) => { a.pause(); a.currentTime = ${t * 1000}; })`);
  const read = (selector, prop = 'opacity') => js(win, `+getComputedStyle(document.querySelector('${selector}')).${prop}`);
  const values = (list) => Promise.all(list.map((s) => read(s)));
  const built = await js(win, `({ tiles: document.querySelectorAll('#files .tile').length, segs: document.querySelectorAll('.segs .seg').length, steps: document.querySelectorAll('.tour-steps li').length,
    play: document.getElementById('tour').classList.contains('play'), icons: document.querySelectorAll('#files .tile .picon .badge').length, hot: document.querySelector('.hotseg .label').textContent,
    busy: document.getElementById('toastBusy').textContent, file: document.getElementById('toastFile').textContent, stage: [document.getElementById('stage').offsetWidth, document.getElementById('stage').offsetHeight],
    inside: (() => { const s = document.getElementById('stage').getBoundingClientRect(); const c = document.getElementById('content').getBoundingClientRect(); return s.left >= c.left && s.right <= c.right; })() })`);
  check('four files in the window, a segment for each format, three steps', built.tiles === 4 && built.segs === FORMATS.docx.targets.length && built.steps === 3, JSON.stringify(built));
  check('the files and the wheel use the real icon drawing', built.icons === 4);
  check('the highlighted format, the toast and the new file name the first format', built.hot === 'PDF' && built.busy === 'Converting to PDF' && built.file === 'Report.pdf');
  check('the animation is running, 480 x 270, inside the page', built.play && built.stage.join('x') === '480x270' && built.inside);
  const props = await js(win, `[...new Set(document.getAnimations().flatMap((a) => a.effect.getKeyframes().flatMap((k) => Object.keys(k))))]`);
  check(`only the compositor is asked to animate: ${props.filter((p) => !['offset', 'computedOffset', 'easing', 'composite'].includes(p)).join(', ')}`, props.every((p) => COMPOSITOR.has(p)), props.join());
  const lengths = await js(win, `[...new Set(document.getAnimations().filter((a) => a.animationName !== 'fold-in' && a.animationName !== 'page-in').map((a) => a.effect.getTiming().duration))]`);
  check('every animation of the timeline lasts the same ten seconds, so they cannot drift apart', lengths.join() === '10000', lengths.join());
  await at(0.5);
  let v = await values(['.wheelbox', '.cursor', '.tour-steps .s1']);
  check('at 0.5 s the cursor is there, the wheel is not, and the first step is coming up', v[0] === 0 && v[1] === 1 && v[2] > 0.5, v.join());
  await at(2.8);
  check('while the file is dragged its tile dims and the dragged icon follows the cursor', (await read('.tile.lift')) < 0.5 && (await read('.ghost')) === 1);
  await at(3.95);
  v = [...await values(['.keycap', '.wheelbox', '.tour-steps .s2']), await js(win, `+getComputedStyle(document.querySelector('.keycap kbd'), '::before').opacity`)];
  check('at 3.95 s the Ctrl key shows, pressed, and the wheel is opening', v[0] === 1 && v[1] > 0 && v[2] > 0.9 && v[3] === 1, v.join());
  await at(5.6);
  const tip = await js(win, `(() => { const c = document.querySelector('.cursor svg').getBoundingClientRect(); const s = document.getElementById('stage').getBoundingClientRect(); return [c.left - s.left + 1, c.top - s.top + 1]; })()`);
  const ghost = await read('.ghost');
  check('at 5.6 s the wheel is open, the first format lit, the cursor on it and the dragged icon see-through', (await read('.wheelbox')) === 1 && (await read('.hotseg')) === 1 && ghost > 0.4 && ghost < 0.8
    && Math.abs(tip[0] - 246) < 3 && Math.abs(tip[1] - 78) < 3, `cursor tip at ${tip.map(Math.round)}, icon ${ghost}`);
  await shot(win, 'settings-help-wheel.png');
  await at(7.2);
  check('at 7.2 s the wheel has gone and the toast shows progress', (await read('.wheelbox')) === 0 && (await read('.toast')) === 1 && (await read('.t1')) === 1 && (await read('.t2')) === 0);
  await at(8.7);
  v = await values(['.t2', '.tick', '.tile.fresh', '.tour-steps .s3']);
  check('at 8.7 s the toast says it is done and the new file is in the window', v[0] === 1 && v[1] === 1 && v[2] === 1 && v[3] > 0.9, v.join());
  await shot(win, 'settings-help-done.png');
  await at(9.995);
  const seam = [await read('.wheelbox'), await read('.toast'), await read('.tile.fresh'), await read('.ghost'), await read('.cursor')];
  await at(0.005);
  const start = [await read('.wheelbox'), await read('.toast'), await read('.tile.fresh'), await read('.ghost'), await read('.cursor')];
  check('the end of the loop and its start look the same, so the restart cannot be seen', seam.every((x) => x === 0) && start.every((x) => x < 0.1), `${seam} | ${start}`);
  const cycle = () => js(win, `(() => { document.querySelector('.wheelbox').dispatchEvent(new AnimationEvent('animationiteration', { animationName: 'wheel' }));
    return { lift: [...document.querySelectorAll('.tile')].findIndex((t) => t.classList.contains('lift')), ghost: document.getElementById('ghostName').textContent, hot: document.querySelector('.hotseg .label').textContent,
      segs: document.querySelectorAll('.segs .seg').length, file: document.getElementById('toastFile').textContent }; })()`);
  let n = await cycle();
  check('the next time round the spreadsheet is picked up, with its own formats and result', n.lift === 1 && n.ghost === 'Budget.xlsx' && n.hot === 'CSV' && n.segs === FORMATS.xlsx.targets.length && n.file === 'Budget.csv', JSON.stringify(n));
  n = await cycle();
  check('then the picture', n.lift === 2 && n.ghost === 'Photo.png' && n.hot === 'JPG' && n.segs === FORMATS.png.targets.length && n.file === 'Photo.jpg', JSON.stringify(n));
  n = await cycle();
  check('and round to the document again', n.lift === 0 && n.ghost === 'Report.docx' && n.hot === 'PDF', JSON.stringify(n));
  await motion('reduce');
  await sleep(500);
  const still = await js(win, `({ running: document.getAnimations().filter((a) => a.animationName !== 'fold-in' && a.animationName !== 'page-in').length, wheel: +getComputedStyle(document.querySelector('.wheelbox')).opacity,
    hot: +getComputedStyle(document.querySelector('.hotseg')).opacity, steps: +getComputedStyle(document.querySelector('.tour-steps .s1')).opacity })`);
  check('with reduced motion nothing moves and the wheel is shown open', still.running === 0 && still.wheel === 1 && still.hot === 1 && still.steps === 1, JSON.stringify(still));
  await shot(win, 'settings-help-reduced.png');
  await motion('no-preference');

  console.log('Help: the questions and the pictures');
  const faq = await js(win, `({ count: document.querySelectorAll('.faq').length, open: document.querySelectorAll('.faq[open]').length, firstOpen: document.querySelector('.faq').open,
    q: [...document.querySelectorAll('.faq > summary .qa')].every((b) => b.textContent === 'Q'), a: [...document.querySelectorAll('.faq .reply .qa')].every((b) => b.textContent === 'A'),
    weight: getComputedStyle(document.querySelector('.faq .qt')).fontWeight, answerWeight: getComputedStyle(document.querySelector('.faq .reply .text > ol li span')).fontWeight,
    tint: getComputedStyle(document.querySelector('.faq .reply')).backgroundColor !== getComputedStyle(document.querySelector('.faq summary')).backgroundColor })`);
  check('seven questions, the first one open, each with a Q on the question and an A on the answer', faq.count === 7 && faq.open === 1 && faq.firstOpen && faq.q && faq.a, JSON.stringify(faq));
  check('the question is bold and the answer is plain text on its own tinted panel', Number(faq.weight) >= 600 && Number(faq.answerWeight) < 600 && faq.tint, JSON.stringify(faq));
  await js(win, `document.getElementById('content').scrollTop = 420`);
  await sleep(200);
  await shot(win, 'settings-help-question.png');
  const within = (inner, outer) => js(win, `(() => { const o = document.querySelector('${outer}').getBoundingClientRect(); return [...document.querySelectorAll('${inner}')].every((e) => { const r = e.getBoundingClientRect();
    return r.width > 0 && r.left >= o.left - 1 && r.right <= o.right + 1; }); })()`);
  const openQuestion = async (i) => { await js(win, `(() => { const d = document.querySelectorAll('.faq')[${i}]; if (!d.open) d.querySelector('summary').click(); })()`); await sleep(350); };
  await openQuestion(1);
  check('opening another closes the first, so only one answer is open', (await js(win, `document.querySelectorAll('.faq[open]').length`)) === 1);
  await openQuestion(2);
  const pair = await js(win, `({ names: [...document.querySelectorAll('#figPair .name')].map((x) => x.textContent), tag: document.querySelector('#figPair .tag').textContent, icons: document.querySelectorAll('#figPair .picon .badge').length })`);
  check('where the files go: the original and the new file, side by side', pair.names.join() === 'Report.docx,Report.pdf' && pair.tag === 'New' && pair.icons === 2 && await within('#figPair .tile', '.faq[open]'), JSON.stringify(pair));
  await js(win, `document.querySelector('.faq[open] [data-action="nav"]').click()`);
  await sleep(300);
  check('and its button goes to General', (await visiblePage(win)) === 'general');
  await open(win, 'help');
  await openQuestion(3);
  const menus = await js(win, `({ menus: document.querySelectorAll('.menus .menu').length, hot: [...document.querySelectorAll('.menus .hot')].map((h) => h.textContent.trim()), logo: document.querySelector('.menus img').complete && document.querySelector('.menus img').naturalWidth > 0 })`);
  check('the right-click answer shows both menus and marks the entries to press', menus.menus === 2 && menus.hot.join() === 'Show more options,Convert with Pomelo' && menus.logo && await within('.menus .menu', '.faq[open]'), JSON.stringify(menus));
  await shot(win, 'settings-help-menu.png');
  await openQuestion(5);
  await js(win, `document.querySelector('.faq[open] [data-action="nav"]').click()`);
  await sleep(300);
  check('a missing format: the button goes to Engines', (await visiblePage(win)) === 'engines');
  await open(win, 'help');
  await openQuestion(6);
  const tray = await js(win, `({ pins: [...document.querySelectorAll('.tray .pin')].map((p) => p.textContent), logo: document.querySelector('.tray .me img').complete && document.querySelector('.tray .me img').naturalWidth > 0 })`);
  check('where is Pomelo: the arrow is marked 1, the Pomelo icon 2', tray.pins.join() === '1,2' && tray.logo && await within('.tray .flyout, .tray .caret, .tray .me', '.tray'), JSON.stringify(tray));
  await shot(win, 'settings-help-tray.png');
  await js(win, `document.querySelector('[data-action="website"]').click()`);
  await sleep(300);
  check('the website button opens the Pomelo website, and nothing else', opened.join() === 'https://pomelo.swymble.com', opened.join());
  nativeTheme.themeSource = 'light';
  await sleep(500);
  await open(win, 'help');
  await js(win, `document.getElementById('content').scrollTop = 0`);
  await at(5.6);
  await shot(win, 'settings-help-light.png');
  win.close();

  console.log(failed() ? `\n${failed()} failed` : '\nall passed');
  finish();
}).catch((e) => { console.error(e); finish(2); });

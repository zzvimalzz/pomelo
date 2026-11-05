// SPDX-License-Identifier: AGPL-3.0-or-later
// Opens the real guide window and checks the animation at fixed moments of its loop (by pausing it and setting the time), that it only
// moves things the compositor can move, the questions, the buttons, reduced motion, and saves screenshots.
//   npx electron test/ui/guide-shot.js
const { app, nativeTheme, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { openGuideWindow, registerGuideIpc } = require('../../src/features/guide');
const { getWindow } = require('../../src/features/guide/guide.window');
const { expect: check, failed } = require('../support/expect');
const finish = require('../support/finish');

app.on('window-all-closed', () => {});
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const asset = (n) => path.join(__dirname, '..', '..', 'assets', n);
const out = path.join(__dirname, '..', 'shots');

const target = (ext, label, sub, group) => ({ ext, label, sub, group });
const FORMATS = {
  docx: { group: 'doc', targets: [target('pdf', 'PDF', 'Portable doc', 'pdf'), target('md', 'MD', 'Markdown', 'doc'), target('txt', 'TXT', 'Plain text', 'doc'), target('html', 'HTML', 'Web page', 'doc'),
    target('epub', 'EPUB', 'E-book', 'doc'), target('png', 'PNG', 'Image', 'image'), target('jpg', 'JPG', 'Image', 'image'), target('rtf', 'RTF', 'Rich text', 'doc')] },
  xlsx: { group: 'sheet', targets: [target('csv', 'CSV', 'Comma-separated', 'sheet'), target('pdf', 'PDF', 'Portable doc', 'pdf'), target('ods', 'ODS', 'OpenDocument', 'sheet')] },
  png: { group: 'image', targets: [target('jpg', 'JPG', 'Image', 'image'), target('webp', 'WEBP', 'Image', 'image'), target('pdf', 'PDF', 'Portable doc', 'pdf'), target('gif', 'GIF', 'Animated', 'image')] },
};
const TARGETS = FORMATS.docx.targets;
const COMPOSITOR = new Set(['offset', 'computedOffset', 'easing', 'composite', 'opacity', 'translate', 'scale', 'rotate', 'strokeDashoffset']);

app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  const opened = [];
  shell.openExternal = async (url) => { opened.push(url); };
  registerGuideIpc({ describe: (name) => ({ ext: name.split('.').pop(), ...FORMATS[name.split('.').pop()] }) });

  const win = () => getWindow();
  const js = (code) => win().webContents.executeJavaScript(code);
  const shot = async (name) => fs.writeFileSync(path.join(out, name), (await win().webContents.capturePage()).toPNG());
  // Pauses every animation on the page at second `t` of the loop.
  const at = (t) => js(`document.getAnimations().forEach((a) => { a.pause(); a.currentTime = ${t * 1000}; })`);
  const values = (list) => Promise.all(list.map((selector) => read(selector)));
  const read = (selector, prop = 'opacity') => js(`+getComputedStyle(document.querySelector('${selector}')).${prop}`);

  nativeTheme.themeSource = 'dark';
  let closed = 0;
  openGuideWindow(asset, { onClosed: () => closed++ });
  // A CI machine can have Windows animations switched off, which the page reads as "reduce motion".
  const dbg = win().webContents.debugger;
  dbg.attach('1.3');
  const motion = (value) => dbg.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value }] });
  await motion('no-preference');
  await sleep(1800);

  console.log('what the page builds');
  const built = await js(`({ tiles: document.querySelectorAll('#files .tile').length, segs: document.querySelectorAll('.segs .seg').length,
    steps: document.querySelectorAll('.steps li').length, play: document.getElementById('tour').classList.contains('play'),
    icons: document.querySelectorAll('#files .tile .picon .badge').length, hot: document.querySelector('.hotseg .label').textContent,
    busy: document.getElementById('toastBusy').textContent, file: document.getElementById('toastFile').textContent,
    sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
    stage: [document.getElementById('stage').offsetWidth, document.getElementById('stage').offsetHeight], faq: document.querySelectorAll('details').length })`);
  check('four files in the window, a segment for each format, three steps', built.tiles === 4 && built.segs === TARGETS.length && built.steps === 3, JSON.stringify(built));
  check('the files and the wheel use the real icon drawing', built.icons === 4);
  check('the highlighted format, the toast and the new file name the first format', built.hot === 'PDF' && built.busy === 'Converting to PDF' && built.file === 'Report.pdf');
  check('the animation is running and nothing overflows sideways', built.play && built.sw <= built.cw, `${built.sw} in ${built.cw}`);
  check('the stage is 480 x 270', built.stage.join('x') === '480x270');
  check('seven questions', built.faq === 7);
  const gap = () => js(`({ client: document.documentElement.clientHeight, page: document.getElementById('app').getBoundingClientRect().height, scroll: document.documentElement.scrollHeight })`);
  // On a screen shorter than the page the window stops at the screen: there can be no empty space, but the page has to scroll.
  const fits = (g) => g.client - g.page < 2 && (g.scroll <= g.client || win().getBounds().height >= screen.getDisplayMatching(win().getBounds()).workArea.height - 2);
  let g = await gap();
  check('the window is as tall as the page: no empty space below and no scrollbar', fits(g), JSON.stringify(g));
  const selectable = await js(`(() => { document.execCommand('selectAll'); const picked = getSelection().toString(); getSelection().removeAllRanges();
    return { picked, h1: getComputedStyle(document.querySelector('h1')).userSelect, answer: getComputedStyle(document.querySelector('details p')).userSelect }; })()`);
  check('no text can be selected', selectable.picked === '' && selectable.h1 === 'none' && selectable.answer === 'none', JSON.stringify(selectable));

  console.log('only the compositor is asked to animate');
  const props = await js(`[...new Set(document.getAnimations().flatMap((a) => a.effect.getKeyframes().flatMap((k) => Object.keys(k))))]`);
  const extra = props.filter((p) => !COMPOSITOR.has(p));
  check(`the timeline animates ${props.filter((p) => !['offset', 'computedOffset', 'easing', 'composite'].includes(p)).join(', ')}`, extra.length === 0, extra.join(', '));
  const lengths = await js(`[...new Set(document.getAnimations().filter((a) => !a.animationName.startsWith('faq')).map((a) => a.effect.getTiming().duration))]`);
  check('every animation of the timeline lasts the same ten seconds, so they cannot drift apart', lengths.join() === '10000', lengths.join());

  console.log('the loop');
  await at(0.5);
  let v = await values(['.wheelbox', '.cursor', '.steps .s1']);
  check('at 0.5 s the cursor is there, the wheel is not, and the first step is coming up', v[0] === 0 && v[1] === 1 && v[2] > 0.5, v.join());
  await shot('guide-0-start.png');
  await at(1.0);
  await shot('guide-1-reach.png');
  await at(2.8);
  const lifted = await read('.tile.lift');
  check('while the file is dragged its tile dims and the dragged icon follows the cursor', lifted < 0.5 && (await read('.ghost')) === 1);
  await shot('guide-2-drag.png');
  await at(3.95);
  v = [...await values(['.keycap', '.wheelbox', '.steps .s2']), await js(`+getComputedStyle(document.querySelector('.keycap kbd'), '::before').opacity`)];
  check('at 3.95 s the Ctrl key shows, pressed, and the wheel is opening', v[0] === 1 && v[1] > 0 && v[2] > 0.9 && v[3] === 1, v.join());
  await shot('guide-3-ctrl.png');
  await at(5.6);
  const tip = await js(`(() => { const c = document.querySelector('.cursor svg').getBoundingClientRect(); const s = document.getElementById('stage').getBoundingClientRect();
    return [c.left - s.left + 1, c.top - s.top + 1]; })()`);
  const ghost = await read('.ghost');
  check('at 5.6 s the wheel is open, the first format lit, the cursor on it and the dragged icon still with the cursor, see-through', (await read('.wheelbox')) === 1 && (await read('.hotseg')) === 1 && (await read('.segs .seg:last-child')) === 1
    && ghost > 0.4 && ghost < 0.8 && Math.abs(tip[0] - 246) < 3 && Math.abs(tip[1] - 78) < 3, `cursor tip at ${tip.map(Math.round)}, icon ${ghost}`);
  await shot('guide-4-wheel.png');
  await at(7.2);
  check('at 7.2 s the wheel has gone and the toast shows progress', (await read('.wheelbox')) === 0 && (await read('.toast')) === 1 && (await read('.t1')) === 1 && (await read('.t2')) === 0);
  await shot('guide-5-progress.png');
  await at(8.7);
  v = await values(['.t2', '.tick', '.tile.fresh', '.steps .s3']);
  check('at 8.7 s the toast says it is done and the new file is in the window', v[0] === 1 && v[1] === 1 && v[2] === 1 && v[3] > 0.9, v.join());
  await shot('guide-6-done.png');
  await at(9.995);
  const seam = [await read('.wheelbox'), await read('.toast'), await read('.tile.fresh'), await read('.ghost'), await read('.cursor')];
  await at(0.005);
  const start = [await read('.wheelbox'), await read('.toast'), await read('.tile.fresh'), await read('.ghost'), await read('.cursor')];
  check('the end of the loop and its start look the same, so the restart cannot be seen', seam.every((x) => x === 0) && start.every((x) => x < 0.1), `${seam} | ${start}`);

  console.log('the other files');
  const cycle = () => js(`(() => { document.querySelector('.wheelbox').dispatchEvent(new AnimationEvent('animationiteration', { animationName: 'wheel' }));
    return { lift: [...document.querySelectorAll('.tile')].findIndex((t) => t.classList.contains('lift')), ghost: document.getElementById('ghostName').textContent,
      hot: document.querySelector('.hotseg .label').textContent, segs: document.querySelectorAll('.segs .seg').length, file: document.getElementById('toastFile').textContent,
      fresh: document.querySelector('.tile.fresh .name').textContent, pa: getComputedStyle(document.getElementById('tour')).getPropertyValue('--pa').trim() }; })()`);
  let n = await cycle();
  check('the next time round the spreadsheet is picked up, with its own formats and result', n.lift === 1 && n.ghost === 'Budget.xlsx' && n.hot === 'CSV' && n.segs === FORMATS.xlsx.targets.length
    && n.file === 'Budget.csv' && n.fresh === 'Budget.csv' && n.pa === '166px 84px', JSON.stringify(n));
  await at(5.6);
  await shot('guide-9-second-file.png');
  n = await cycle();
  check('then the picture', n.lift === 2 && n.ghost === 'Photo.png' && n.hot === 'JPG' && n.segs === FORMATS.png.targets.length && n.file === 'Photo.jpg' && n.pa === '266px 84px', JSON.stringify(n));
  await at(5.6);
  await shot('guide-10-third-file.png');
  n = await cycle();
  check('and round to the document again', n.lift === 0 && n.ghost === 'Report.docx' && n.hot === 'PDF' && n.segs === TARGETS.length && n.file === 'Report.pdf', JSON.stringify(n));

  console.log('questions and buttons');
  await js(`document.querySelector('details summary').click()`);
  await sleep(400);
  const faq = await js(`(() => { const d = document.querySelector('details'); const p = d.querySelector('p').getBoundingClientRect(); return [d.open, p.height > 10]; })()`);
  check('a question opens to show its answer', faq[0] && faq[1]);
  await shot('guide-7-question.png');
  g = await gap();
  check('the window grew with it, with no gap and no scrollbar', fits(g), JSON.stringify(g));
  await js(`document.querySelectorAll('details summary')[1].click()`);
  await sleep(300);
  check('opening another closes the first, so only one answer is open', (await js(`document.querySelectorAll('details[open]').length`)) === 1);
  await js(`document.querySelectorAll('details summary')[1].click()`);

  console.log('the pictures in the answers');
  const open = async (i) => { await js(`(() => { const d = document.querySelectorAll('details')[${i}]; if (!d.open) d.querySelector('summary').click(); })()`); await sleep(350); };
  const within = (inner, outer) => js(`(() => { const o = document.querySelector('${outer}').getBoundingClientRect(); return [...document.querySelectorAll('${inner}')].every((e) => { const r = e.getBoundingClientRect();
    return r.width > 0 && r.left >= o.left - 1 && r.right <= o.right + 1 && r.top >= o.top - 1 && r.bottom <= o.bottom + 1; }); })()`);
  await open(2);
  const pair = await js(`({ tiles: document.querySelectorAll('#figPair .tile').length, names: [...document.querySelectorAll('#figPair .name')].map((n) => n.textContent), tag: document.querySelector('#figPair .tag').textContent,
    icons: document.querySelectorAll('#figPair .picon .badge').length, label: document.getElementById('figPair').getAttribute('aria-label') })`);
  check('where the files go: the original and the new file, side by side', pair.tiles === 2 && pair.names.join() === 'Report.docx,Report.pdf' && pair.tag === 'New' && pair.icons === 2, JSON.stringify(pair));
  check('and the picture stays inside the card', await within('#figPair .tile', '.faq'));
  await shot('guide-q-files.png');
  await open(3);
  const menus = await js(`({ menus: document.querySelectorAll('.menus .menu').length, hot: [...document.querySelectorAll('.menus .hot')].map((h) => h.textContent.trim()), logo: document.querySelector('.menus img').complete })`);
  check('the right-click answer shows both menus and marks the entries to press', menus.menus === 2 && menus.hot.join() === 'Show more options,Convert with Pomelo' && menus.logo, JSON.stringify(menus));
  check('and the pictures stay inside the card', await within('.menus .menu', '.faq'));
  g = await gap();
  check('the window fits this answer too, with no scrollbar', fits(g), JSON.stringify(g));
  await shot('guide-q-menu.png');
  await open(6);
  const tray = await js(`({ pins: [...document.querySelectorAll('.tray .pin')].map((p) => p.textContent), logo: document.querySelector('.tray .me img').complete && document.querySelector('.tray .me img').naturalWidth > 0 })`);
  check('where is Pomelo: the arrow is marked 1, the Pomelo icon 2', tray.pins.join() === '1,2' && tray.logo, JSON.stringify(tray));
  check('and the pop-up, the arrow and the icon all sit inside the taskbar picture', await within('.tray .flyout, .tray .caret, .tray .me', '.tray'));
  await shot('guide-q-tray.png');
  g = await gap();
  check('the window follows each answer, with no gap and no scrollbar', fits(g), JSON.stringify(g));
  await js(`document.querySelectorAll('details summary')[6].click()`);
  await js(`document.getElementById('site').click()`);
  await sleep(300);
  check('the website button opens the Pomelo website, and nothing else', opened.join() === 'https://pomelo.swymble.com', opened.join());
  const tall = await js(`[document.documentElement.scrollHeight, document.documentElement.clientHeight]`);
  console.log(`  (the page is ${tall[0]} px tall in a window of ${tall[1]} px)`);

  console.log('reduced motion');
  await motion('reduce');
  await sleep(500);
  const still = await js(`({ running: document.getAnimations().filter((a) => !a.animationName.startsWith('faq')).length, wheel: +getComputedStyle(document.querySelector('.wheelbox')).opacity,
    hot: +getComputedStyle(document.querySelector('.hotseg')).opacity, steps: +getComputedStyle(document.querySelector('.steps .s1')).opacity })`);
  check('with reduced motion nothing moves and the wheel is shown open', still.running === 0 && still.wheel === 1 && still.hot === 1 && still.steps === 1, JSON.stringify(still));
  await shot('guide-8-reduced.png');
  await motion('no-preference');

  console.log('light theme');
  nativeTheme.themeSource = 'light';
  await sleep(500);
  await at(5.6);
  await shot('guide-light-wheel.png');
  await at(8.7);
  await shot('guide-light-done.png');

  console.log('closing');
  await js(`document.getElementById('close').click()`);
  await sleep(500);
  check('Got it closes the window, and the app is told', !win() && closed === 1);
  openGuideWindow(asset, { onClosed: () => closed++ });
  await sleep(1500);
  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await sleep(500);
  check('Esc closes it too', !win() && closed === 2);

  console.log(failed() ? `\n${failed()} failed` : '\nall passed');
  finish();
}).catch((e) => { console.error(e); finish(2); });

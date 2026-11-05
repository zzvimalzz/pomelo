// SPDX-License-Identifier: AGPL-3.0-or-later
// Drives the real toast window through single, stacked and summary states with a fake slow converter.
//   npx electron test/ui/toast-shot.js
const { app, screen, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { Toast, heightFor } = require('../../src/features/jobs/toast.window');
const { Jobs } = require('../../src/features/jobs/jobs');
const { timingFormats } = require('../../src/features/conversion');
const { expect: check, failed } = require('../support/expect');
const finish = require('../support/finish');

app.on('window-all-closed', () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = path.join(__dirname, '..', 'shots');

app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });

  // converter that finishes jobs when told to
  const pending = [];
  const convert = (src, to, { onProgress, signal }) => new Promise((resolve, reject) => {
    pending.push({ src, to, onProgress, signal, resolve: () => resolve([src.replace(/\.\w+$/, '.' + to)]), reject });
    signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true });
  });
  const jobs = new Jobs({ convert, formats: timingFormats, concurrency: 3, maxStack: 3 });
  const toast = new Toast({ onRemove: (id) => jobs.remove(id), onCancel: (id) => jobs.cancel(id) });
  toast.create();
  jobs.on('change', (v) => toast.update(v));

  const shot = async (name) => fs.writeFileSync(path.join(out, name), await sharp((await toast.win.webContents.capturePage()).toPNG()).flatten({ background: '#6b7280' }).toBuffer());
  const dom = () => toast.win.webContents.executeJavaScript(`({ cards: [...document.querySelectorAll('.card')].map((c) => ({ title: c.querySelector('.title').textContent, ring: !!c.querySelector('.ring'), classes: c.className })), sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })`);
  const wa = screen.getPrimaryDisplay().workArea;
  const inCorner = () => { const b = toast.win.getBounds(); return b.x + b.width <= wa.x + wa.width && b.x + b.width >= wa.x + wa.width - 10 && b.y + b.height <= wa.y + wa.height && b.y + b.height >= wa.y + wa.height - 10; };

  nativeTheme.themeSource = 'dark';

  console.log('1 conversion');
  jobs.addConversion('C:/v/holiday.mov', 'mp4', 'MP4');
  await sleep(800);
  pending[0].onProgress(0.4);
  await sleep(400);
  let d = await dom();
  check('one card, window height fits one card', d.cards.length === 1 && toast.win.getBounds().height === heightFor(1), `${toast.win.getBounds().height}px`);
  check('bottom-right of the work area', inCorner());
  const geo = await toast.win.webContents.executeJavaScript(`(() => { const r = document.querySelector('.ring').getBoundingClientRect(), x = document.querySelector('.cancel').getBoundingClientRect(); return { dx: Math.abs((r.left + r.width / 2) - (x.left + x.width / 2)), dy: Math.abs((r.top + r.height / 2) - (x.top + x.height / 2)), closeShown: getComputedStyle(document.querySelector('.close')).display !== 'none' }; })()`);
  check('the cancel X sits in the centre of the ring', geo.dx < 1 && geo.dy < 1, JSON.stringify(geo));
  check('no separate dismiss button while working', !geo.closeShown);
  await shot('toast-1-progress.png');

  console.log('3 at once (same file to different formats): stacked, newest on top');
  jobs.addConversion('C:/v/holiday.mov', 'gif', 'GIF');
  jobs.addConversion('C:/v/holiday.mov', 'mp3', 'MP3');
  await sleep(900);
  pending[1].onProgress(0.7);
  await sleep(400);
  d = await dom();
  check('three cards', d.cards.length === 3, d.cards.map((c) => c.title).join(' | '));
  check('newest (MP3) is on top, oldest (MP4) at the bottom', /MP3/.test(d.cards[0].title) && /MP4/.test(d.cards[2].title));
  check('window grew upward to fit three cards', toast.win.getBounds().height === heightFor(3) && inCorner(), `${toast.win.getBounds().height}px`);
  await shot('toast-3-stack.png');

  console.log('a 4th conversion: everything folds into one summary card');
  jobs.addConversion('C:/v/notes.docx', 'pdf', 'PDF');
  await sleep(900);
  d = await dom();
  check('one summary card with a ring', d.cards.length === 1 && d.cards[0].ring, d.cards.map((c) => c.title).join(' | '));
  check('window shrank to one card, still in the corner', toast.win.getBounds().height === heightFor(1) && inCorner());
  await shot('toast-summary-0.png');
  pending[0].resolve();
  await sleep(500);
  pending[1].onProgress(0.5);
  await sleep(600);
  await shot('toast-summary-1.png');

  console.log('clicking the X on the summary cancels what is left');
  await toast.win.webContents.executeJavaScript(`document.querySelector('.cancel').click()`);
  await sleep(500);
  await shot('toast-summary-cancelled.png');

  console.log('finishing a fresh batch');
  jobs.remove('summary');
  await sleep(300);
  const first = pending.length;
  for (const f of ['a', 'b', 'c', 'd']) jobs.addConversion(`C:/v/${f}.docx`, 'pdf', 'PDF');
  await sleep(700);
  for (const p of pending.slice(first)) p.resolve();
  await sleep(500);
  for (const p of pending.slice(first)) p.resolve();
  await sleep(800);
  d = await dom();
  check('no horizontal overflow', d.sw <= d.cw);
  await shot('toast-summary-done.png');

  console.log('light theme, error and info cards stacked');
  nativeTheme.themeSource = 'light';
  await sleep(300);
  jobs.remove('summary');
  await sleep(300);
  jobs.addInfo({ title: "Shortcuts can't be converted", detail: 'Drag the file the shortcut points to instead.' });
  jobs.addConversion('C:/v/broken.docx', 'pdf', 'PDF');
  await sleep(700);
  pending[pending.length - 1].reject(new Error('LibreOffice produced no output'));
  await sleep(700);
  d = await dom();
  check('info + error stacked, error newest on top', d.cards.length === 2 && /Conversion failed/.test(d.cards[0].title), d.cards.map((c) => c.title).join(' | '));
  await shot('toast-light-mixed.png');

  console.log('cards fade out and the window hides when empty');
  for (const c of [...jobs.view().cards]) jobs.remove(c.id);
  await sleep(500);
  check('window hidden', toast.win.isVisible() === false);

  console.log(failed() ? `\n${failed()} failed` : '\nall passed');
  finish();
}).catch((e) => { console.error(e); finish(2); });

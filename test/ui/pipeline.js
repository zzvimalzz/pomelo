// SPDX-License-Identifier: AGPL-3.0-or-later
// Feeds synthetic input events (what the native input helper would send) through Trigger -> the drop flow -> the wheel window.
//   npx electron test/ui/pipeline.js
const { app } = require('electron');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const convert = require('../../src/features/conversion');
const { Trigger } = require('../../src/features/gesture/trigger');
const { WheelWindow } = require('../../src/features/gesture/wheel.window');
const { createDropFlow } = require('../../src/app/drop-flow');
const { editable } = require('../../src/features/image-editor/limits');

app.on('window-all-closed', () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { expect: check, failed } = require('../support/expect');
const finish = require('../support/finish');
const tmp = require('../support/tmp');

app.whenReady().then(async () => {
  convert.detectEngines();
  const dir = tmp.dir('pipe');
  const file = path.join(dir, 'report.docx');
  fs.writeFileSync(file, 'x');
  const pdf = path.join(dir, 'report.pdf');
  fs.writeFileSync(pdf, 'x');

  let selection = { files: [file], explorer: true };
  const helper = new EventEmitter();
  helper.down = () => {};
  helper.files = async () => selection;
  const overlay = new WheelWindow({ onDrop: (paths, to) => flow.onDrop(paths, to), onUnlock: (request) => flow.onUnlock(request), onUnlockEnd: () => flow.onUnlockEnd() });
  overlay.create();
  const opened = [];
  const edited = [];
  const flow = createDropFlow({ conversion: convert, getWheel: () => overlay, getJobs: () => ({ addInfo: () => {} }), openPdfs: (paths) => opened.push(...paths), openImages: (paths) => edited.push(...paths), canEdit: (file) => editable(convert.extOf(file)), keysSupported: () => true, log: () => {} });
  const trigger = new Trigger(helper);
  const events = [];
  const wheels = [];
  trigger.on('open', (files, { wheel }) => { events.push('open'); wheels.push(wheel); flow.onOpen(files, false, wheel); });
  trigger.on('switch', (wheel) => { events.push('switch'); wheels.push(wheel); flow.onSwitch(wheel); });
  trigger.on('unsupported', () => events.push('unsupported'));
  trigger.on('release', () => { events.push('release'); overlay.releaseSoon(); });
  trigger.on('cancel', () => { events.push('cancel'); overlay.hide(); });
  trigger.start();
  const send = (...ev) => helper.emit('input', ev);
  await sleep(1500);

  console.log('drag a file, tap Ctrl');
  send('md', '500', '500'); send('mm', '520', '520'); await sleep(100); send('kd', 'ctrl');
  await sleep(1000);
  check('the wheel opens', events.includes('open') && overlay.win.isVisible() && trigger.state === 'wheel');
  const b = overlay.win.getBounds();
  check('and is 400 wide, with a band above the wheel for the pill', b.width === 400 && b.height === 464);
  send('mu'); await sleep(900);
  check('releasing without dropping folds it away', !overlay.win.isVisible() && events.includes('release'));

  console.log('drag a PDF, tap Shift: the Open wheel, and the other key turns it');
  const page = (code) => overlay.win.webContents.executeJavaScript(code);
  const showing = () => page(`document.getElementById('stage').dataset.wheel + ' ' + document.querySelectorAll('.seg').length + ' ' + document.querySelectorAll('.seg.ring').length + ' ' + document.querySelectorAll('#segments .spin').length`);
  const dropEffect = (x, y) => page(`(() => { const e = new Event('dragover', { cancelable: true }); e.clientX = ${x}; e.clientY = ${y + 64}; e.dataTransfer = { dropEffect: '' }; window.dispatchEvent(e); return e.dataTransfer.dropEffect; })()`);
  events.length = 0; wheels.length = 0;
  selection = { files: [pdf], explorer: true };
  send('md', '500', '500'); send('mm', '520', '520'); await sleep(100); send('kd', 'shift'); await sleep(1000);
  check('Shift opens the Open wheel, one ring', wheels.join() === 'open' && overlay.win.isVisible() && (await showing()) === 'open 1 1 1' && overlay.win.getBounds().width === 400 && overlay.win.getBounds().height === 464, `${wheels} ${await showing()}`);
  check('a drop on the ring is allowed, and the centre refuses', (await dropEffect(200, 80)) === 'copy' && (await dropEffect(200, 200)) === 'none');
  send('kd', 'shift'); await sleep(200);
  check('Shift again does nothing', wheels.join() === 'open' && !events.includes('switch'));
  send('kd', 'ctrl'); await sleep(900);
  const [kind, count, rings, groups] = (await showing()).split(' ');
  check('Ctrl turns it into the conversion wheel, and the old segments are gone', wheels.join() === 'open,convert' && kind === 'convert' && +count > 1 && rings === '0' && groups === count, await showing());
  send('kd', 'shift'); await sleep(900);
  check('Shift turns it back', wheels.join() === 'open,convert,open' && (await showing()) === 'open 1 1 1', await showing());
  await page(`window.pomelo.drop('open', [${JSON.stringify(pdf)}, ${JSON.stringify(file)}])`);
  await sleep(300);
  check('a drop on the ring hands the PDFs, and only them, to the PDF workspace', opened.join() === pdf, opened.join());
  send('mu'); await sleep(900);
  check('letting go folds it away', !overlay.win.isVisible());

  console.log('drag a picture, tap Shift: the Edit wheel, and the other key turns it');
  const png = path.join(dir, 'photo.png');
  fs.writeFileSync(png, 'x');
  const pill = () => page(`document.getElementById('pillKbd').textContent + ' ' + document.getElementById('pillName').textContent`);
  selection = { files: [png], explorer: true };
  events.length = 0; wheels.length = 0;
  send('md', '500', '500'); send('mm', '520', '520'); await sleep(100); send('kd', 'shift'); await sleep(1000);
  check('Shift opens the Edit wheel, one ring, and the pill names Ctrl Convert', wheels.join() === 'open' && (await showing()) === 'open 1 1 1' && (await pill()) === 'Ctrl Convert', `${wheels} ${await showing()} ${await pill()}`);
  send('kd', 'ctrl'); await sleep(900);
  check('Ctrl turns it into the conversion wheel, and the pill names Shift Edit', (await showing()).startsWith('convert ') && (await pill()) === 'Shift Edit', `${await showing()} ${await pill()}`);
  send('kd', 'shift'); await sleep(900);
  await page(`window.pomelo.drop('edit', [${JSON.stringify(png)}, ${JSON.stringify(file)}])`);
  await sleep(300);
  check('a drop on the ring hands the pictures, and only them, to the image editor', edited.join() === png, edited.join());
  send('mu'); await sleep(900);

  console.log('drag a Word file, tap Shift: the conversion wheel, with no pill');
  selection = { files: [file], explorer: true };
  events.length = 0; wheels.length = 0;
  send('md', '500', '500'); send('mm', '520', '520'); await sleep(100); send('kd', 'shift'); await sleep(900);
  const pillHidden = () => page(`document.getElementById('pill').hidden`);
  check('the conversion wheel shows, and a drop on it is taken', (await showing()).startsWith('convert ') && (await dropEffect(200, 80)) === 'copy', await showing());
  check('and it has no pill, because Shift is of no use here', await pillHidden() === true);
  send('kd', 'shift'); await sleep(300);
  check('Shift again changes nothing', (await showing()).startsWith('convert ') && !events.includes('switch'));
  send('mu'); await sleep(900);
  selection = { files: [file], explorer: true };

  console.log('keys pressed without dragging do nothing');
  events.length = 0;
  send('kd', 'ctrl'); await sleep(200);
  check('no wheel', !events.includes('open') && !overlay.win.isVisible());

  console.log('a small mouse jiggle is not a drag');
  send('md', '500', '500'); send('mm', '503', '502'); send('kd', 'ctrl'); await sleep(200);
  check('no wheel', !events.includes('open')); send('mu');

  console.log('Esc cancels');
  send('md', '500', '500'); send('mm', '530', '530'); await sleep(100); send('kd', 'ctrl'); await sleep(800);
  send('kd', 'esc'); await sleep(500);
  check('the wheel closes', events.includes('cancel') && !overlay.win.isVisible()); send('mu');

  console.log('dragging something Explorer did not give us (a virtual item)');
  events.length = 0;
  selection = { files: [], explorer: true };
  send('md', '500', '500'); send('mm', '530', '530'); await sleep(100); send('kd', 'ctrl'); await sleep(500);
  check("tells the user instead of staying silent ('unsupported')", events.includes('unsupported')); send('mu');

  console.log('dragging in some other app');
  events.length = 0;
  selection = { files: [], explorer: false };
  send('md', '500', '500'); send('mm', '530', '530'); await sleep(100); send('kd', 'ctrl'); await sleep(500);
  check('stays silent', events.length === 0); send('mu');

  console.log(failed() ? `\n${failed()} failed` : '\nall passed');
  finish();
}).catch((e) => { console.error(e); finish(2); });

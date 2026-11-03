// SPDX-License-Identifier: AGPL-3.0-or-later
// Feeds synthetic input events (what the native input helper would send) through Trigger -> Overlay.
//   npx electron test/pipeline.js
const { app } = require('electron');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const os = require('os');
const convert = require('../src/main/convert');
const { Trigger } = require('../src/main/trigger');
const { Overlay } = require('../src/main/overlay');

app.on('window-all-closed', () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const check = (name, ok, extra = '') => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); };

app.whenReady().then(async () => {
  convert.detectEngines();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pomelo-pipe-'));
  const file = path.join(dir, 'report.docx');
  fs.writeFileSync(file, 'x');

  let selection = { files: [file], explorer: true };
  const helper = new EventEmitter();
  helper.down = () => {};
  helper.files = async () => selection;
  const overlay = new Overlay({ onDrop: () => {} });
  overlay.create();
  const trigger = new Trigger(helper);
  const events = [];
  trigger.on('open', (files) => { events.push('open'); overlay.openWheel(files, convert.targetsFor(files)); });
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
  check('and is 400x400', b.width === 400 && b.height === 400);
  send('mu'); await sleep(900);
  check('releasing without dropping folds it away', !overlay.win.isVisible() && events.includes('release'));

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

  console.log(bad ? `\n${bad} failed` : '\nall passed');
  app.exit(bad ? 1 : 0);
});

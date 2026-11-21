// SPDX-License-Identifier: AGPL-3.0-or-later
// The gesture state machine against a fake input helper: which key shows which wheel, the other key turning it, and what each ending does.
// Also the helper's client: it asks the native helper for those keys once it says it is ready.
//   node test/unit/gesture/trigger.test.js
const { EventEmitter } = require('events');
const { Trigger, KEY_WHEELS } = require('../../../src/features/gesture/trigger');
const { InputHelper } = require('../../../src/features/gesture/input-helper');
const { expect } = require('../../support/expect');
const finish = require('../../support/finish');

const tick = () => new Promise((resolve) => setImmediate(resolve));

(async () => {
  let selection = { files: ['C:\\a.pdf'], explorer: true };
  let release = null;                                       // when set, the selection is not known until release() is called
  const helper = new EventEmitter();
  helper.down = () => {};
  helper.files = () => (release ? new Promise((resolve) => { release = () => resolve(selection); }) : Promise.resolve(selection));
  const trigger = new Trigger(helper);
  const events = [];
  trigger.on('open', (files, { wheel }) => events.push(`open ${wheel} ${files.join()}`));
  for (const name of ['switch', 'release', 'cancel', 'unsupported']) trigger.on(name, (arg) => events.push(arg ? `${name} ${arg}` : name));
  trigger.start();
  const send = async (...ev) => { helper.emit('input', ev); await tick(); };
  const seen = () => { const list = events.splice(0).join(' ; '); return list; };
  const drag = async () => { await send('md', '500', '500'); await send('mm', '530', '530'); };

  console.log('the keys that show a wheel');
  expect('Ctrl shows the conversion wheel and Shift the Open wheel', Object.keys(KEY_WHEELS).join() === 'ctrl,shift' && KEY_WHEELS.ctrl === 'convert' && KEY_WHEELS.shift === 'open');
  const written = [];
  const client = new InputHelper();
  client.proc = { stdin: { write: (line) => written.push(line) } };
  client.onData('{"ready":true,"keys":true}\n');
  expect('a helper that says it takes keys is asked for Ctrl and Shift', written.join() === 'keys ctrl shift\n' && client.keysSupported);
  client.ready = false;
  client.onData('{"ready":true}\n');
  expect('an older helper that does not say so is still asked, and is known to report Ctrl only', written.length === 2 && !client.keysSupported);
  await drag(); await send('kd', 'ctrl');
  expect('Ctrl while dragging shows the conversion wheel', seen() === 'open convert C:\\a.pdf');
  await send('mu');
  expect('letting go folds it away', seen() === 'release' && trigger.state === 'idle');
  await drag(); await send('kd', 'shift');
  expect('Shift while dragging shows the Open wheel', seen() === 'open open C:\\a.pdf');
  await send('mu'); seen();
  await drag(); await send('kd', 'alt');
  expect('another key shows nothing', seen() === '' && trigger.state === 'dragging');
  await send('mu'); seen();
  await send('kd', 'shift');
  expect('Shift with no drag shows nothing', seen() === '');

  console.log('turning one wheel into the other');
  await drag(); await send('kd', 'ctrl'); seen();
  await send('kd', 'ctrl');
  expect('the key of the wheel already showing does nothing', seen() === '');
  await send('kd', 'shift');
  expect('the other key turns it', seen() === 'switch open');
  await send('kd', 'shift');
  expect('and again does nothing', seen() === '');
  await send('kd', 'ctrl');
  expect('and Ctrl turns it back', seen() === 'switch convert');
  await send('kd', 'esc');
  expect('Esc closes the wheel', seen() === 'cancel' && trigger.state === 'idle');
  await send('kd', 'shift');
  expect('and then no key does anything', seen() === '');
  await send('mu'); seen();

  console.log('before the selection is known');
  release = () => {};
  await drag(); await send('kd', 'ctrl'); await send('kd', 'shift');
  expect('nothing is shown yet, and no switch is announced', seen() === '');
  release();
  await tick();
  expect('the wheel of the last key is the one that opens', seen() === 'open open C:\\a.pdf');
  await send('mu'); seen();
  release = () => {};
  await drag(); await send('kd', 'shift');
  await send('mu'); seen();
  release();
  await tick();
  expect('let go before the selection is known: no wheel', seen() === '');
  release = null;

  console.log('a selection with nothing to show');
  selection = { files: [], explorer: true };
  await drag(); await send('kd', 'shift');
  expect('an Explorer item with no real file says so', seen() === 'unsupported');
  await send('kd', 'ctrl');
  expect('and no wheel turns', seen() === '');
  await send('mu'); seen();
  selection = { files: [], explorer: false };
  await drag(); await send('kd', 'shift');
  expect('a drag in another app stays silent', seen() === '' && trigger.state === 'dragging');
  await send('mu'); seen();

  console.log('turned off');
  selection = { files: ['C:\\a.pdf'], explorer: true };
  trigger.setEnabled(false);
  await drag(); await send('kd', 'shift');
  expect('no key shows a wheel', seen() === '');

  finish();
})().catch((e) => { console.error(e); finish(2); });

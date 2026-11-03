// SPDX-License-Identifier: AGPL-3.0-or-later
// Protocol check for the native input helper. Needs no desktop interaction and presses no keys.   node test/helper-test.js
// (Run `npm run build:helper` first.)
const path = require('path');
const { spawn } = require('child_process');

let failures = 0;
const expect = (name, ok, extra = '') => { if (!ok) failures++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const proc = spawn(path.join(__dirname, '..', 'native', 'bin', 'pomelo-input.exe'), [], { windowsHide: true });
  const lines = [];
  let buf = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i).trim()); buf = buf.slice(i + 1); } });
  const waitFor = async (pred, ms = 20000) => { for (let t = 0; t < ms; t += 25) { const l = lines.find(pred); if (l) return l; await sleep(25); } return null; };
  const ask = async (id) => { proc.stdin.write(`files ${id}\n`); const l = await waitFor((x) => x.startsWith('{"id":' + id + ',')); return l && JSON.parse(l); };

  console.log('native input helper');
  expect('says ready once its hooks are installed', await waitFor((l) => l === '{"ready":true}') !== null);

  const none = await ask(1);
  expect('no drag in progress: no files, not an Explorer drag', none && none.files.length === 0 && none.explorer === false);

  proc.stdin.write('garbage\nkey nonsense\nkey alt\ndown x y\ndown 1 1\n');
  const after = await ask(2);
  expect('ignores malformed commands and keeps answering', after && after.id === 2 && Array.isArray(after.files));

  const closed = new Promise((r) => proc.on('exit', r));
  proc.stdin.end();
  expect('exits when Pomelo closes its stdin', await Promise.race([closed.then(() => true), sleep(10000).then(() => false)]));

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();

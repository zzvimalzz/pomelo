// SPDX-License-Identifier: AGPL-3.0-or-later
// The right-click menu: what is written to the registry (with a fake `reg`, nothing real is touched), reading the path Explorer passes,
// and gathering one selection's starts into a batch.   node test/unit/app/shell-menu.test.js
const fs = require('fs');
const path = require('path');
const { installShellMenu, removeShellMenu, convertPathsFromArgv, createBatcher } = require('../../../src/app/shell-menu');
const { expect } = require('../../support/expect');
const finish = require('../../support/finish');
const { dir: tmpDir } = require('../../support/tmp');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readReg = (file) => fs.readFileSync(file).subarray(2).toString('utf16le');

(async () => {
  console.log('the path Explorer passes');
  const root = tmpDir('shell');
  const real = path.join(root, 'report.docx');
  fs.writeFileSync(real, 'x');
  expect('an existing file is taken', convertPathsFromArgv(['Pomelo.exe', `--convert=${real}`]).join() === real);
  expect('a folder is taken too', convertPathsFromArgv(['Pomelo.exe', `--convert=${root}`]).join() === root);
  expect('it does not matter where Electron put the switch', convertPathsFromArgv(['electron.exe', '--allow-file-access-from-files', `--convert=${real}`, 'C:/app']).join() === real);
  expect('a path that does not exist is ignored', convertPathsFromArgv(['Pomelo.exe', `--convert=${path.join(root, 'nope.docx')}`]).length === 0);
  expect('a relative path is ignored', convertPathsFromArgv(['Pomelo.exe', '--convert=report.docx']).length === 0);
  expect('an empty path is ignored', convertPathsFromArgv(['Pomelo.exe', '--convert=']).length === 0);
  expect('an ordinary start has nothing to convert', convertPathsFromArgv(['Pomelo.exe', '--hidden']).length === 0);

  console.log('one selection, several starts');
  const batches = [];
  const batcher = createBatcher(40, (b) => batches.push(b));
  batcher.add(['b.txt']); await sleep(10); batcher.add(['a.txt']); await sleep(10); batcher.add(['b.txt']);
  expect('nothing is handed over while files keep arriving', batches.length === 0);
  await sleep(90);
  expect('they arrive as one sorted batch without repeats', batches.length === 1 && batches[0].join() === 'a.txt,b.txt', JSON.stringify(batches));
  batcher.add(['c.txt']); await sleep(90);
  expect('the next selection is a batch of its own', batches.length === 2 && batches[1].join() === 'c.txt');

  console.log('the registry entries');
  const exe = 'C:\\Users\\Zoë\\AppData\\Local\\Programs\\Pomelo\\Pomelo.exe';
  const calls = [];
  let written = '';
  const run = (known) => async (cmd, args) => {
    calls.push(args[0]);
    if (args[0] === 'query') return known ? { code: 0, out: `    PomeloMenu    REG_SZ    0.2.0|"${exe}" "--convert=%1"|2\r\n` } : { code: 1, out: '' };
    written = readReg(args[1]);
    return { code: 0, out: '' };
  };
  const wrote = await installShellMenu({ exe, version: '0.2.0', exts: ['docx', 'png'], run: run(false) });
  expect('a first start writes the entries', wrote === true && calls.join() === 'query,import', calls.join());
  expect('for each format, under the file association of that format', written.includes('[HKEY_CURRENT_USER\\Software\\Classes\\SystemFileAssociations\\.docx\\shell\\Pomelo]') && written.includes('SystemFileAssociations\\.png\\shell\\Pomelo]'));
  expect('and for folders', written.includes('[HKEY_CURRENT_USER\\Software\\Classes\\Directory\\shell\\Pomelo]'));
  expect('with the text of the menu entry', written.includes('@="Convert with Pomelo"'));
  expect('the command passes the selected file and keeps the quotes and an accented user name', written.includes('@="\\"C:\\\\Users\\\\Zoë\\\\AppData\\\\Local\\\\Programs\\\\Pomelo\\\\Pomelo.exe\\" \\"--convert=%1\\""'), written.split('\r\n').find((l) => l.includes('--convert')));
  expect('the file starts with the registry header', written.startsWith('Windows Registry Editor Version 5.00'));
  calls.length = 0;
  const again = await installShellMenu({ exe, version: '0.2.0', exts: ['docx', 'png'], run: run(true) });
  expect('a start that finds them already there writes nothing', again === false && calls.join() === 'query', calls.join());
  calls.length = 0;
  const newer = await installShellMenu({ exe, version: '0.3.0', exts: ['docx', 'png'], run: run(true) });
  expect('a new version writes them again', newer === true && calls.join() === 'query,import');
  calls.length = 0;
  await installShellMenu({ exe: 'C:\\electron\\electron.exe', launch: ['C:\\src\\pomelo'], version: '0.2.0', exts: ['docx'], run: run(false) });
  expect('run from source, the command carries the app folder', written.includes('@="\\"C:\\\\electron\\\\electron.exe\\" \\"C:\\\\src\\\\pomelo\\" \\"--convert=%1\\""'), written.split('\r\n').find((l) => l.includes('--convert')));
  calls.length = 0;
  await removeShellMenu({ exts: ['docx', 'png'], run: run(true) });
  expect('removing deletes every key it wrote', written.includes('[-HKEY_CURRENT_USER\\Software\\Classes\\SystemFileAssociations\\.docx\\shell\\Pomelo]') && written.includes('[-HKEY_CURRENT_USER\\Software\\Classes\\Directory\\shell\\Pomelo]') && !written.includes('--convert'));

  finish();
})().catch((e) => { console.error(e); finish(1); });

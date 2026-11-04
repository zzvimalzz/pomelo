// SPDX-License-Identifier: AGPL-3.0-or-later
// shared/node/paths.js and which.js: every file Pomelo ships resolves to something that exists when run from source, and the
// lookups behave. (The packaged build is checked separately: the same paths must exist under resources/app.)
const fs = require('fs');
const path = require('path');
const paths = require('../../../src/shared/node/paths');
const { where, findExe } = require('../../../src/shared/node/which');
const ffmpeg = require('../../../src/features/conversion/engines/ffmpeg');
const archive = require('../../../src/features/conversion/engines/archive');
const { expect } = require('../../support/expect');
const finish = require('../../support/finish');

console.log('bundled resources exist');
{
  const SCRIPTS = ['heic_run.py', 'ocr_warmup.py', 'pdf_structure_run.py', 'pdf_pptx_export.py', 'pdf_tables_run.py', 'pdf_to_docx.py'];
  const { ffmpeg: ffmpegExe } = ffmpeg.detect(), { sevenZip } = archive.detect();
  expect('FFmpeg', fs.existsSync(ffmpegExe || ''), String(ffmpegExe));
  expect('7-Zip', fs.existsSync(sevenZip || ''), String(sevenZip));
  expect('the input helper (npm run build:helper)', fs.existsSync(paths.inApp('native', 'bin', 'pomelo-input.exe')));
  expect(`the ${SCRIPTS.length} Python scripts the engines run`, SCRIPTS.every((s) => fs.existsSync(paths.scriptPath(s))), SCRIPTS.filter((s) => !fs.existsSync(paths.scriptPath(s))).join(', '));
  expect('the PDF font data pdf.js needs', fs.existsSync(path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts')));
  expect('the tray icon', fs.existsSync(path.join(paths.APP_ROOT, 'assets', 'tray.png')));
}

console.log('paths');
{
  expect('the app root is the folder with package.json', fs.existsSync(path.join(paths.APP_ROOT, 'package.json')));
  expect('a path inside an asar archive is pointed at the unpacked copy', paths.bundled('C:\\Pomelo\\resources\\app.asar\\bin\\x.exe') === 'C:\\Pomelo\\resources\\app.asar.unpacked\\bin\\x.exe');
  expect('a path that is already unpacked is left alone', paths.bundled('C:\\Pomelo\\resources\\app.asar.unpacked\\bin\\x.exe') === 'C:\\Pomelo\\resources\\app.asar.unpacked\\bin\\x.exe');
  expect('a path outside an archive is left alone', paths.bundled('C:\\Pomelo\\bin\\x.exe') === 'C:\\Pomelo\\bin\\x.exe');
  expect('the Python of an environment sits in pyenv\\Scripts', paths.pyenvPython('C:\\e') === path.join('C:\\e', 'pyenv', 'Scripts', 'python.exe'));
  expect('the engines folder is under %LOCALAPPDATA%\\Pomelo', paths.enginesRoot().toLowerCase().endsWith(path.join('Pomelo', 'engines').toLowerCase()));
  expect('vendor/ in the app folder is searched', paths.vendorRoots().includes(path.join(paths.APP_ROOT, 'vendor')));
}

console.log('finding programs');
{
  const node = where('node.exe');
  expect('where() finds a program on PATH', !!node && fs.existsSync(node), String(node));
  expect('where() gives null for one that is not there', where('pomelo-no-such-program.exe') === null);
  expect('findExe() falls back to PATH', findExe('node.exe', ['']) !== null);
  expect('findExe() gives null when nothing matches', findExe('pomelo-no-such-program.exe', ['Pomelo-none']) === null);
}

finish();

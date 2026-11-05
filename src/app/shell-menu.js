// SPDX-License-Identifier: AGPL-3.0-or-later
// "Convert with Pomelo" in Explorer's right-click menu. Registered for the current user only (no administrator rights), once for each
// format Pomelo reads and once for folders. Explorer starts `Pomelo.exe "--convert=<file>"` for every selected file, so the files
// of one selection arrive as several starts a moment apart and are gathered into one batch.
const fs = require('fs');
const path = require('path');
const { runStatus } = require('#shared/node/process');
const { withTempFile } = require('#shared/node/fs');

const CLASSES = 'HKEY_CURRENT_USER\\Software\\Classes';
const keyOf = (ext) => `${CLASSES}\\SystemFileAssociations\\.${ext}\\shell\\Pomelo`;
const FOLDER_KEY = `${CLASSES}\\Directory\\shell\\Pomelo`;
const CONVERT = '--convert=';
const regString =(s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function addLines(key, exe, command, mark) {
  return [
    `[${key}]`, `@=${regString('Convert with Pomelo')}`, `"Icon"=${regString(`"${exe}",0`)}`, `"PomeloMenu"=${regString(mark)}`, '',
    `[${key}\\command]`, `@=${regString(command)}`, '',
  ];
}

// .reg files are read as UTF-16 with a byte order mark, which keeps a user name with accents intact.
function importReg(lines, run) {
  const text = ['Windows Registry Editor Version 5.00', '', ...lines].join('\r\n');
  return withTempFile('reg', (file) => {
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
    return run('reg', ['import', file], { timeout: 30000 });
  });
}

// Writes the entries unless they are already there for this version, this command and this list of formats. -> true when written.
// `launch` goes between the program and the switch: empty for the installed app, the app folder when Electron runs from source.
// The path is part of the switch (`--convert=<path>`) because Electron moves switches in front of other arguments when it passes a
// second start to the running Pomelo, which would separate `--convert` from the path after it.
async function installShellMenu({ exe, launch = [], version, exts, run = runStatus }) {
  const command = [...[exe, ...launch].map((part) => `"${part}"`), '"--convert=%1"'].join(' ');
  const mark = `${version}|${command}|${exts.length}`;
  const current = await run('reg', ['query', FOLDER_KEY, '/v', 'PomeloMenu'], { timeout: 10000 });
  if (current.code === 0 && current.out.includes(mark)) return false;
  const lines = [...exts.flatMap((ext) => addLines(keyOf(ext), exe, command, mark)), ...addLines(FOLDER_KEY, exe, command, mark)];
  return (await importReg(lines, run)).code === 0;
}

async function removeShellMenu({ exts, run = runStatus }) {
  await importReg([...exts.map((ext) => `[-${keyOf(ext)}]`), `[-${FOLDER_KEY}]`], run);
}

// The file or folder a `--convert=<path>` start was asked to convert: [] when there is none or it is not a path that exists.
function convertPathsFromArgv(argv) {
  const given = argv.find((a) => a.startsWith(CONVERT))?.slice(CONVERT.length);
  return given && path.isAbsolute(given) && fs.existsSync(given) ? [given] : [];
}

// Gathers the paths added within `delayMs` of each other and hands them over once, sorted.
function createBatcher(delayMs, onBatch) {
  let paths = new Set();
  let timer = null;
  return {
    add(list) {
      for (const p of list) paths.add(p);
      clearTimeout(timer);
      timer = setTimeout(() => { const batch = [...paths].sort(); paths = new Set(); onBatch(batch); }, delayMs);
    },
  };
}

module.exports = { installShellMenu, removeShellMenu, convertPathsFromArgv, createBatcher };

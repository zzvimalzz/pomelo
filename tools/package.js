// SPDX-License-Identifier: AGPL-3.0-or-later
// Packages the app with its own Electron into dist/Pomelo-win32-x64/Pomelo.exe (what the installer installs).   npm run package
// No asar archive: the helper programs (ffmpeg, 7-Zip, pomelo-input.exe) are plain files on disk, nothing is unpacked at run time.
const path = require('path');
const { packager } = require('@electron/packager');
const pkg = require('../package.json');

const root = path.join(__dirname, '..');

// Everything the running app needs is shipped; development folders and files are left out (paths start with "/").
const IGNORE = [
  /^\/(\.git|\.github|\.claude|dist|docs|test|tools|installer|site|vendor)(\/|$)/,
  /^\/(\.editorconfig|\.gitattributes|\.gitignore|\.npmrc|AGENTS\.md|CLAUDE\.md|eslint\.config\.js|package-lock\.json|Start Pomelo\.bat)$/,
  /^\/(README|CHANGELOG|CONTRIBUTING|CLA|CODE_OF_CONDUCT|SECURITY)\.md$/,     // LICENSE and THIRD_PARTY_NOTICES.md ship
  /^\/(src|python|native)\/.*\.md$/,                                         // developer notes next to the code
  /^\/assets\/(screenshots|icon\.ico)/,
  /^\/python\/(.*\/)?__pycache__(\/|$)/,
];

packager({
  dir: root,
  out: path.join(root, 'dist'),
  name: 'Pomelo',
  platform: 'win32',
  arch: 'x64',
  asar: false,
  prune: true,
  overwrite: true,
  icon: path.join(root, 'assets', 'icon.ico'),
  appVersion: pkg.version,
  appCopyright: 'Copyright (C) 2026 Vimal, AGPL-3.0-or-later',
  ignore: IGNORE,
  win32metadata: {
    CompanyName: 'Vimal',
    FileDescription: 'Pomelo file converter',
    ProductName: 'Pomelo',
    OriginalFilename: 'Pomelo.exe',
  },
}).then((dirs) => console.log(`packaged: ${dirs.join(', ')}`)).catch((e) => { console.error(e.message); process.exit(1); });

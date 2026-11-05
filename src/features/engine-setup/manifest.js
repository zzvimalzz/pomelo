// SPDX-License-Identifier: AGPL-3.0-or-later
// manifest.json in the engines folder: everything Pomelo itself added, so uninstalling never touches software the user installed.
//   { "winget": [{ "id": "...", "name": "..." }], "pyenv": true, "soffice": true }
// The format is fixed: the installer's uninstaller and older versions of Pomelo read it.
const fs = require('fs');
const path = require('path');

const EMPTY = () => ({ winget: [], pyenv: false, soffice: false });

function createManifest(root) {
  const file = path.join(root, 'manifest.json');

  const read = () => { try { return { ...EMPTY(), ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { return EMPTY(); } };
  const write = (m) => { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(file, JSON.stringify(m, null, 2)); };
  const record = (patch) => {
    const m = read();
    if (patch.winget && !m.winget.some((w) => w.id === patch.winget.id)) m.winget.push(patch.winget);
    if (patch.pyenv) m.pyenv = true;
    if (patch.soffice) m.soffice = true;
    write(m);
  };

  return { read, write, record };
}

module.exports = { createManifest };

// SPDX-License-Identifier: AGPL-3.0-or-later
// Where conversions are saved: the folder picked in Settings while it still works, otherwise next to the original file.
const fs = require('fs');
const path = require('path');

function isUsable(dir) {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch { return false; }
}

// getDir(): the folder from the settings ('' for none). notify(dir): called once each time that folder stops working.
// -> () => the folder to save into, or undefined for next to the original.
function createOutputDir({ getDir, notify }) {
  let told = '';
  return () => {
    const dir = getDir();
    if (!dir) return undefined;
    if (isUsable(dir)) { told = ''; return dir; }
    if (told !== dir) { told = dir; notify(dir); }
    return undefined;
  };
}

const folderName = (dir) => path.basename(dir) || dir;

module.exports = { createOutputDir, folderName };

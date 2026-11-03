// SPDX-License-Identifier: AGPL-3.0-or-later
// Dev tool: exported names (and settings/IPC channels) that nothing else in the project uses.   node tools/unused-exports.js
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(d, e.name);
  if (e.isDirectory()) return ['node_modules', 'vendor', 'dist', '.git', 'shots'].includes(e.name) ? [] : walk(p);
  return /\.(js|mjs|html)$/.test(e.name) ? [p] : [];
});
const files = walk(root);
const text = Object.fromEntries(files.map((f) => [f, fs.readFileSync(f, 'utf8')]));
let found = 0;

// Top-level keys of `module.exports = { ... }` (commas inside nested brackets do not count)
function exportedNames(src) {
  const start = src.indexOf('module.exports = {');
  if (start < 0) return [];
  const names = [];
  let depth = 0, token = '';
  for (let i = start + 'module.exports = '.length; i < src.length; i++) {
    const c = src[i];
    if ('{(['.includes(c)) { depth++; if (depth > 1) token += c; continue; }
    if ('})]'.includes(c)) { depth--; if (depth === 0) break; token += c; continue; }
    if (c === ',' && depth === 1) { names.push(token); token = ''; continue; }
    token += c;
  }
  names.push(token);
  return names.map((t) => t.trim().split(/[:(\s]/)[0]).filter(Boolean);
}

for (const file of files.filter((f) => f.includes(`${path.sep}src${path.sep}main${path.sep}`))) {
  for (const name of exportedNames(text[file])) {
    const used = files.some((f) => f !== file && new RegExp(`\\b${name}\\b`).test(text[f]));
    const usedInside = (text[file].match(new RegExp(`\\b${name}\\b`, 'g')) || []).length > 1;
    if (!used) { found++; console.log(`${path.relative(root, file)}: "${name}" is exported but never used elsewhere${usedInside ? ' (used inside the file)' : ' and not used inside either'}`); }
  }
}

// IPC channels: every channel that is sent must be received, and the other way round
const channels = {};
for (const [file, src] of Object.entries(text)) {
  for (const m of src.matchAll(/(?:ipcMain\.(?:on|once|handle)|ipcRenderer\.(?:send|invoke|on))\(\s*'([^']+)'/g)) (channels[m[1]] ||= new Set()).add(file.includes('preload') || file.includes('renderer') ? 'renderer-side' : 'main-side');
  for (const m of src.matchAll(/webContents\.send\(\s*'([^']+)'/g)) (channels[m[1]] ||= new Set()).add('main-side');
}
for (const [name, sides] of Object.entries(channels)) {
  if (sides.size < 2) { found++; console.log(`IPC channel "${name}" only appears on one side (${[...sides][0]})`); }
}

console.log(found ? `\n${found} possible leftovers` : 'nothing unused found');

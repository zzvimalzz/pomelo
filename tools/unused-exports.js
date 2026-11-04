// SPDX-License-Identifier: AGPL-3.0-or-later
// Dev tool: exported names (and settings/IPC channels) that nothing else in the project uses.   node tools/unused-exports.js [root]
// A name is used when a file that requires the module destructures it or reads it off the object it got from require().
// A word that merely appears somewhere else (JSON.parse) does not count.
const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(d, e.name);
  if (e.isDirectory()) return ['node_modules', 'vendor', 'dist', '.git', 'shots'].includes(e.name) ? [] : walk(p);
  return /\.(js|mjs|html)$/.test(e.name) ? [p] : [];
});
const files = walk(root);
const text = Object.fromEntries(files.map((f) => [f, fs.readFileSync(f, 'utf8')]));
let found = 0;

// Top-level keys of the object literal that opens at src[start] (commas inside nested brackets do not count)
function objectKeys(src, start) {
  const names = [];
  let depth = 0, token = '';
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if ('{(['.includes(c)) { depth++; if (depth > 1) token += c; continue; }
    if ('})]'.includes(c)) { depth--; if (depth === 0) break; token += c; continue; }
    if (c === ',' && depth === 1) { names.push(token); token = ''; continue; }
    token += c;
  }
  names.push(token);
  return names.map((t) => t.trim().replace(/^(async\s+|get\s+|set\s+|\*\s*)+/, '').split(/[:(\s]/)[0]).filter(Boolean);
}

function exportedNames(src) {
  const start = src.indexOf('module.exports = {');
  if (start < 0) return { names: [], factories: [] };
  const names = objectKeys(src, start + 'module.exports = '.length);
  // The object a `createX()` factory returns is an API too: its keys are checked as well.
  const factories = names.filter((n) => /^create[A-Z]/.test(n)).map((n) => {
    const ret = src.indexOf('\n  return {', src.indexOf(`function ${n}(`));
    return ret < 0 ? [] : objectKeys(src, src.indexOf('{', ret));
  });
  return { names, factories: factories.flat() };
}

function resolve(from, spec) {
  const base = path.resolve(path.dirname(from), spec);
  return [base, `${base}.js`, path.join(base, 'index.js')].find((p) => files.includes(p));
}

const keysOf = (list) => list.split(',').map((k) => k.trim().replace(/^\.\.\./, '').split(/[:=\s]/)[0]).filter(Boolean);

// used[module] = names that some file reads from it; importers[module] = the files that require it
const used = {};
const importers = {};
const mark = (key, names, file) => { if (key) { names.forEach((n) => (used[key] ||= new Set()).add(n)); (importers[key] ||= new Set()).add(file); } };
for (const [file, src] of Object.entries(text)) {
  const spec = (s) => resolve(file, s);
  for (const m of src.matchAll(/\{([^}]*)\}\s*=\s*require\(\s*'(\.[^']*)'\s*\)/g)) mark(spec(m[2]), keysOf(m[1]), file);
  for (const m of src.matchAll(/require\(\s*'(\.[^']*)'\s*\)\??\.(\w+)/g)) mark(spec(m[1]), [m[2]], file);
  for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*'(\.[^']*)'\s*\)/g)) {
    const target = spec(m[2]);
    for (const u of src.matchAll(new RegExp(`\\b${m[1]}\\??\\.(\\w+)`, 'g'))) mark(target, [u[1]], file);
    for (const u of src.matchAll(new RegExp(`\\{([^}]*)\\}\\s*=\\s*${m[1]}\\b`, 'g'))) mark(target, keysOf(u[1]), file);
    mark(target, [], file);
  }
}

// A file that is only `module.exports = require('x')` passes on whatever its importers use to x.
for (const [file, src] of Object.entries(text)) {
  const m = /^module\.exports = require\('(\.[^']+)'\);?\s*$/m.exec(src);
  const target = m && resolve(file, m[1]);
  if (target) mark(target, [...(used[file] || [])], file);
  if (target) for (const f of importers[file] || []) (importers[target] ||= new Set()).add(f);
}

for (const file of files.filter((f) => ['main', 'shared', 'features'].some((d) => f.includes(`${path.sep}src${path.sep}${d}${path.sep}`)))) {
  const { names, factories } = exportedNames(text[file]);
  const isEngine = file.includes(`${path.sep}engines${path.sep}`);
  for (const name of [...names, ...factories]) {
    if (isEngine && ['name', 'supports', 'run', 'detect', 'reads', 'writes'].includes(name)) continue;    // the engine interface: convert/ calls it on whichever engine it picked
    const isMember = factories.includes(name) && !names.includes(name);
    // A factory's result is passed around under other names, so any `.name` read in a file that requires the module counts.
    if (isMember ? [...(importers[file] || [])].some((f) => new RegExp(`\\.${name}\\b`).test(text[f])) : used[file]?.has(name)) continue;
    found++;
    const usedInside = (text[file].match(new RegExp(`\\b${name}\\b`, 'g')) || []).length > 1;
    console.log(`${path.relative(root, file)}: "${name}" is exported but never used elsewhere${usedInside ? ' (used inside the file)' : ' and not used inside either'}`);
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

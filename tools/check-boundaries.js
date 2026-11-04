// SPDX-License-Identifier: AGPL-3.0-or-later
// Dev tool: who may import whom (the layers and dependency rules in the refactor plan, section 3.3).   node tools/check-boundaries.js [root]
// Report only until the layout exists: it lists findings and exits 0. F1 makes it fail and adds it to `npm run check`.
const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const src = path.join(root, 'src');

const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(d, e.name);
  return e.isDirectory() ? walk(p) : /\.js$/.test(e.name) ? [p] : [];
}) : []);
const files = walk(src);
const rel = (f) => path.relative(src, f).split(path.sep).join('/');

// Today's code: only these may import Electron at the top (section 2.3 lists log, settings and updater as leaks).
const LEGACY_ELECTRON_FILES = ['main/main.js', 'main/overlay.js', 'main/toast.js', 'main/settingsWindow.js'];
// Adapters in the target layout: the rest of features/ and shared/core|node is logic and never imports Electron.
const isAdapter = (r) => /\.(window|ipc)\.js$/.test(r) || /\/ui\//.test(r) || r === 'features/conversion/lib/print-pdf.js' || r === 'features/conversion/engines/builtin/images.js';

// Every require('x'), with whether it sits at the top of the file (starts in column 0) or inside a function.
function importsOf(file) {
  const text = fs.readFileSync(file, 'utf8');
  return [...text.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((m) => {
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    const spec = m[1];
    let target = null;
    if (spec.startsWith('#shared/')) target = path.join(src, 'shared', spec.slice(8));
    else if (spec.startsWith('.')) target = path.resolve(path.dirname(file), spec);
    if (target) target = [target, `${target}.js`, path.join(target, 'index.js')].find((p) => files.includes(p)) || target;
    return { spec, target: target && rel(target), top: !/^\s/.test(text.slice(lineStart, m.index)) };
  });
}

function findings(file) {
  const r = rel(file);
  const p = r.split('/');
  const out = [];
  const bad = (rule, msg) => out.push(`${r}: ${rule}: ${msg}`);
  const imports = importsOf(file);

  for (const { spec, target, top } of imports) {
    const t = target ? target.split('/') : [];
    if (spec === 'electron') {
      if (p[0] === 'features' || (p[0] === 'shared' && p[1] !== 'electron')) {
        if (!isAdapter(r)) bad('logic', 'a logic file must not require electron');
        else if (p[1] === 'conversion' && top) bad('electron-lazy', 'in conversion, electron may only be required inside a function');
      }
      if (p[0] === 'main' && top && !LEGACY_ELECTRON_FILES.includes(r)) bad('logic', 'a logic file must not require electron');
      continue;
    }
    if (!target) continue;
    if (p[0] === 'shared') {
      if (t[0] === 'features' || t[0] === 'app') bad('shared', `shared code must not import ${target}`);
      if (p[1] === 'core' && t[0] === 'shared' && t[1] !== 'core') bad('shared', `shared/core imports nothing outside itself (${target})`);
      if (p[1] === 'node' && t[0] === 'shared' && t[1] === 'electron') bad('shared', `shared/node must not import shared/electron (${target})`);
    }
    if (p[0] === 'features' && t[0] === 'features' && t[1] !== p[1]) bad('features', `features do not import each other; go through app/ (${target})`);
    if (p[0] === 'features' && t[0] === 'app') bad('features', `a feature must not import app/ (${target})`);
    if (p[0] === 'app' && t[0] === 'features' && !(t.length === 3 && t[2] === 'index.js')) bad('app', `app/ imports a feature only through its index.js (${target})`);
    if (p[0] === 'features' && p[1] === 'conversion' && t[0] === 'features' && t[1] === 'conversion') {
      const [section, engine] = p.slice(2);
      const [tsection, tengine] = t.slice(2);
      if (section === 'engines' && engine !== 'registry.js') {
        if (!['engine-kit', 'lib', 'catalog'].includes(tsection) && !(tsection === 'engines' && tengine === engine)) bad('conversion', `an engine may import only engine-kit, lib, catalog and shared (${target})`);
      }
      if (section === 'routing' && !['routing', 'engine-kit', 'catalog'].includes(tsection) && !(tsection === 'engines' && tengine === 'registry.js')) bad('conversion', `routing imports engines/registry, catalog and engine-kit (${target})`);
      if (section === 'lib' && ['engines', 'routing'].includes(tsection)) bad('conversion', `lib never imports engines or routing (${target})`);
    }
  }

  // Preloads run in a sandbox where only electron can be required.
  if (p[0] === 'preload' || (p[0] === 'features' && p[p.length - 2] === 'ui' && p[p.length - 1] === 'preload.js')) {
    for (const { spec } of imports) if (spec !== 'electron') bad('preload', `a sandboxed preload may require only electron (${spec})`);
  }
  return out;
}

const all = files.flatMap(findings);
all.forEach((l) => console.log(l));
console.log(all.length ? `\n${all.length} boundary findings (report only)` : 'no boundary findings');

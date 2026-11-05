// SPDX-License-Identifier: AGPL-3.0-or-later
// The command-line contract of the Python helpers, which the Node side depends on (src/features/conversion/engine-kit/python.js):
// arguments, "OK" on stdout, one reason line on stderr, and the exit codes 1 (failed), 2 (a component is not installed) and 3 (the
// PDF has no text). Each helper runs on a missing file, a damaged PDF, a PDF with no text and a PDF with text.
// Needs the Python PDF engine (skipped without it).   node test/integration/python/cli-contract.test.js
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { findPython, runHelper } = require('../../../src/features/conversion/engine-kit/python');
const { scriptPath } = require('../../../src/shared/node/paths');
const { expect } = require('../../support/expect');
const finish = require('../../support/finish');
const tmp = require('../../support/tmp');

const py = findPython('pymupdf, docx');
if (!py) { console.log('  PDF engine not installed: skipped'); finish(0); return; }

const run = (python, script, args) => {
  const r = spawnSync(python, ['-W', 'ignore', scriptPath(script), ...args], { encoding: 'utf8', timeout: 120000, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  return { code: r.status, out: r.stdout || '', err: (r.stderr || '').trim() };
};
const lastLine = (r) => r.err.split(/\r?\n/).filter(Boolean).pop() || '';

const dir = tmp.dir('pycli');
const make = (name, code) => {
  const file = path.join(dir, name);
  const r = spawnSync(py, ['-W', 'ignore', '-c', `import pymupdf, sys\nd = pymupdf.open()\n${code}\nd.save(sys.argv[1])`, file], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`could not make ${name}: ${r.stderr}`);
  return file;
};
const blank = make('blank.pdf', 'd.new_page()');
const withText = make('text.pdf', 'p = d.new_page()\np.insert_text((72, 100), "Hello Pomelo, this page has real text on it.", fontsize=14)');
const broken = path.join(dir, 'broken.pdf');
fs.writeFileSync(broken, 'this is not a pdf at all');
const missing = path.join(dir, 'missing.pdf');
const out = (name) => path.join(dir, name);

const DAMAGED = 'This file is damaged or is not a PDF';
const cases = [
  // helper, output arguments, what a PDF with no text should do
  { script: 'pdf_to_docx.py', args: (src, n) => [src, out(`${n}.docx`)], made: (n) => out(`${n}.docx`), empty: null },
  { script: 'pdf_to_text.py', args: (src, n) => [src, out(`${n}.txt`), 'txt'], made: (n) => out(`${n}.txt`), empty: { code: 3, message: 'This PDF has no text to convert' } },
  { script: 'pdf_to_tables.py', args: (src, n) => [src, out(`${n}.json`)], made: (n) => out(`${n}.json`), empty: { code: 3, message: 'This PDF has no text to put in a spreadsheet' } },
  { script: 'pdf_to_layout.py', args: (src, n) => [src, (fs.mkdirSync(out(n), { recursive: true }), out(n))], made: (n) => out(`${n}/layout.json`), empty: null },
];

for (const c of cases) {
  console.log(c.script);
  let r = run(py, c.script, c.args(missing, `${c.script}-missing`));
  expect('a missing file fails with exit 1 and a reason', r.code === 1 && lastLine(r) === DAMAGED, `${r.code} ${lastLine(r)}`);
  r = run(py, c.script, c.args(broken, `${c.script}-broken`));
  expect('a damaged PDF fails with exit 1 and says so', r.code === 1 && lastLine(r) === DAMAGED && !r.out.includes('OK'), `${r.code} ${lastLine(r)}`);
  r = run(py, c.script, c.args(withText, `${c.script}-text`));
  expect('a PDF with text succeeds: exit 0, OK, the output exists, progress lines', r.code === 0 && /^OK$/m.test(r.out) && fs.existsSync(c.made(`${c.script}-text`)) && /POMELO_PROGRESS [01]\.\d{3}/.test(r.out), `${r.code} ${lastLine(r)}`);
  if (c.empty) {
    r = run(py, c.script, c.args(blank, `${c.script}-blank`));
    expect(`a PDF with no text exits ${c.empty.code} with "${c.empty.message}"`, r.code === c.empty.code && lastLine(r) === c.empty.message && !r.out.includes('OK'), `${r.code} ${lastLine(r)}`);
  }
}

console.log('which text becomes editable text on a PowerPoint slide');
{
  // curly quotes and dashes are ordinary text; Hebrew and Arabic stay in the picture, where they are drawn right
  const check = spawnSync(py, ['-W', 'ignore', '-c', [
    'import sys', `sys.path.insert(0, r"${path.dirname(scriptPath('pdf_spans.py'))}")`, 'from pdf_spans import RTL',
    'print(bool(RTL.search("\u201c")), bool(RTL.search("\u2014")), bool(RTL.search("\u4e2d")), bool(RTL.search("\u05d0")), bool(RTL.search("\u0627")), bool(RTL.search("\ufe8d")))',
  ].join('\n')], { encoding: 'utf8', windowsHide: true });
  expect('a curly quote, a dash and CJK are not right-to-left; Hebrew, Arabic and Arabic presentation forms are', check.stdout.trim() === 'False False False True True True', check.stdout.trim() + check.stderr.trim());
  // Arial, as the OCR code draws with: the built-in Helvetica has no curly quotes
  const arial = path.join(process.env.WINDIR || 'C:/Windows', 'Fonts', 'arial.ttf').replace(/\\/g, '/');
  const quoted = make('quoted.pdf', `p = d.new_page()\np.insert_font(fontname="Arial", fontfile="${arial}")\np.insert_text((72, 100), "\\u201cQuoted text\\u201d \\u2014 and more", fontsize=14, fontname="Arial")`);
  const outDir = out('quoted-layout');
  fs.mkdirSync(outDir, { recursive: true });
  const r = run(py, 'pdf_to_layout.py', [quoted, outDir]);
  const layout = r.code === 0 ? JSON.parse(fs.readFileSync(path.join(outDir, 'layout.json'), 'utf8')) : null;
  const texts = layout ? layout.pages.flatMap((p) => p.texts.flatMap((t) => t.runs.map((x) => x.text))).join('').replace(/\u00a0/g, ' ') : ''; // an embedded Arial maps its space to U+00A0
  expect('text with curly quotes and a dash is written as editable text, not left in the picture', texts.includes('\u201cQuoted text\u201d') && texts.includes('\u2014'), texts || `${r.code} ${lastLine(r)}`);
}

console.log('HEIC');
const heicPython = findPython('pillow_heif, PIL');
if (!heicPython) console.log('  pillow-heif not installed: skipped');
else {
  const png = path.join(dir, 'pic.png');
  spawnSync(heicPython, ['-c', `from PIL import Image\nImage.new("RGB", (32, 24), (255, 140, 30)).save(r"${png}")`], { windowsHide: true });
  let r = run(heicPython, 'image_to_heic.py', [png, out('pic.heic')]);
  expect('an image becomes a HEIC file: exit 0 and OK', r.code === 0 && /^OK$/m.test(r.out) && fs.existsSync(out('pic.heic')), `${r.code} ${lastLine(r)}`);
  r = run(heicPython, 'image_to_heic.py', [path.join(dir, 'nope.png'), out('nope.heic')]);
  expect('a missing image fails with exit 1 and "HEIC encode failed"', r.code === 1 && /^HEIC encode failed/.test(lastLine(r)), `${r.code} ${lastLine(r)}`);
}

console.log('a Python without the packages');
{
  const bare = ['python', 'py'].find((p) => spawnSync(p, ['-c', 'import pymupdf'], { windowsHide: true }).status !== 0 && spawnSync(p, ['-c', 'pass'], { windowsHide: true }).status === 0);
  if (!bare) console.log('  every Python on this PC has PyMuPDF: skipped');
  else {
    const r = run(bare, 'pdf_to_text.py', [withText, out('bare.txt'), 'txt']);
    expect('exit 2 and "PyMuPDF is not available"', r.code === 2 && /^PyMuPDF is not available/.test(lastLine(r)), `${r.code} ${lastLine(r)}`);
    const d = run(bare, 'pdf_to_docx.py', [withText, out('bare.docx')]);
    expect('the Word helper says "The PDF engine is not available"', d.code === 2 && /^The PDF engine is not available/.test(lastLine(d)), `${d.code} ${lastLine(d)}`);
  }
}

// runHelper clears PYTHONSAFEPATH, which would keep a script's own folder off sys.path (Python 3.11 and later)
console.log('the scripts find their neighbours however Python is configured');
process.env.PYTHONSAFEPATH = '1';
const target = out('safe-path.txt');
runHelper(py, 'pdf_to_text.py', [withText, target, 'txt'], { src: withText })
  .then(() => expect('with PYTHONSAFEPATH set, the helper still runs', fs.existsSync(target)), (e) => expect('with PYTHONSAFEPATH set, the helper still runs', false, e.message))
  .finally(() => { delete process.env.PYTHONSAFEPATH; finish(); });

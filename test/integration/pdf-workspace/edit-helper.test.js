// SPDX-License-Identifier: AGPL-3.0-or-later
// The PDF editing helpers with the real PDF engine: a list of changes applied to a drawn PDF, how it is saved, what stays untouched,
// what a failure leaves behind, and that a password only ever travels on standard input.
// Needs the PDF engine (skipped without it).   node test/integration/pdf-workspace/edit-helper.test.js
const crypto = require('crypto');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const spawned = [];
const realExecFile = childProcess.execFile;
childProcess.execFile = (cmd, args, options, callback) => { spawned.push({ args, env: options?.env }); return realExecFile(cmd, args, options, callback); };

const conversion = require('../../../src/features/conversion');
const { scriptPath } = require('../../../src/shared/node/paths');
const { expect } = require('../../support/expect');
const finish = require('../../support/finish');
const tmp = require('../../support/tmp');

const py = conversion.detectEngines().pdf;
if (!py) { console.log('  PDF engine not installed: skipped'); finish(0); return; }

const dir = tmp.dir('edit-helper');
const at = (name) => path.join(dir, name);
const PASSWORD = `Pw-${crypto.randomBytes(8).toString('hex')}`;

const python = (code, ...args) => {
  const r = childProcess.spawnSync(py, ['-W', 'ignore', '-c', code, ...args], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};

const draw = at('three.pdf');
python('import pymupdf, sys\nd = pymupdf.open()\nfor i in range(3):\n    d.new_page().insert_text((72, 100), "PAGEMARK%d unique words for page %d" % (i + 1, i + 1))\nd.save(sys.argv[1], expand=255)', draw);
const locked = at('locked.pdf');
python('import pymupdf, sys\nd = pymupdf.open(sys.argv[1])\nd.save(sys.argv[2], encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw=sys.argv[3], owner_pw="owner-" + sys.argv[3])', draw, locked, PASSWORD);

// What a file holds, as JSON: the number of pages, each page's rotation and text, and whether the file is protected.
const look = (file, password = '') => JSON.parse(python([
  'import json, sys, pymupdf', 'd = pymupdf.open(sys.argv[1])', 'locked = d.needs_pass', 'if locked and not d.authenticate(sys.argv[2]): print(json.dumps({"locked": True})); sys.exit()',
  'print(json.dumps({"locked": locked, "encryption": d.metadata["encryption"], "repaired": d.is_repaired, "rotations": [p.rotation for p in d], "texts": [p.get_text().strip() for p in d], "contents": [p.read_contents().hex() for p in d]}))',
].join('\n'), file, password));

const list = (...ops) => { const file = at(`ops-${crypto.randomBytes(4).toString('hex')}.json`); fs.writeFileSync(file, JSON.stringify({ version: 1, ops })); return file; };
const rotate = (pages, by = 90) => ({ op: 'pages.rotate', pages, by });
const remove = (pages) => ({ op: 'pages.delete', pages });
const tool = (src, out, file, secrets, options) => conversion.runPdfTool('pdf_edit.py', [src, out, file], { src, secrets, ...options });
const reason = (promise) => promise.then(() => '', (e) => e.message);
const direct = (args, input) => childProcess.spawnSync(py, ['-W', 'ignore', scriptPath('pdf_edit.py'), ...args], { encoding: 'utf8', windowsHide: true, input, stdio: input === undefined ? ['ignore', 'pipe', 'pipe'] : 'pipe' });
const original = look(draw);
const bytes = fs.readFileSync(draw);

(async () => {
  console.log('a change that edits in place');
  const rotated = at('rotated.pdf');
  const said = await tool(draw, rotated, list(rotate([2])));
  const after = look(rotated);
  expect('page 2 turns by 90 and the others do not', JSON.stringify(after.rotations) === '[0,90,0]', JSON.stringify(after.rotations));
  expect('the content of every page is the same bytes', after.contents.every((c, i) => c === original.contents[i]));
  expect('it is appended to the file: the original is a prefix of the result', fs.readFileSync(rotated).subarray(0, bytes.length).equals(bytes));
  expect('the helper says it appended, then OK, with progress lines', /^\{"saved": "incremental"\}$/m.test(said) && /^OK$/m.test(said) && /POMELO_PROGRESS 0\.990/.test(said), said);
  expect('the file reopens without repair', after.repaired === false);
  expect('the file it started from is untouched', fs.readFileSync(draw).equals(bytes));
  const twice = at('twice.pdf');
  await tool(draw, twice, list(rotate([1], 90), rotate([1], 270), rotate([3], 180)));
  expect('changes are made in order, and a page can turn more than once', JSON.stringify(look(twice).rotations) === '[0,0,180]', JSON.stringify(look(twice).rotations));

  console.log('a change that rewrites the file');
  const shorter = at('shorter.pdf');
  const full = await tool(draw, shorter, list(remove([2])));
  const gone = look(shorter);
  expect('page 2 is gone and the others are in order', gone.texts.length === 2 && /PAGEMARK1/.test(gone.texts[0]) && /PAGEMARK3/.test(gone.texts[1]), JSON.stringify(gone.texts));
  expect('the helper says it wrote the whole file', /^\{"saved": "full"\}$/m.test(full), full);
  const marker = Buffer.from('PAGEMARK2').toString('hex');
  expect('the text of the deleted page is not in the file any more', bytes.includes(marker) && !fs.readFileSync(shorter).includes(marker));
  expect('the pages that stay keep their content bytes', gone.contents[0] === original.contents[0] && gone.contents[1] === original.contents[2]);
  const mixed = at('mixed.pdf');
  await tool(draw, mixed, list(remove([1]), rotate([1], 270)));
  expect('after a deletion, page numbers are those of the document as it is then', JSON.stringify(look(mixed).rotations) === '[270,0]' && /PAGEMARK2/.test(look(mixed).texts[0]), JSON.stringify(look(mixed).rotations));

  console.log('a file that has to be repaired is saved whole');
  const broken = at('broken.pdf');
  fs.writeFileSync(broken, bytes.subarray(0, bytes.length - 40));
  const fixed = at('fixed.pdf');
  const repaired = await tool(broken, fixed, list(rotate([1])));
  expect('the change is made in a whole new file, not appended to a damaged one', /^\{"saved": "full"\}$/m.test(repaired) && JSON.stringify(look(fixed).rotations) === '[90,0,0]' && look(fixed).repaired === false);

  console.log('what is refused');
  const refusals = {
    'a page that is not there': [list(rotate([4])), 'this PDF has no page 4'],
    'every page deleted': [list(remove([1, 2, 3])), 'a PDF needs at least one page'],
    'a turn by 45 degrees': [list(rotate([1], 45)), 'a page turns by 90, 180 or 270 degrees'],
    'the same page twice': [list(remove([1, 1])), 'pages must be a list of different page numbers'],
    'an unknown change': [list({ op: 'pages.shred', pages: [1] }), 'unknown change "pages.shred"'],
    'a key the change does not take': [list({ op: 'pages.delete', pages: [1], password: 'x' }), 'pages.delete takes pages'],
    'a bad third change after two good ones': [list(rotate([1]), rotate([2]), rotate([9])), 'this PDF has no page 9'],
  };
  for (const [what, [file, why]] of Object.entries(refusals)) {
    const out = at(`refused-${crypto.randomBytes(3).toString('hex')}.pdf`);
    const message = await reason(tool(draw, out, file));
    expect(`${what} is refused with a reason and nothing is written`, message.includes(why) && !fs.existsSync(out), message);
  }
  const notPdf = at('not.pdf');
  fs.writeFileSync(notPdf, 'this is not a pdf');
  expect('a file that is not a PDF says so', await reason(tool(notPdf, at('not-out.pdf'), list(rotate([1])))) === 'This file is damaged or is not a PDF' && !fs.existsSync(at('not-out.pdf')));
  fs.writeFileSync(at('bad.json'), '{"version": 2, "ops": []}');
  expect('a list with another version is refused', (await reason(tool(draw, at('bad-out.pdf'), at('bad.json')))).includes('not valid') && !fs.existsSync(at('bad-out.pdf')));

  console.log('standard input');
  const byHand = at('by-hand.pdf');
  const run = direct([draw, byHand, list(rotate([3]))]);
  expect('run by hand, with nothing on standard input, it works on a file with no password', run.status === 0 && /^OK$/m.test(run.stdout) && JSON.stringify(look(byHand).rotations) === '[0,0,90]', `${run.status} ${run.stderr}`);
  for (const [what, input] of [['text that is not JSON', 'not json\n'], ['a key that is not a secret', '{"token": "x"}\n'], ['a secret that is not text', '{"password": 5}\n'], ['a line over 64 KiB', `${JSON.stringify({ password: 'x'.repeat(70000) })}\n`]]) {
    const out = at(`stdin-${crypto.randomBytes(3).toString('hex')}.pdf`);
    const r = direct([draw, out, list(rotate([1]))], input);
    expect(`${what} is refused with exit 1 and nothing is written`, r.status === 1 && !fs.existsSync(out) && r.stderr.trim().split(/\r?\n/).length === 1, `${r.status} ${r.stderr}`);
  }

  console.log('a protected file');
  const protectedBefore = look(locked, PASSWORD);
  const inPlace = at('locked-rotated.pdf');
  const wholly = at('locked-shorter.pdf');
  spawned.length = 0;
  await tool(locked, inPlace, list(rotate([2])), { password: PASSWORD });
  await tool(locked, wholly, list(remove([2])), { password: PASSWORD });
  for (const [what, file] of [['appended', inPlace], ['rewritten', wholly]]) {
    const r = look(file);
    expect(`a protected file with a change ${what} still needs its password, with the same algorithm`, r.locked === true && look(file, PASSWORD).encryption === protectedBefore.encryption, JSON.stringify(r));
  }
  expect('the changes are in them', JSON.stringify(look(inPlace, PASSWORD).rotations) === '[0,90,0]' && look(wholly, PASSWORD).texts.length === 2);
  expect('the password is in no argument and no environment of the helper', spawned.length === 2 && spawned.every((s) => !JSON.stringify(s.args).includes(PASSWORD) && !JSON.stringify(s.env || {}).includes(PASSWORD)));
  const withoutPassword = at('locked-none.pdf');
  expect('without the password the helper stops and writes nothing', (await reason(tool(locked, withoutPassword, list(rotate([1]))))).includes('password-protected') && !fs.existsSync(withoutPassword));
  expect('and with a wrong one', (await reason(tool(locked, withoutPassword, list(rotate([1])), { password: 'wrong' }))).includes('password-protected') && !fs.existsSync(withoutPassword));
  const leak = await reason(tool(locked, at('leak.pdf'), list({ op: PASSWORD }), { password: PASSWORD }));
  expect('a reason that would repeat the password has it replaced', leak.includes('***') && !leak.includes(PASSWORD), leak);
  expect('the list holds no secret', !fs.readFileSync(list(rotate([1]))).includes(PASSWORD));

  console.log('facts about a file');
  const info = (src, out, secrets) => conversion.runPdfTool('pdf_info.py', [src, out, 'properties'], { src, secrets }).then(() => JSON.parse(fs.readFileSync(out, 'utf8')));
  const facts = await info(draw, at('facts.json'));
  expect('properties lists the pages, the version, the information, tagging and permissions', facts.pageCount === 3 && facts.pages.length === 3 && facts.pages[0].width === 595 && facts.pages[0].height === 842 && facts.pages[0].rotation === 0 && /^PDF 1\./.test(facts.version) && facts.tagged === false && facts.encryption === null && Object.values(facts.permissions).every(Boolean) && facts.information.title === '', JSON.stringify(facts));
  const factsOfRotated = await info(rotated, at('facts-rotated.json'));
  expect('a turned page says so', factsOfRotated.pages[1].rotation === 90);
  const factsOfLocked = await info(locked, at('facts-locked.json'), { password: PASSWORD });
  expect('a protected file opens with the password and says how it is protected', factsOfLocked.pageCount === 3 && /AES/.test(factsOfLocked.encryption), JSON.stringify(factsOfLocked));
  expect('without the password it says why not, and writes nothing', (await reason(info(locked, at('facts-none.json')))).includes('password-protected') && !fs.existsSync(at('facts-none.json')));
  expect('an unknown question is refused', (await reason(conversion.runPdfTool('pdf_info.py', [draw, at('what.json'), 'everything'], { src: draw }))).includes('unknown request') && !fs.existsSync(at('what.json')));

  console.log('stopping');
  const stopped = at('stopped.pdf');
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  const why = await tool(draw, stopped, list(rotate([1])), undefined, { signal: controller.signal }).then(() => 'finished', (e) => e.name);
  expect('stopping the helper kills it and leaves no file', why === 'CancelledError' && !fs.existsSync(stopped), why);

  console.log('no engine');
  conversion.detectEngines([]);
  const none = await tool(draw, at('none.pdf'), list(rotate([1]))).then(() => null, (e) => e);
  expect('without the engine the tool says so, and starts nothing', none?.message === 'The PDF engine is not installed' && none.code === 'NO_ENGINE' && !fs.existsSync(at('none.pdf')));
  finish();
})().catch((e) => { console.error(e); finish(2); });

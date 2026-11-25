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
const { run: runProcess } = require('../../../src/features/conversion/engine-kit/run');
const { withContext } = require('../../../src/features/conversion/engine-kit/context');
const { sleep } = require('../../../src/shared/node/fs');
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

const SIGN = String.raw`import json, sys, pymupdf

def sign(path, name, signer, extra_sig="", extra_field="", certify=False, empty=False):
    doc = pymupdf.open(path)
    page = doc[0]
    sig, field = doc.get_new_xref(), doc.get_new_xref()
    value = ""
    if not empty:
        doc.update_object(sig, "<</Type/Sig/Filter/Adobe.PPKLite/SubFilter/adbe.pkcs7.detached/ByteRange[0 1000000000 1000000001 1000000002]/Contents<%s>/M(D:20261121053000Z)/Name(%s)%s>>" % ("0" * 400, signer, extra_sig))
        value = "/V %d 0 R" % sig
    doc.update_object(field, "<</Type/Annot/Subtype/Widget/FT/Sig/T(%s)/F 132/Rect[50 50 200 100]%s/P %d 0 R%s>>" % (name, value, page.xref, extra_field))
    annots = doc.xref_get_key(page.xref, "Annots")
    doc.xref_set_key(page.xref, "Annots", (annots[1][:-1] + " %d 0 R]" % field) if annots[0] == "array" else "[%d 0 R]" % field)
    cat = doc.pdf_catalog()
    fields = doc.xref_get_key(cat, "AcroForm/Fields")
    doc.xref_set_key(cat, "AcroForm/Fields", (fields[1][:-1] + " %d 0 R]" % field) if fields[0] == "array" else "[%d 0 R]" % field)
    doc.xref_set_key(cat, "AcroForm/SigFlags", "3")
    if certify:
        doc.xref_set_key(cat, "Perms", "<</DocMDP %d 0 R>>" % sig)
    doc.saveIncr()
    doc.close()
    if empty:
        return
    data = bytearray(open(path, "rb").read())
    start = data.rindex(b"/Contents<") + len(b"/Contents")
    end = data.index(b">", start) + 1
    old = b"[0 1000000000 1000000001 1000000002]"
    at = data.rindex(old)
    data[at:at + len(old)] = b"[0 %010d %010d %010d]" % (start, end, len(data) - end)
    open(path, "wb").write(bytes(data))
`;
const list = (...ops) => { const file = at(`ops-${crypto.randomBytes(4).toString('hex')}.json`); fs.writeFileSync(file, JSON.stringify({ version: 1, ops })); return file; };
const rotate = (pages, by = 90) => ({ op: 'pages.rotate', pages, by });
const remove = (pages) => ({ op: 'pages.delete', pages });
const move = (pages, before) => ({ op: 'pages.move', pages, before });
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
  expect('it says how many pages the file it started from had', /^\{"pages": 3\}$/m.test(said), said);
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
  expect('the helper says it wrote the whole file, and that the file it started from had 3 pages', /^\{"saved": "full"\}$/m.test(full) && /^\{"pages": 3\}$/m.test(full), full);
  const marker = Buffer.from('PAGEMARK2').toString('hex');
  expect('the text of the deleted page is not in the file any more', bytes.includes(marker) && !fs.readFileSync(shorter).includes(marker));
  expect('the pages that stay keep their content bytes', gone.contents[0] === original.contents[0] && gone.contents[1] === original.contents[2]);
  const mixed = at('mixed.pdf');
  await tool(draw, mixed, list(remove([1]), rotate([1], 270)));
  expect('after a deletion, page numbers are those of the document as it is then', JSON.stringify(look(mixed).rotations) === '[270,0]' && /PAGEMARK2/.test(look(mixed).texts[0]), JSON.stringify(look(mixed).rotations));

  console.log('pages that move');
  const six = at('six.pdf');
  python('import pymupdf, sys\nd = pymupdf.open()\nfor i in range(6):\n    d.new_page().insert_text((72, 100), "PAGEMARK%d" % (i + 1))\nd[0].insert_link({"kind": pymupdf.LINK_GOTO, "from": pymupdf.Rect(10, 10, 100, 30), "page": 4, "to": pymupdf.Point(0, 0)})\nd.set_toc([[1, "to five", 5]])\nd.save(sys.argv[1], expand=255)', six);
  const sixBytes = fs.readFileSync(six);
  const order = (file) => look(file).texts.map((t) => t.replace('PAGEMARK', '')).join('');
  const arranged = async (name, ...ops) => { const out = at(`${name}.pdf`); const said = await tool(six, out, list(...ops)); return { out, said }; };
  const cases = {
    'one page forward': [[move([1], 4)], '231456'], 'one page back': [[move([5], 2)], '152346'], 'a page to the end': [[move([2], 7)], '134562'], 'a page to the start': [[move([6], 1)], '612345'],
    'a block, kept in its order, whatever order it was named in': [[move([5, 2, 3], 1)], '235146'], 'a block to the end': [[move([1, 2], 7)], '345612'],
    'pages that are apart, brought together': [[move([1, 5], 4)], '231546'], 'a place inside the block itself': [[move([2, 3], 3)], '123456'], 'the place just after the block': [[move([2, 3], 4)], '123456'],
    'two moves in turn, the second counted in the document the first left': [[move([1], 7), move([1], 7)], '345612'],
  };
  for (const [what, [ops, wanted]] of Object.entries(cases)) {
    const { out, said } = await arranged(`move-${crypto.randomBytes(3).toString('hex')}`, ...ops);
    expect(`${what}: the pages end up in the order ${wanted}`, order(out) === wanted && /^\{"saved": "incremental"\}$/m.test(said), `${order(out)} ${said}`);
  }
  const { out: moved } = await arranged('moved', move([5], 2));
  const where = JSON.parse(python('import json, sys, pymupdf\nd = pymupdf.open(sys.argv[1])\nprint(json.dumps({"toc": d.get_toc(), "link": [l["page"] for l in d[0].get_links()], "repaired": d.is_repaired}))', moved));
  expect('the file is the original with the change appended, and it opens without repair', fs.readFileSync(moved).subarray(0, sixBytes.length).equals(sixBytes) && where.repaired === false);
  expect('a bookmark and a link still lead to the page they led to, which is now the second', JSON.stringify(where.toc) === '[[1,"to five",2]]' && JSON.stringify(where.link) === '[1]', JSON.stringify(where));
  expect('the content of every page is the same bytes, in the new order', JSON.stringify(look(moved).contents) === JSON.stringify([0, 4, 1, 2, 3, 5].map((i) => look(six).contents[i])));
  for (const [what, op, why] of [['a place before the first page', move([1], 0), 'there is no such place to move pages to'], ['a place past the end', move([1], 8), 'there is no such place to move pages to'], ['a page that is not there', move([7], 1), 'this PDF has no page 7'], ['the same page twice', move([1, 1], 3), 'pages must be a list of different page numbers']]) {
    const out = at(`move-refused-${crypto.randomBytes(3).toString('hex')}.pdf`);
    const message = await reason(tool(six, out, list(op)));
    expect(`${what} is refused with a reason and nothing is written`, message.includes(why) && !fs.existsSync(out), message);
  }
  const lockedMoved = at('locked-moved.pdf');
  await tool(locked, lockedMoved, list(move([3], 1)), { password: PASSWORD });
  expect('a protected file with a page moved still needs its password, and has the page in its new place', look(lockedMoved).locked === true && /PAGEMARK3/.test(look(lockedMoved, PASSWORD).texts[0]) && look(lockedMoved, PASSWORD).encryption === look(locked, PASSWORD).encryption);

  console.log('a file of 3 000 pages');
  const big = at('big.pdf');
  python('import pymupdf, sys\nd = pymupdf.open()\nfor i in range(3000):\n    d.new_page().insert_text((72, 100), "BIG%d" % (i + 1))\nd.save(sys.argv[1], expand=255)', big);
  const thirds = Array.from({ length: 1000 }, (_, i) => 3 * i + 1);
  const timed = async (name, ...ops) => { const out = at(`${name}.pdf`); const began = Date.now(); await tool(big, out, list(...ops)); return { out, took: Date.now() - began }; };
  const ends = (file) => python('import sys, pymupdf\nd = pymupdf.open(sys.argv[1])\nprint(d.page_count, *[d[i].get_text().strip() for i in (0, 1, 2, d.page_count - 1)])', file);
  const turned = await timed('big-turned', rotate(thirds));
  const toEnd = await timed('big-to-end', move(thirds, 3001));
  const deleted = await timed('big-deleted', remove(thirds));
  const toStart = await timed('big-to-start', move([3000], 1));
  expect('1 000 pages turned, moved to the end or deleted, and a page moved to the front, each take under 6 seconds', [turned, toEnd, deleted, toStart].every((r) => r.took < 6000), JSON.stringify([turned.took, toEnd.took, deleted.took, toStart.took]));
  expect('the 1 000 pages moved to the end are the last 1 000, in their order', ends(toEnd.out) === '3000 BIG2 BIG3 BIG5 BIG2998', ends(toEnd.out));
  expect('the deletion leaves 2 000 pages and the move to the front puts the last page first', ends(deleted.out) === '2000 BIG2 BIG3 BIG5 BIG3000' && ends(toStart.out) === '3000 BIG3000 BIG1 BIG2 BIG2999', `${ends(deleted.out)} | ${ends(toStart.out)}`);

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

  console.log('the document information');
  const informed = at('informed.pdf');
  python('import pymupdf, sys\nd = pymupdf.open()\nd.new_page().insert_text((72, 100), "INFOMARK words")\nd.set_metadata({"title": "Old title", "author": "Somebody", "creator": "Word", "producer": "Print to PDF", "creationDate": "D:20260303094200+08\'00\'"})\nd.save(sys.argv[1], expand=255)', informed);
  const meta = (file, password = '') => JSON.parse(python('import json, sys, pymupdf\nd = pymupdf.open(sys.argv[1])\nif d.needs_pass: d.authenticate(sys.argv[2])\nprint(json.dumps(d.metadata))', file, password));
  const information = (title, author, subject, keywords) => ({ op: 'meta.set', title, author, subject, keywords });
  const informedBytes = fs.readFileSync(informed);
  const retitled = at('retitled.pdf');
  const retitledSaid = await tool(informed, retitled, list(information('Café 日本', '', 'Results', 'a, b')));
  const kept = meta(retitled);
  expect('the four texts are set, an empty one removes its entry and the other entries stay', kept.title === 'Café 日本' && kept.author === '' && kept.subject === 'Results' && kept.keywords === 'a, b' && kept.creator === 'Word' && kept.producer === 'Print to PDF' && kept.creationDate === "D:20260303094200+08'00'", JSON.stringify(kept));
  expect('it is appended to the file and the pages are untouched', /^\{"saved": "incremental"\}$/m.test(retitledSaid) && fs.readFileSync(retitled).subarray(0, informedBytes.length).equals(informedBytes) && look(retitled).contents[0] === look(informed).contents[0]);
  const longest = at('longest.pdf');
  await tool(informed, longest, list(information('x'.repeat(1000), '', '', '')));
  expect('a title of 1000 characters is kept whole', meta(longest).title.length === 1000);
  for (const [what, op, why] of [['a title over 1000 characters', information('x'.repeat(1001), '', '', ''), 'title is text of at most 1000 characters'], ['an author that is not text', information('', 5, '', ''), 'author is text of at most 1000 characters'], ['a missing keyword text', { op: 'meta.set', title: '', author: '', subject: '' }, 'meta.set takes author, keywords, subject, title'], ['a key it does not take', { ...information('', '', '', ''), producer: 'x' }, 'meta.set takes author, keywords, subject, title']]) {
    const out = at(`meta-${crypto.randomBytes(3).toString('hex')}.pdf`);
    const message = await reason(tool(informed, out, list(op)));
    expect(`${what} is refused with a reason and nothing is written`, message.includes(why) && !fs.existsSync(out), message);
  }
  const retitledLocked = at('locked-retitled.pdf');
  await tool(locked, retitledLocked, list(information('Secret title', '', '', '')), { password: PASSWORD });
  expect('a protected file with new information still needs its password', look(retitledLocked).locked === true && meta(retitledLocked, PASSWORD).title === 'Secret title');

  console.log('more facts about a file');
  const more = await info(informed, at('facts-informed.json'));
  expect('the information comes with its dates as ISO text and the program that made the file', more.information.title === 'Old title' && more.information.author === 'Somebody' && more.information.creator === 'Word' && more.information.producer === 'Print to PDF' && more.information.created === '2026-03-03T09:42:00+08:00' && more.information.modified === null && more.needsPassword === false, JSON.stringify(more.information));
  expect('a file with no form has no signature fields', more.signatures.fields.length === 0 && more.signatures.certification === null && more.signatures.changedAfterSigning === false);
  expect('a standard font is not embedded', JSON.stringify(more.fonts) === '[{"name":"Helvetica","embedded":false}]', JSON.stringify(more.fonts));
  const embedded = at('embedded.pdf');
  python('import pymupdf, sys\nd = pymupdf.open()\npage = d.new_page()\npage.insert_font(fontname="Droid", fontbuffer=pymupdf.Font("cjk").buffer)\npage.insert_text((72, 100), "EMBEDMARK", fontname="Droid")\npage.insert_text((72, 140), "second font")\nd.subset_fonts()\nd.save(sys.argv[1])', embedded);
  const fonts = (await info(embedded, at('facts-embedded.json'))).fonts;
  expect('an embedded font is told from a standard one, and a subset prefix is not part of the name', fonts.length === 2 && fonts.find((f) => f.name === 'Helvetica').embedded === false && fonts.find((f) => f.name !== 'Helvetica').embedded === true && fonts.every((f) => !/^[A-Z]{6}\+/.test(f.name)), JSON.stringify(fonts));
  const many = at('many.pdf');
  python('import pymupdf, sys\nd = pymupdf.open()\nfor i in range(40):\n    d.new_page().insert_text((72, 100), "page %d" % i, fontname="helv" if i % 2 else "tiro")\nd.save(sys.argv[1])', many);
  expect('a font used on many pages is listed once', JSON.stringify((await info(many, at('facts-many.json'))).fonts.map((f) => f.name)) === '["Helvetica","Times-Roman"]');
  expect('a protected file says its password is needed to open it', (await info(locked, at('facts-locked2.json'), { password: PASSWORD })).needsPassword === true);

  console.log('what a file says about its signatures');
  const form = at('form.pdf');
  python('import pymupdf, sys\nd = pymupdf.open()\npage = d.new_page()\npage.insert_text((72, 100), "SIGNMARK")\nw = pymupdf.Widget()\nw.field_type = pymupdf.PDF_WIDGET_TYPE_TEXT\nw.field_name = "name"\nw.rect = pymupdf.Rect(50, 200, 200, 220)\npage.add_widget(w)\nd.save(sys.argv[1])', form);
  const signed = (name, steps) => {
    const out = at(`${name}.pdf`);
    fs.copyFileSync(form, out);
    python(`${SIGN}\n${steps}`, out);
    return out;
  };
  const signatures = async (file) => (await info(file, at(`sig-${crypto.randomBytes(3).toString('hex')}.json`))).signatures;
  const certified = (level) => `/Reference[<</Type/SigRef/TransformMethod/DocMDP/TransformParams<</Type/TransformParams${level ? `/P ${level}` : ''}/V/1.2>>>>]`;
  const approval = signed('approval', 'sign(sys.argv[1], "Sig1", "Test Signer")');
  const one = await signatures(approval);
  expect('a signed field says who the file claims signed it, when, and with what filter', one.fields.length === 1 && one.fields[0].name === 'Sig1' && one.fields[0].signed === true && one.fields[0].signer === 'Test Signer' && one.fields[0].time === '2026-11-21T05:30:00+00:00' && one.fields[0].filter === 'adbe.pkcs7.detached', JSON.stringify(one));
  expect('the signed part ends where the file ended, and nothing follows it', one.fields[0].intact === true && one.changedAfterSigning === false && one.certification === null);
  for (const level of [1, 2, 3]) {
    const file = signed(`certified-${level}`, `sign(sys.argv[1], "Sig1", "Test Signer", extra_sig='${certified(level)}', certify=True)`);
    expect(`a certification that allows level ${level} says so`, (await signatures(file)).certification === level);
  }
  expect('a certification with no level given means form filling and signing', (await signatures(signed('certified-default', 'sign(sys.argv[1], "Sig1", "Test Signer", certify=True)'))).certification === 2);
  const lock = (extra) => signed(`lock-${crypto.randomBytes(3).toString('hex')}`, `sign(sys.argv[1], "Sig1", "Test Signer", extra_field='/Lock<</Type/SigFieldLock/Action/${extra}>>')`);
  expect('a lock on named fields says which', JSON.stringify((await signatures(lock('Include/Fields[(name)(city)]'))).fields[0].lock) === '{"action":"Include","fields":["name","city"]}');
  expect('a lock on every field and one on every field but some', JSON.stringify((await signatures(lock('All'))).fields[0].lock) === '{"action":"All","fields":[]}' && JSON.stringify((await signatures(lock('Exclude/Fields[(name)]'))).fields[0].lock) === '{"action":"Exclude","fields":["name"]}');
  const empty = await signatures(signed('empty', 'sign(sys.argv[1], "Sig1", "", empty=True)'));
  expect('a signature field nobody has signed is told from a signed one', empty.fields.length === 1 && empty.fields[0].signed === false && empty.fields[0].name === 'Sig1' && !('signer' in empty.fields[0]));
  const pair = signed('pair', 'sign(sys.argv[1], "Sig1", "First Signer")\nsign(sys.argv[1], "Sig2", "Second Signer")');
  const both = await signatures(pair);
  expect('two signatures in two revisions are both signed, and the first is not called changed because the second follows it', both.fields.length === 2 && both.fields.every((f) => f.signed && f.intact) && both.fields[0].signer === 'First Signer' && both.fields[1].signer === 'Second Signer' && both.changedAfterSigning === false, JSON.stringify(both));
  const filled = at('filled.pdf');
  fs.copyFileSync(pair, filled);
  python('import pymupdf, sys\nd = pymupdf.open(sys.argv[1])\nd.set_metadata({"title": "after"})\nd.saveIncr()', filled);
  const changed = await signatures(filled);
  expect('a change added after the last signature is reported, and the signed parts are still where they were', changed.changedAfterSigning === true && changed.fields.every((f) => f.intact), JSON.stringify(changed));
  const rewritten = at('rewritten.pdf');
  python('import pymupdf, sys\nd = pymupdf.open(sys.argv[1])\nd.save(sys.argv[2], garbage=4, deflate=True)', approval, rewritten);
  expect('a file written out whole no longer ends its signed part at the end of the file', (await signatures(rewritten)).fields.every((f) => f.intact === false));
  const damaged = at('damaged.pdf');
  fs.writeFileSync(damaged, Buffer.concat([fs.readFileSync(approval), Buffer.from('\njunk after the file\n')]));
  expect('bytes after the signed part are reported as a change', (await signatures(damaged)).changedAfterSigning === true);
  expect('no fact says a signature is valid or checked', !JSON.stringify([one, both, changed]).match(/valid|verified/i));
  const asSigned = at('approval-incremental.pdf');
  await tool(approval, asSigned, list(rotate([1])));
  expect('a change made by the helper to a signed file is added after the signed part', (await signatures(asSigned)).changedAfterSigning === true && (await signatures(asSigned)).fields[0].intact === true);

  console.log('stopping');
  const stopped = at('stopped.pdf');
  const early = new AbortController();
  early.abort();
  const refused = await tool(draw, stopped, list(rotate([1])), undefined, { signal: early.signal }).then(() => 'finished', (e) => e.name);
  expect('a stop asked for before the helper starts is refused with a cancellation and leaves no file', refused === 'CancelledError' && !fs.existsSync(stopped), refused);
  // The three-page edit ends in about the time taking its process down takes on a busy runner, so it cannot be stopped on cue; a helper that waits can.
  const started = at('started.txt');
  const controller = new AbortController();
  const sleeper = 'import sys, time\nopen(sys.argv[1], "w").close()\ntime.sleep(60)\nopen(sys.argv[2], "w").close()';
  const waiting = withContext({ signal: controller.signal, outputs: [] }, () => runProcess(py, ['-c', sleeper, started, stopped])).then(() => 'finished', (e) => e.name);
  for (let waited = 0; waited < 20000 && !fs.existsSync(started); waited += 20) await sleep(20);
  controller.abort();
  const why = await waiting;
  expect('stopping a helper that is running kills it and leaves no file', why === 'CancelledError' && !fs.existsSync(stopped), why);

  console.log('no engine');
  conversion.detectEngines([]);
  const none = await tool(draw, at('none.pdf'), list(rotate([1]))).then(() => null, (e) => e);
  expect('without the engine the tool says so, and starts nothing', none?.message === 'The PDF engine is not installed' && none.code === 'NO_ENGINE' && !fs.existsSync(at('none.pdf')));
  finish();
})().catch((e) => { console.error(e); finish(2); });

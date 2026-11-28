// SPDX-License-Identifier: AGPL-3.0-or-later
// Highlight, ink and text-box operations written by the PDF engine into pages of every kind (turned, offset, cropped, scaled, already
// annotated, protected) and with text in several scripts: where each mark lands, that it has an appearance, that the file is appended to
// and reads without repair. Needs the PDF engine (skipped without it).   node test/integration/pdf-workspace/annot-compat.test.js
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const conversion = require('../../../src/features/conversion');
const { check } = require('../../../src/features/pdf-workspace/ops');
const { expect } = require('../../support/expect');
const finish = require('../../support/finish');
const tmp = require('../../support/tmp');

const py = conversion.detectEngines().pdf;
if (!py) { console.log('  PDF engine not installed: skipped'); finish(0); return; }

const dir = tmp.dir('annot-compat');
const at = (name) => path.join(dir, name);
const python = (code, ...args) => {
  const r = childProcess.spawnSync(py, ['-W', 'ignore', '-c', code, ...args], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};

const MAKE = String.raw`import sys, pymupdf
name, turn, mode = sys.argv[1], int(sys.argv[2]), sys.argv[3]
d = pymupdf.open()
p = d.new_page(width=595, height=842)
p.insert_text((60, 120), "Alpha beta gamma delta", fontsize=20)
if mode == "offset":
    p.set_mediabox(pymupdf.Rect(100, 60, 695, 902))
if mode == "crop":
    p.set_cropbox(pymupdf.Rect(40, 50, 500, 700))
if mode == "unit":
    d.xref_set_key(p.xref, "UserUnit", "2")
if mode == "other":
    p.insert_link({"kind": pymupdf.LINK_URI, "from": pymupdf.Rect(60, 100, 250, 125), "uri": "https://example.com/"})
p.set_rotation(turn)
if mode == "locked":
    d.save(name, encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw="open-me", owner_pw="owner-me")
else:
    d.save(name, expand=255)`;

const READ = String.raw`import json, sys, pymupdf
d = pymupdf.open(sys.argv[1])
if d.needs_pass: d.authenticate(sys.argv[2])
p = d[0]
turn = p.rotation_matrix
def shown(r): r = pymupdf.Rect(r) * turn; r.normalize(); return [r.x0, r.y0, r.x1, r.y1]
notes = []
for a in p.annots():
    pts = []
    for s in (a.vertices or []):
        if isinstance(s, tuple): pts.append(tuple(pymupdf.Point(s) * turn))
        else: pts.extend(tuple(pymupdf.Point(q) * turn) for q in s)
    pix = a.get_pixmap(alpha=False) if a.type[1] != "Link" else None
    notes.append({"type": a.type[1], "rect": shown(a.rect), "colors": a.colors, "opacity": a.opacity, "content": a.info.get("content", ""), "points": pts,
      "ap": d.xref_get_key(a.xref, "AP")[0] != "null", "da": d.xref_get_key(a.xref, "DA")[1], "ink": bool(pix and any(c != 255 for c in pix.samples[:: pix.n]))})
words = [{"text": w[4], "rect": shown(w[:4])} for w in p.get_text("words")]
print(json.dumps({"annots": notes, "words": words, "size": [p.rect.width, p.rect.height], "repaired": d.is_repaired, "encrypted": d.metadata["encryption"], "rotation": p.rotation}))`;

const list = (...ops) => { const file = at(`ops-${crypto.randomBytes(4).toString('hex')}.json`); fs.writeFileSync(file, JSON.stringify({ version: 1, ops: check(ops) })); return file; };
const run = (src, out, file, secrets) => conversion.runPdfTool('pdf_edit.py', [src, out, file], { src, secrets });
const look = (file, password = '') => JSON.parse(python(READ, file, password));
const near = (a, b, by) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= by);
const hull = (points) => [Math.min(...points.map((p) => p[0])), Math.min(...points.map((p) => p[1])), Math.max(...points.map((p) => p[0])), Math.max(...points.map((p) => p[1]))];
const reason = (promise) => promise.then(() => '', (e) => e.message);

const CASES = [
  ['upright', 0, 'plain'], ['turned 90', 90, 'plain'], ['turned 180', 180, 'plain'], ['turned 270', 270, 'plain'],
  ['a media box that does not start at 0, 0', 0, 'offset'], ['a turned page with a media box that does not start at 0, 0', 90, 'offset'],
  ['a crop box inside the media box', 0, 'crop'], ['a turned page with a crop box', 270, 'crop'],
  ['a user unit of 2', 0, 'unit'], ['an annotation made by another program', 0, 'other'], ['a protected file', 0, 'locked'],
];
const SECRET = { password: 'open-me' };

(async () => {
  for (const [name, turn, mode] of CASES) {
    console.log(name);
    const src = at(`${mode}-${turn}.pdf`);
    python(MAKE, src, String(turn), mode);
    const before = look(src, 'open-me');
    const line = hull(before.words.filter((w) => ['Alpha', 'beta', 'gamma', 'delta'].includes(w.text)).flatMap((w) => [[w.rect[0], w.rect[1]], [w.rect[2], w.rect[3]]]));
    const [w, h] = before.size;
    const quad = [line[0], line[1], line[2], line[1], line[0], line[3], line[2], line[3]];
    const stroke = [w * 0.2, h * 0.5, w * 0.4, h * 0.55, w * 0.6, h * 0.5];
    const box = [w * 0.2, h * 0.7, w * 0.6, h * 0.75];
    const out = at(`out-${mode}-${turn}.pdf`);
    await run(src, out, list(
      { op: 'annot.add', type: 'highlight', page: 1, color: [255, 216, 77], quads: [quad] },
      { op: 'annot.add', type: 'ink', page: 1, color: [0, 0, 0], thickness: 2, paths: [stroke] },
      { op: 'annot.add', type: 'freetext', page: 1, color: [200, 0, 0], rect: box, text: 'Hello cafe', size: 14, font: 'Helvetica' },
    ), mode === 'locked' ? SECRET : undefined);
    const after = look(out, 'open-me');
    const mine = after.annots.filter((a) => a.type !== 'Link');
    const kept = before.annots.length;
    expect('the three marks are there and what was there before is kept', mine.map((a) => a.type).join() === 'Highlight,Ink,FreeText' && after.annots.length === kept + 3, after.annots.map((a) => a.type).join());
    expect('every mark has an appearance, and the ink and the text show', mine.every((a) => a.ap) && mine[1].ink && mine[2].ink);
    expect('the page is as turned as before and the file reads without repair', after.rotation === before.rotation && after.repaired === false);
    expect('the highlight covers the line as it is shown, with the margin PyMuPDF gives its box', near(mine[0].rect, line, mode === 'unit' ? 14 : 7), JSON.stringify([mine[0].rect, line]));
    expect('the highlight is the colour asked for', near(mine[0].colors.stroke.map((c) => Math.round(c * 255)), [255, 216, 77], 1));
    expect('the stroke runs where it was drawn, as the page is shown', near(hull(mine[1].points), [stroke[0], Math.min(stroke[1], stroke[3], stroke[5]), stroke[4], Math.max(stroke[1], stroke[3], stroke[5])], 3), JSON.stringify([hull(mine[1].points), stroke]));
    expect('the text box starts at the corner it was given and holds the text', mine[2].content === 'Hello cafe' && near(mine[2].rect.slice(0, 2), box.slice(0, 2), 3), JSON.stringify([mine[2].rect, box]));
    if (mode !== 'locked') expect('it was appended: the file it started from is the start of the result', fs.readFileSync(out).subarray(0, fs.statSync(src).size).equals(fs.readFileSync(src)));
    else expect('a protected file stays protected with the same encryption', after.encrypted === before.encrypted && after.encrypted !== 'None', after.encrypted);
  }

  console.log('text in several scripts');
  const plain = at('plain-0.pdf');
  for (const [name, text] of [['Latin with accents', 'Café naïve Zoë'], ['Greek', 'Ελληνικά'], ['Cyrillic', 'Привет мир'], ['Chinese', '你好世界'], ['Arabic', 'مرحبا بالعالم'], ['an emoji', 'Hi 😀']]) {
    const out = at(`text-${crypto.randomBytes(3).toString('hex')}.pdf`);
    const said = await reason(run(plain, out, list({ op: 'annot.add', type: 'freetext', page: 1, color: [0, 0, 0], rect: [60, 400, 400, 440], text, size: 16, font: 'Helvetica' })));
    const note = said ? null : look(out).annots.find((a) => a.type === 'FreeText');
    expect(`${name}: it is refused with a reason, or written with an appearance that shows`, said ? said.length > 0 : note.ap && note.content === text && note.ink, said || JSON.stringify(note));
    console.log(`    ${name}: ${said ? `refused (${said.split('\n').pop()})` : `written${note.ink ? ' and drawn' : ' but nothing is drawn'}`}`);
  }

  console.log('the fonts of a text box');
  for (const [font, resource] of [['Helvetica', 'Helv'], ['Times', 'TiRo'], ['Courier', 'Cour']]) {
    const out = at(`font-${font}.pdf`);
    await run(plain, out, list({ op: 'annot.add', type: 'freetext', page: 1, color: [0, 0, 0], rect: [60, 400, 400, 440], text: 'Hello cafe', size: 16, font }));
    const note = look(out).annots.find((a) => a.type === 'FreeText');
    expect(`${font} is written in the ${resource} font and drawn`, note.da.includes(`/${resource} `) && note.ink, note.da);
  }

  console.log('what is refused');
  const mistakes = {
    'a page past the end': { op: 'annot.add', type: 'ink', page: 5, color: [0, 0, 0], thickness: 1, paths: [[1, 1, 5, 5]] },
    'a text box of blank text': { op: 'annot.add', type: 'freetext', page: 1, color: [0, 0, 0], rect: [1, 1, 100, 40], text: ' ', size: 12, font: 'Helvetica' },
  };
  for (const [what, op] of Object.entries(mistakes)) {
    const fileOp = at(`bad-${crypto.randomBytes(3).toString('hex')}.json`);
    fs.writeFileSync(fileOp, JSON.stringify({ version: 1, ops: [op] }));
    const out = at(`bad-${crypto.randomBytes(3).toString('hex')}.pdf`);
    expect(`${what} is refused and nothing is written`, (await reason(run(plain, out, fileOp))).length > 0 && !fs.existsSync(out));
  }
  const unchecked = at('unchecked.json');
  fs.writeFileSync(unchecked, JSON.stringify({ version: 1, ops: [{ op: 'annot.add', type: 'highlight', page: 1, color: [255, 216, 77] }] }));
  expect('a highlight with no quads is refused by the helper itself', (await reason(run(plain, at('unchecked.pdf'), unchecked))).length > 0 && !fs.existsSync(at('unchecked.pdf')));
  finish();
})().catch((e) => { console.error(e); finish(2); });

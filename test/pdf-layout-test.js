// SPDX-License-Identifier: AGPL-3.0-or-later
// PDF -> DOCX on small PDFs drawn here: the Word file must be editable (real paragraphs, lists and tables, no frames of loose
// lines), keep what the page looks like, and say plainly what is wrong with a PDF it cannot read. Needs the PDF engine
// (skipped without it); the scan test also needs the OCR component.   node test/pdf-layout-test.js
// For real-world pages and a similarity score against the original, see test/fidelity/run.js.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const JSZip = require('jszip');
const convert = require('../src/main/convert');

const { expect, failed } = require('./support/expect');
const finish = require('./support/finish');
const tmp = require('./support/tmp');

// argv: out.pdf, then what to draw
const MAKE_PDF = `
import sys, pymupdf
doc = pymupdf.open()
kind = sys.argv[2]
if kind == "text":                                  # many pages of nothing but text: the case that used to take seconds a page
    for n in range(int(sys.argv[3])):
        page = doc.new_page(width=595, height=842)
        for i in range(40):
            page.insert_text((60, 70 + i * 18), "Page %d line %d: plain text on a white page, the most common kind of PDF." % (n + 1, i + 1), fontname="helv", fontsize=10)
    doc.save(sys.argv[1]); sys.exit()
page = doc.new_page(width=595, height=842)
if kind == "banner":
    page.draw_rect(pymupdf.Rect(40, 40, 555, 140), color=None, fill=(0.1, 0.2, 0.45))           # a coloured banner
    page.insert_text((60, 100), "Quarterly Report", fontname="hebo", fontsize=26, color=(1, 1, 1))  # white text on it
else:
    page.insert_text((60, 100), "Quarterly Report", fontname="hebo", fontsize=26)
page.insert_text((60, 190), "Revenue grew 18% while costs stayed flat.", fontname="helv", fontsize=11)
page.insert_text((60, 210), "Contact: ", fontname="helv", fontsize=11)
page.insert_text((112, 210), "team@example.com", fontname="heit", fontsize=11, color=(0, 0, 0.8))
page.insert_link({"kind": pymupdf.LINK_URI, "from": pymupdf.Rect(110, 198, 200, 214), "uri": "mailto:team@example.com"})
page.insert_text((60, 240), "\\u2022", fontname="helv", fontsize=11)
page.insert_text((78, 240), "A bullet that wraps onto a second line in the original", fontname="helv", fontsize=11)
page.insert_text((78, 254), "and keeps its indent.", fontname="helv", fontsize=11)
page.draw_line((60, 270), (535, 270), color=(0.5, 0.5, 0.5), width=1)                       # a rule
# a ruled table with a shaded header whose text is white
for r in range(3):
    for c in range(3):
        rect = pymupdf.Rect(60 + c * 150, 300 + r * 28, 210 + c * 150, 328 + r * 28)
        page.draw_rect(rect, color=(0.4, 0.4, 0.4), fill=(0.1, 0.3, 0.5) if r == 0 else None, width=0.8)
        page.insert_text((rect.x0 + 8, rect.y0 + 18), ["Region", "Today", "Target"][c] if r == 0 else "cell %d%d" % (r, c), fontname="helv", fontsize=10, color=(1, 1, 1) if r == 0 else (0, 0, 0))
if kind == "scan":                                  # the same page as a photograph of it: no text at all
    pix = page.get_pixmap(dpi=150)
    scan = pymupdf.open(); sp = scan.new_page(width=595, height=842); sp.insert_image(sp.rect, pixmap=pix)
    scan.save(sys.argv[1]); sys.exit()
if kind == "locked":
    doc.save(sys.argv[1], encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw="secret", owner_pw="owner"); sys.exit()
doc.save(sys.argv[1])
`;

// Blanks are ignored: a run boundary can fall in the middle of a word, which is not a loss of text.
const squash = (s) => s.replace(/\s+/g, '');
const missingFrom = (text, wanted) => wanted.filter((t) => !squash(text).includes(squash(t)));

const read = async (docx) => {
  const zip = await JSZip.loadAsync(fs.readFileSync(docx));
  const xml = await zip.file('word/document.xml').async('string');
  const rels = await zip.file('word/_rels/document.xml.rels').async('string');
  return { zip, xml, rels, text: [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('') };
};

(async () => {
  const engines = convert.detectEngines();
  if (!engines.pdf) { console.log('PDF engine not installed: skipped'); return; }
  const dir = tmp.dir('layout');
  const make = path.join(dir, 'make.py');
  fs.writeFileSync(make, MAKE_PDF);
  const draw = (name, kind, extra = '') => { const f = path.join(dir, `${name}.pdf`); execFileSync(engines.pdf, ['-W', 'ignore', make, f, kind, ...(extra ? [extra] : [])], { windowsHide: true }); return f; };
  const WANTED = ['Quarterly Report', 'Revenue grew 18%', 'team@example.com', 'A bullet that wraps', 'keeps its indent', 'Region', 'cell 21'];

  console.log('a designed page (white heading on a coloured banner)');
  let [docx] = await convert.convertFile(draw('designed', 'banner'), 'docx');
  let d = await read(docx);
  expect('all the text is there', !missingFrom(d.text, WANTED).length, missingFrom(d.text, WANTED).join(' | '));
  expect('it is editable: real paragraphs, no frames of loose lines', !/<w:framePr /.test(d.xml) && (d.xml.match(/<w:p[ >]/g) || []).length >= 8);
  expect('the banner is kept, behind or as shading, and the white heading is still white (readable)', /<w:color w:val="FFFFFF"\/>/.test(d.xml) && (/w:fill="1A3373"/i.test(d.xml) || /behindDoc="1"/.test(d.xml)));
  expect('the table is a real Word table with its shaded header', /<w:tbl>/.test(d.xml) && /w:fill="[0-9A-F]{6}"/i.test(d.xml));
  expect('the link points where it did', /Target="mailto:team@example\.com"/.test(d.rels));
  expect('a hyperlink is a child of its paragraph, never of a run', !/<w:r>(?:(?!<\/w:r>).)*<w:hyperlink/s.test(d.xml));
  expect('the bullet is a real list item', /<w:numPr>/.test(d.xml));
  expect('no table row clips its text (no exact row height)', !/<w:trHeight [^>]*w:hRule="exact"/.test(d.xml));
  expect('the page is the same size (595 x 842 pt)', /w:pgSz w:w="11900" w:h="16840"/.test(d.xml));
  fs.rmSync(docx);

  console.log('a plain page');
  [docx] = await convert.convertFile(draw('plain', 'plain'), 'docx');
  d = await read(docx);
  expect('all the text is there', !missingFrom(d.text, WANTED).length, missingFrom(d.text, WANTED).join(' | '));
  expect('it is editable: no frames', !/<w:framePr /.test(d.xml));
  fs.rmSync(docx);

  console.log('speed: 40 pages of plain text');
  {
    const t0 = Date.now();
    [docx] = await convert.convertFile(draw('long', 'text', '40'), 'docx');
    const seconds = (Date.now() - t0) / 1000;
    d = await read(docx);
    expect('converted in well under a minute (a blank-page check used to cost seconds a page)', seconds < 60, `${seconds.toFixed(1)} s`);
    expect('every page is a page of the Word file', (d.xml.match(/<w:pgSz /g) || []).length === 40);
    fs.rmSync(docx);
  }

  console.log('PDFs that cannot be read: a reason a person can act on');
  {
    let message = '';
    try { await convert.convertFile(draw('locked', 'locked'), 'docx'); } catch (e) { message = e.message; }
    expect('a password-protected PDF says so', /password/i.test(message), message);
    const bad = path.join(dir, 'broken.pdf');
    fs.writeFileSync(bad, 'this is not a pdf at all');
    message = '';
    try { await convert.convertFile(bad, 'docx'); } catch (e) { message = e.message; }
    expect('a damaged file says so, without a path or a stack trace', /damaged|not a PDF/i.test(message) && !/[A-Z]:\\/.test(message), message);
  }

  console.log('a scanned PDF (a picture of a page)');
  if (!engines.ocr) console.log('  OCR component not installed: skipped');
  else {
    [docx] = await convert.convertFile(draw('scan', 'scan'), 'docx');
    d = await read(docx);
    const found = ['Quarterly Report', 'Revenue grew', 'team@example.com', 'A bullet that wraps'].filter((t) => squash(d.text.toLowerCase()).includes(squash(t.toLowerCase())));
    expect('the text of the scan is recognised and is real, editable text', found.length >= 3, `${found.length} of 4: ${d.text.slice(0, 120)}`);
    fs.rmSync(docx);
  }

  console.log(failed() ? `\n${failed()} failed` : '\nall good');
  finish();
})().catch((e) => { console.error(e); finish(1); });

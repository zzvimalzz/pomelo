// SPDX-License-Identifier: AGPL-3.0-or-later
// PDF -> DOCX, both layouts, on a small PDF drawn here. Needs the PDF engine (skipped without it).   node test/pdf-layout-test.js
// For real-world pages and a similarity score against the original, see test/fidelity/run.js.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const JSZip = require('jszip');
const convert = require('../src/main/convert');

let failures = 0;
const expect = (name, ok, extra = '') => { if (!ok) failures++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); };

// argv: out.pdf, then "banner" for the designed variant (white heading on a coloured banner) or "plain"
const MAKE_PDF = `
import sys, pymupdf
doc = pymupdf.open()
page = doc.new_page(width=595, height=842)
if sys.argv[2] == "banner":
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
  if (!engines.pdf2docx) { console.log('PDF engine not installed: skipped'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pomelo-layout-'));
  const make = path.join(dir, 'make.py');
  fs.writeFileSync(make, MAKE_PDF);
  const pdf = path.join(dir, 'designed.pdf');
  execFileSync(engines.pdf2docx, ['-W', 'ignore', make, pdf, 'banner'], { windowsHide: true });
  const plain = path.join(dir, 'plain.pdf');
  execFileSync(engines.pdf2docx, ['-W', 'ignore', make, plain, 'plain'], { windowsHide: true });

  console.log('exact layout (the default)');
  let [docx] = await convert.convertFile(pdf, 'docx');
  let d = await read(docx);
  const WANTED = ['Quarterly Report', 'Revenue grew 18%', 'team@example.com', 'A bullet that wraps', 'keeps its indent'];
  expect('all the text is there', !missingFrom(d.text, WANTED).length, missingFrom(d.text, WANTED).join(' | '));
  expect('text is placed in frames at fixed positions', /<w:framePr /.test(d.xml));
  expect('the banner is a picture behind the text, not lost', /behindDoc="1"/.test(d.xml) && Object.keys(d.zip.files).some((f) => /^word\/media\//.test(f)));
  expect('the white heading is still white (and so readable)', /<w:color w:val="FFFFFF"\/>/.test(d.xml));
  expect('the link points where it did', /Target="mailto:team@example\.com"/.test(d.rels));
  expect('a hyperlink is a child of its paragraph, never of a run', !/<w:r>(?:(?!<\/w:r>).)*<w:hyperlink/s.test(d.xml));
  expect('the page is the same size (595 x 842 pt)', /w:pgSz w:w="11900" w:h="16840"/.test(d.xml));
  fs.rmSync(docx);

  console.log('editable layout');
  process.env.POMELO_PDF_MODE = 'editable';
  try {
    [docx] = await convert.convertFile(pdf, 'docx');
    d = await read(docx);
    expect('a designed page is still converted exactly (a flowing rebuild would lose the banner and its white heading)', /<w:framePr /.test(d.xml) && /behindDoc="1"/.test(d.xml));
    fs.rmSync(docx);
    [docx] = await convert.convertFile(plain, 'docx');
  } finally { delete process.env.POMELO_PDF_MODE; }
  d = await read(docx);
  expect('a plain page becomes flowing paragraphs', !/<w:framePr /.test(d.xml));
  expect('all the text is there', !missingFrom(d.text, WANTED.slice(0, 4)).length, `${missingFrom(d.text, WANTED.slice(0, 4)).join(' | ')}   [${d.text.slice(0, 160)}]`);
  expect('the link survives and is valid', /Target="mailto:team@example\.com"/.test(d.rels) && !/<w:r>(?:(?!<\/w:r>).)*<w:hyperlink/s.test(d.xml));
  expect('no table row clips its text', !/w:hRule="exact"/.test(d.xml.replace(/<w:framePr[^>]*>/g, '')));
  expect('the bullet is a real list item', /<w:numPr>/.test(d.xml));

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failed` : '\nall good');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

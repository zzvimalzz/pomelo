// SPDX-License-Identifier: AGPL-3.0-or-later
// A PDF into every other format: Markdown, HTML, text, EPUB, Excel, PowerPoint, RTF, and the progress they report.
// Needs the PDF engine (skipped without it).   node test/pdf-formats-test.js
// Scores on real-world pages: test/fidelity/formats.js.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const JSZip = require('jszip');
const XLSX = require('xlsx');
const convert = require('../src/main/convert');

let failures = 0;
const expect = (name, ok, extra = '') => { if (!ok) failures++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); };

// A two-page PDF: a title, a paragraph with a link, bullets, a ruled table, a coloured banner with white text, a picture.
const MAKE_PDF = `
import sys, pymupdf
doc = pymupdf.open()
p = doc.new_page(width=595, height=842)
p.draw_rect(pymupdf.Rect(40, 30, 555, 100), color=None, fill=(0.1, 0.2, 0.45))
p.insert_text((60, 78), "Quarterly Report", fontname="hebo", fontsize=26, color=(1, 1, 1))
p.insert_text((60, 140), "Revenue", fontname="hebo", fontsize=16)
p.insert_text((60, 165), "Revenue grew 18% while costs stayed flat. Write to", fontname="helv", fontsize=11)
p.insert_text((60, 181), "team@example.com", fontname="heit", fontsize=11, color=(0, 0, 0.8))
p.insert_link({"kind": pymupdf.LINK_URI, "from": pymupdf.Rect(60, 170, 160, 185), "uri": "mailto:team@example.com"})
for i, t in enumerate(["Opened the Jakarta office", "Renewed every enterprise contract", "Shipped the new console"]):
    p.insert_text((60, 215 + i * 18), "\\u2022", fontname="helv", fontsize=11)
    p.insert_text((78, 215 + i * 18), t, fontname="helv", fontsize=11)
x0, y0, cw, rh = 60, 300, 120, 24
rows = [["Region", "2025", "2026"], ["Asia", "41", "52"], ["Europe", "29", "33"], ["Americas", "12", "19"]]
for r in range(5):
    p.draw_line((x0, y0 + r * rh), (x0 + 3 * cw, y0 + r * rh), color=(0, 0, 0), width=1)
for c in range(4):
    p.draw_line((x0 + c * cw, y0), (x0 + c * cw, y0 + 4 * rh), color=(0, 0, 0), width=1)
for r, row in enumerate(rows):
    for c, v in enumerate(row):
        p.insert_text((x0 + c * cw + 8, y0 + r * rh + 16), v, fontname="helv", fontsize=11)
pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 160, 90), False); pix.set_rect(pix.irect, (230, 120, 60))
p.insert_image(pymupdf.Rect(60, 450, 220, 540), pixmap=pix)
p2 = doc.new_page(width=595, height=842)
p2.insert_text((60, 100), "Second page", fontname="hebo", fontsize=16)
p2.insert_text((60, 130), "More words live on the second page of this report.", fontname="helv", fontsize=11)
doc.save(sys.argv[1])
`;

const MAKE_PLAIN = `
import sys, pymupdf
doc = pymupdf.open(); p = doc.new_page()
p.insert_text((60, 100), "Just a short note with no table at all.", fontname="helv", fontsize=11)
doc.save(sys.argv[1])
`;

const fresh = (name, ext) => path.join(os.tmpdir(), `pomelo-fmt-${process.pid}-${name}.${ext}`);

(async () => {
  const engines = convert.detectEngines();
  if (!engines.pdf) { console.log('PDF engine not installed: skipped'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pomelo-formats-'));
  const py = (code, ...args) => { const f = path.join(dir, `m${Math.random().toString(36).slice(2)}.py`); fs.writeFileSync(f, code); execFileSync(engines.pdf, ['-W', 'ignore', f, ...args], { windowsHide: true }); };
  const pdf = path.join(dir, 'report.pdf');
  const plain = path.join(dir, 'note.pdf');
  py(MAKE_PDF, pdf);
  py(MAKE_PLAIN, plain);
  const to = async (file, format, onProgress) => (await convert.convertFile(file, format, { onProgress }))[0];
  const text = (file) => fs.readFileSync(file, 'utf8');

  console.log('Markdown');
  const progress = [];
  let out = await to(pdf, 'md', (f) => progress.push(f));
  let md = text(out);
  expect('the title and the section are headings', /^#{1,3} Quarterly Report/m.test(md) && /^#{1,4} Revenue$/m.test(md));
  expect('all the text is there, both pages', ['Revenue grew 18%', 'Opened the Jakarta office', 'Shipped the new console', 'Second page', 'second page of this report'].every((t) => md.includes(t)));
  expect('the link keeps its address', /\[\*?team@example\.com\*?\]\(mailto:team@example\.com\)/.test(md));
  expect('bullets are list items, without the bullet character', /^- Opened the Jakarta office$/m.test(md) && !md.includes('•'));
  expect('the table is a table', /\| Region \| 2025 \| 2026 \|/.test(md) && /\| Asia \| 41 \| 52 \|/.test(md));
  expect('the picture is saved next to it and linked', /!\[[^\]]*\]\(report_images\/image-1\.\w+\)/.test(md) && fs.existsSync(path.join(dir, 'report_images')));
  expect('progress was reported, rising, below 100% until the end', progress.length >= 2 && progress.every((v, i) => i === 0 || v >= progress[i - 1]) && progress.at(-1) < 1, progress.map((v) => v.toFixed(2)).join(' '));

  console.log('HTML and EPUB');
  out = await to(pdf, 'html');
  const html = text(out);
  expect('headings, a link, list items and a table', /<h[1-3]>Quarterly Report<\/h[1-3]>/.test(html) && /<a href="mailto:team@example\.com">/.test(html) && (html.match(/<li>/g) || []).length === 3 && /<table>/.test(html));
  expect('the picture is inside the file', /<img src="data:image\/(png|jpeg);base64,/.test(html));
  out = await to(pdf, 'epub');
  const epub = await JSZip.loadAsync(fs.readFileSync(out));
  const chapters = await Promise.all(Object.keys(epub.files).filter((n) => /\.x?html$/.test(n)).map((n) => epub.file(n).async('string')));
  expect('the EPUB holds the text and the link', chapters.join('').includes('Opened the Jakarta office') && /mailto:team@example\.com/.test(chapters.join('')));

  console.log('plain text');
  const txt = text(await to(pdf, 'txt'));
  expect('every line of text, in reading order, and the bullets as bullets', txt.indexOf('Quarterly Report') < txt.indexOf('Revenue grew') && txt.indexOf('Revenue grew') < txt.indexOf('Second page') && /• Opened the Jakarta office/.test(txt));

  console.log('Excel');
  out = await to(pdf, 'xlsx');
  let wb = XLSX.readFile(out);
  const cells = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
  expect('the ruled table is a sheet with real numbers', cells.length === 4 && cells[1][0] === 'Asia' && cells[1][2] === 52, JSON.stringify(cells[1]));
  out = await to(plain, 'xlsx');
  wb = XLSX.readFile(out);
  expect('a PDF without a table still gives its text, not an error', wb.SheetNames.length === 1 && JSON.stringify(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 })).includes('Just a short note'));

  console.log('PowerPoint');
  out = await to(pdf, 'pptx');
  const deck = await JSZip.loadAsync(fs.readFileSync(out));
  const slide1 = await deck.file('ppt/slides/slide1.xml').async('string');
  const rels = await deck.file('ppt/slides/_rels/slide1.xml.rels').async('string');
  expect('one slide per page', !!deck.file('ppt/slides/slide2.xml') && !deck.file('ppt/slides/slide3.xml'));
  expect('the text is real text, with the white heading still white', /Quarterly Report/.test(slide1) && /FFFFFF/i.test(slide1.slice(slide1.indexOf('Quarterly') - 600, slide1.indexOf('Quarterly'))));
  expect('the banner and the picture are there as the slide background', /image/.test(rels) && /ppt\/media\//.test(Object.keys(deck.files).join(' ')));
  expect('the link points where it did', /Target="mailto:team@example\.com"/.test(rels));

  console.log('RTF');
  if (!engines.soffice) console.log('  LibreOffice not installed: skipped');
  else {
    out = await to(pdf, 'rtf');
    const rtf = fs.readFileSync(out, 'latin1');
    expect('opens as rich text with its words', rtf.startsWith('{\\rtf') && rtf.includes('Opened the Jakarta office') && rtf.includes('Second page'));
  }

  console.log('a blank scan says so');
  const scan = path.join(dir, 'scan.pdf');
  py(`
import sys, pymupdf
doc = pymupdf.open(); p = doc.new_page()
pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 100, 100), False); pix.set_rect(pix.irect, (200, 200, 200))
p.insert_image(p.rect, pixmap=pix); doc.save(sys.argv[1])`, scan);
  let message = '';
  try { await to(scan, 'md'); } catch (e) { message = e.message; }
  expect('a clear message, not an empty file', /no text|OCR component/i.test(message), message);
  expect('and nothing was left behind', !fs.existsSync(path.join(dir, 'scan.md')) && !fs.existsSync(path.join(dir, 'scan_images')));

  fs.rmSync(dir, { recursive: true, force: true });
  for (const f of [fresh('x', 'x')]) fs.rmSync(f, { force: true });
  console.log(failures ? `\n${failures} failed` : '\nall good');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

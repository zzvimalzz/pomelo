// SPDX-License-Identifier: AGPL-3.0-or-later
// PDF -> DOCX on small PDFs drawn here: the Word file must be editable (real paragraphs, lists and tables, no frames of loose
// lines), keep what the page looks like, and say plainly what is wrong with a PDF it cannot read. Needs the PDF engine
// (skipped without it); the scan test also needs the OCR component.   node test/integration/conversion/pdf-layout.test.js
// For real-world pages and a similarity score against the original, see test/fidelity/run.js.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const JSZip = require('jszip');
const convert = require('../../../src/features/conversion');

const { expect, failed } = require('../../support/expect');
const finish = require('../../support/finish');
const tmp = require('../../support/tmp');

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
if kind == "edge":                                  # text that starts left of the sheet
    page = doc.new_page(width=595, height=842)
    page.insert_text((-10, 100), "Text that starts past the left edge of the sheet", fontname="helv", fontsize=11)
    page.insert_text((60, 130), "Text inside the sheet", fontname="helv", fontsize=11)
    doc.save(sys.argv[1]); sys.exit()
if kind == "mixed":                                 # portrait, landscape, portrait
    for w, h in ((595, 842), (842, 595), (595, 842)):
        page = doc.new_page(width=w, height=h)
        page.insert_text((60, 100), "Sheet %dx%d" % (w, h), fontname="helv", fontsize=11)
    doc.save(sys.argv[1]); sys.exit()
if kind == "turned":                                # the second sheet is stored sideways
    page = doc.new_page(width=595, height=842)
    page.insert_text((60, 100), "First sheet", fontname="helv", fontsize=11)
    page = doc.new_page(width=842, height=595)
    for i in range(3):
        page.insert_text((60, 100 + i * 20), "Second sheet line %d" % (i + 1), fontname="helv", fontsize=11)
    page.set_rotation(90)
    doc.save(sys.argv[1]); sys.exit()
if kind == "stretched":                             # a justified paragraph drawn word by word, and a row of figures
    page = doc.new_page(width=595, height=842)
    rows = ["Every request is read by two people before the", "panel decides whether a meeting will be needed for it", "and the applicant hears from the office within a week"]
    for i, row in enumerate(rows):
        words = row.split()
        gap = (260 - sum(pymupdf.get_text_length(w, fontname="helv", fontsize=10) for w in words)) / (len(words) - 1)
        x = 60
        for w in words:
            page.insert_text((x, 100 + i * 14), w, fontname="helv", fontsize=10)
            x += pymupdf.get_text_length(w, fontname="helv", fontsize=10) + gap
    page.insert_text((60, 142), "ends here.", fontname="helv", fontsize=10)
    x = 60
    for n in ("317", "334", "351", "368", "385", "402"):
        page.insert_text((x, 220), n, fontname="helv", fontsize=10)
        x += pymupdf.get_text_length(n, fontname="helv", fontsize=10) + 9
    doc.save(sys.argv[1]); sys.exit()
if kind == "backdrop":                              # a large picture with text on it and text below it
    page = doc.new_page(width=595, height=842)
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 60, 84), False)
    for yy in range(84):
        for xx in range(60):
            pix.set_pixel(xx, yy, (20 + xx * 3, 60 + yy, 120))
    page.insert_image(pymupdf.Rect(0, 0, 595, 600), pixmap=pix)
    for i in range(3):
        page.insert_text((60, 100 + i * 20), "Text on the picture, line %d" % (i + 1), fontname="helv", fontsize=12, color=(1, 1, 1))
    page.insert_text((60, 700), "Plain text below the picture", fontname="helv", fontsize=12)
    doc.save(sys.argv[1]); sys.exit()
if kind == "foot":                                  # a wide photo at the foot of the page, under a paragraph
    page = doc.new_page(width=595, height=842)
    for i in range(6):
        page.insert_text((60, 100 + i * 16), "Paragraph line %d of the page" % (i + 1), fontname="helv", fontsize=11)
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 60, 24), False)
    for yy in range(24):
        for xx in range(60):
            pix.set_pixel(xx, yy, (20 + xx * 3, 60 + yy * 4, 120))
    page.insert_image(pymupdf.Rect(60, 700, 535, 800), pixmap=pix, keep_proportion=False)
    page.insert_text((60, 815), "Caption of the photo", fontname="helv", fontsize=8)
    doc.save(sys.argv[1]); sys.exit()
if kind == "circle":                                # a wide photo cropped to a circle
    page = doc.new_page(width=595, height=842)
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 200, 100), False)
    for yy in range(100):
        for xx in range(200):
            pix.set_pixel(xx, yy, (xx, 120 + yy, 200 - xx))
    page.insert_image(pymupdf.Rect(60, 60, 260, 160), stream=pix.tobytes("jpeg"))
    page.clean_contents()
    xref = page.get_contents()[0]
    cx, cy, r, k = 160, 842 - 110, 50, 0.5523 * 50
    clip = "%g %g m %g %g %g %g %g %g c %g %g %g %g %g %g c %g %g %g %g %g %g c %g %g %g %g %g %g c h W n " % (
        cx + r, cy, cx + r, cy + k, cx + k, cy + r, cx, cy + r, cx - k, cy + r, cx - r, cy + k, cx - r, cy,
        cx - r, cy - k, cx - k, cy - r, cx, cy - r, cx + k, cy - r, cx + r, cy - k, cx + r, cy)
    doc.update_stream(xref, b"q " + clip.encode() + doc.xref_stream(xref) + b" Q")
    page.insert_text((60, 200), "A photo in a circle", fontname="helv", fontsize=11)
    doc.save(sys.argv[1]); sys.exit()
if kind == "cards":                                 # white cards on a pale page, each with a faint shadow drawn under it
    page = doc.new_page(width=595, height=842)
    page.draw_rect(page.rect, color=None, fill=(0.96, 0.97, 0.98))
    for i in range(3):
        x = 60 + i * 170
        shape = page.new_shape()
        shape.draw_rect(pymupdf.Rect(x, 100, x + 170, 220))
        shape.finish(color=None, fill=(0, 0, 0), fill_opacity=0.12)
        shape.commit()
        page.draw_rect(pymupdf.Rect(x + 12, 108, x + 158, 212), color=(0.8, 0.8, 0.8), fill=(1, 1, 1))
        page.insert_text((x + 20, 150), "Card %d" % (i + 1), fontname="helv", fontsize=14)
        page.insert_text((x + 20, 175), "A figure for the card", fontname="helv", fontsize=9)
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
  const wordCheck = (pdf, file) => JSON.parse(execFileSync(engines.pdf, ['-I', '-W', 'ignore', path.join(__dirname, '../../fidelity/compare.py'), '--docx-words', pdf, file], { encoding: 'utf8', windowsHide: true }));
  expect('the fidelity word check finds the words of the converted page', wordCheck(path.join(dir, 'plain.pdf'), docx).recall >= 0.97);
  fs.rmSync(docx);

  console.log('the fidelity word check on a hand-made DOCX');
  {
    const tiny = path.join(dir, 'tiny.pdf');
    execFileSync(engines.pdf, ['-W', 'ignore', '-c', 'import sys, pymupdf; d = pymupdf.open(); d.new_page().insert_text((50, 50), "Region Today Target"); d.save(sys.argv[1])', tiny], { windowsHide: true });
    const build = async (name, parts) => {
      const zip = new JSZip();
      for (const [part, body] of Object.entries(parts)) zip.file(`word/${part}.xml`, `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p>${body}</w:p></w:body></w:document>`);
      const file = path.join(dir, `${name}.docx`);
      fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
      return file;
    };
    const split = '<w:r><w:t>Reg</w:t></w:r><w:r><w:t>ion</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>Today</w:t><w:tab/></w:r>';
    const joined = wordCheck(tiny, await build('tabs', { document: `${split}<w:r><w:t>Target</w:t></w:r>` }));
    expect('words split over runs and separated by tabs all count', joined.recall === 1 && !joined.missing.length, JSON.stringify(joined));
    const footer = wordCheck(tiny, await build('footer', { document: split, footer1: '<w:r><w:t>Target</w:t></w:r>' }));
    expect('a word in a footer counts', footer.recall === 1, JSON.stringify(footer));
    const lost = wordCheck(tiny, await build('lost', { document: split }));
    expect('a word that is missing is named', lost.missing.join() === 'target' && lost.recall < 1, JSON.stringify(lost));
  }

  console.log('a page whose text starts left of the sheet');
  [docx] = await convert.convertFile(draw('edge', 'edge'), 'docx');
  d = await read(docx);
  expect('no page margin is negative (Word refuses to print the file)', !/w:(left|right|top|bottom)="-/.test(d.xml));
  expect('all the text is there', !missingFrom(d.text, ['left edge of the sheet', 'Text inside the sheet']).length);
  fs.rmSync(docx);

  console.log('portrait and landscape sheets in one document');
  [docx] = await convert.convertFile(draw('mixed', 'mixed'), 'docx');
  d = await read(docx);
  const mixed = d.xml.match(/<w:pgSz [^>]*\/>/g) || [];
  expect('each sheet has its own size, and only the landscape one is marked landscape', mixed.length === 3 && !/orient/.test(mixed[0] + mixed[2]) && /w:w="16840" w:h="11900" w:orient="landscape"/.test(mixed[1]), mixed.join(' '));
  fs.rmSync(docx);

  console.log('a sheet stored sideways (/Rotate)');
  [docx] = await convert.convertFile(draw('turned', 'turned'), 'docx');
  d = await read(docx);
  const sizes = d.xml.match(/<w:pgSz [^>]*\/>/g) || [];
  expect('the sideways sheet keeps the size it is shown at', sizes.length === 2 && sizes.every((z) => /w:w="11900" w:h="16840"/.test(z)), sizes.join(' '));
  const box = (d.xml.match(/<w:txbxContent>.*?<\/w:txbxContent>/s) || [''])[0];
  const order = ['Second sheet line 1', 'Second sheet line 2', 'Second sheet line 3'].map((t) => box.indexOf(t));
  expect('its text is real text in a box turned a quarter, in reading order, none of it a picture', /<a:xfrm rot="5400000">/.test(d.xml) && order[0] >= 0 && order[0] < order[1] && order[1] < order[2] && !/<pic:pic>/.test(d.xml), box.slice(0, 200));
  fs.rmSync(docx);

  console.log('a justified paragraph drawn word by word');
  [docx] = await convert.convertFile(draw('stretched', 'stretched'), 'docx');
  d = await read(docx);
  const paras = d.xml.match(/<w:p[ >].*?<\/w:p>/gs) || [];
  const plain = (p) => p.replace(/<[^>]+>/g, '');
  const prose = paras.filter((p) => plain(p).includes('Every request'));
  expect('the words of the paragraph are one justified paragraph, not one paragraph a word', prose.length === 1 && /w:jc w:val="both"/.test(prose[0]) && plain(prose[0]).includes('panel decides whether a meeting') && plain(prose[0]).includes('hears from the office'), `${paras.length} paragraphs`);
  const figures = paras.filter((p) => plain(p).includes('317'));
  expect('a row of evenly spaced figures stays a tabbed row', figures.length === 1 && (figures[0].match(/<w:tab\/>/g) || []).length >= 5 && !/w:jc w:val="both"/.test(figures[0]), figures.join('').slice(0, 200));
  fs.rmSync(docx);

  console.log('a large picture with text on it and text below it');
  [docx] = await convert.convertFile(draw('backdrop', 'backdrop'), 'docx');
  d = await read(docx);
  expect('the picture is anchored before the first line of text, so it stays on its page when the text runs over', d.xml.indexOf('<wp:anchor') >= 0 && d.xml.indexOf('<wp:anchor') < d.xml.indexOf('<w:t'));
  fs.rmSync(docx);

  console.log('a wide photo at the foot of a page, with its caption');
  [docx] = await convert.convertFile(draw('foot', 'foot'), 'docx');
  d = await read(docx);
  expect('the photo is placed on the page, so a taller paragraph above cannot push it to the next sheet', /<wp:anchor /.test(d.xml) && !/<wp:inline /.test(d.xml), (d.xml.match(/<wp:(anchor|inline)/) || [''])[0]);
  expect('so is the caption under it, still text', /<w:framePr [^>]*\/>[^]*?Caption of the photo/.test(d.xml), d.text);
  fs.rmSync(docx);

  console.log('a photo cropped to a circle');
  [docx] = await convert.convertFile(draw('circle', 'circle'), 'docx');
  d = await read(docx);
  expect('the real photo is kept, cropped and shown as an ellipse', /<a:srcRect /.test(d.xml) && /prst="ellipse"/.test(d.xml), (d.xml.match(/<pic:blipFill>.*?<\/pic:blipFill>/s) || [''])[0]);
  expect('it is there once, 100 x 100 pt', (d.xml.match(/<pic:pic>/g) || []).length === 1 && /<wp:extent cx="1270000" cy="1270000"\/>/.test(d.xml), (d.xml.match(/<wp:extent [^>]*>/g) || []).join(' '));
  fs.rmSync(docx);

  console.log('cards with a faint shadow');
  [docx] = await convert.convertFile(draw('cards', 'cards'), 'docx');
  d = await read(docx);
  expect('a transparent black shadow does not turn a card black', !/w:fill="000000"/.test(d.xml));
  expect('the text of the cards is there', !missingFrom(d.text, ['Card 1', 'Card 3', 'A figure for the card']).length);
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
    // a private TEMP, so a copy left by anything else running on this PC cannot be mistaken for ours
    const savedTemp = { TEMP: process.env.TEMP, TMP: process.env.TMP };
    process.env.TEMP = process.env.TMP = tmp.dir('ocr-temp');
    [docx] = await convert.convertFile(draw('scan', 'scan'), 'docx');
    const left = fs.readdirSync(os.tmpdir()).filter((n) => /^pomelo-ocr-.*\.pdf$/.test(n));
    Object.assign(process.env, savedTemp);
    d = await read(docx);
    const found = ['Quarterly Report', 'Revenue grew', 'team@example.com', 'A bullet that wraps'].filter((t) => squash(d.text.toLowerCase()).includes(squash(t.toLowerCase())));
    expect('the text of the scan is recognised and is real, editable text', found.length >= 3, `${found.length} of 4: ${d.text.slice(0, 120)}`);
    expect('and the temporary OCR copy of the PDF is deleted', left.length === 0, left.join(', '));
    fs.rmSync(docx);
  }

  console.log(failed() ? `\n${failed()} failed` : '\nall good');
  finish();
})().catch((e) => { console.error(e); finish(1); });

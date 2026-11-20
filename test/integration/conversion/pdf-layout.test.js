// SPDX-License-Identifier: AGPL-3.0-or-later
// PDF -> DOCX on small PDFs drawn here: the Word file must be editable (real paragraphs, lists and tables, no frames of loose
// lines), keep what the page looks like, and say plainly what is wrong with a PDF it cannot read. Needs the PDF engine
// (skipped without it); the scan test also needs the OCR component.   node test/integration/conversion/pdf-layout.test.js
// For real-world pages and a similarity score against the original, see test/fidelity/run.js.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const JSZip = require('jszip');
const convert = require('../../../src/features/conversion');

const { expect, failed } = require('../../support/expect');
const finish = require('../../support/finish');
const tmp = require('../../support/tmp');

// argv: out.pdf, then what to draw
const MAKE_PDF = `
import os, sys, pymupdf
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
if kind == "footer":                                # body text, and a footer near the bottom edge
    page = doc.new_page(width=595, height=842)
    for i in range(4):
        page.insert_text((60, 100 + i * 16), "Body line %d of the page" % (i + 1), fontname="helv", fontsize=11)
    page.insert_text((60, 815), "Footer of the page 1 / 2", fontname="helv", fontsize=8)
    doc.save(sys.argv[1]); sys.exit()
if kind == "report":                                # four pages with a running title from the second page on, a footer with the page number, a title, headings, a list and a caption
    for n in range(4):
        page = doc.new_page(width=595, height=842)
        if n:
            page.insert_text((60, 40), "Quarterly Review", fontname="helv", fontsize=9)
        page.insert_text((60, 810), "Ref. QR-2026-%d" % 7, fontname="helv", fontsize=9)
        page.insert_link({"kind": pymupdf.LINK_URI, "from": pymupdf.Rect(58, 800, 140, 813), "uri": "https://example.com/report"})
        page.insert_text((470, 810), "Page %d of 4" % (n + 1), fontname="helv", fontsize=9)
        if n == 0:
            page.insert_text((60, 120), "Annual Statement", fontname="hebo", fontsize=30)
        page.insert_text((60, 190), "Section %d" % (n + 1), fontname="hebo", fontsize=18)
        for i in range(3):
            page.insert_text((60, 220 + i * 14), "Ordinary body text, line %d on page %d." % (i + 1, n + 1), fontname="helv", fontsize=11)
        if n == 1:
            page.insert_text((60, 290), "•", fontname="helv", fontsize=11)
            page.insert_text((76, 290), "A list item that matters", fontname="helv", fontsize=11)
            page.insert_text((60, 330), "Figure 1. The plant at dusk.", fontname="helv", fontsize=9)
    doc.save(sys.argv[1]); sys.exit()
if kind == "columns":                               # two justified columns, the right one reaching the right edge of its cell
    page = doc.new_page(width=595, height=842)
    text = "Every request is read by two people before the panel decides whether a meeting will be needed for it, and the applicant hears from the office within a week of the decision. "
    page.insert_textbox(pymupdf.Rect(60, 100, 280, 200), text, fontname="helv", fontsize=10, align=3)
    page.insert_textbox(pymupdf.Rect(320, 107, 535, 207), text, fontname="helv", fontsize=10, align=3)
    doc.save(sys.argv[1]); sys.exit()
if kind == "flow":                                  # a title over two columns of running text, each of several paragraphs
    page = doc.new_page(width=595, height=842)
    page.insert_text((60, 80), "Findings of the review", fontname="hebo", fontsize=18)
    para = "Every request is read by two people before the panel decides whether a meeting will be needed for it, and the applicant hears from the office within a week of the decision. "
    for x0, tag in ((60, "Left"), (320, "Right")):
        y = 110
        for k in range(3):
            page.insert_textbox(pymupdf.Rect(x0, y, x0 + 215, y + 96), "%s column paragraph %d. %s" % (tag, k + 1, para), fontname="helv", fontsize=10, align=3)
            y += 110
    doc.save(sys.argv[1]); sys.exit()
if kind == "uneven":                                # two columns of running text, the right one shorter
    page = doc.new_page(width=595, height=842)
    para = "Every request is read by two people before the panel decides whether a meeting will be needed for it, and the applicant hears from the office within a week of the decision. "
    for x0, count in ((60, 3), (320, 2)):
        for k in range(count):
            page.insert_textbox(pymupdf.Rect(x0, 110 + k * 110, x0 + 215, 206 + k * 110), "Paragraph %d. %s" % (k + 1, para), fontname="helv", fontsize=10, align=3)
    doc.save(sys.argv[1]); sys.exit()
if kind == "equation":                              # two columns of running text, an equation with its number at the column's edge in the left one
    page = doc.new_page(width=595, height=842)
    para = "Every request is read by two people before the panel decides whether a meeting will be needed for it, and the applicant hears from the office within a week. "
    page.insert_textbox(pymupdf.Rect(60, 110, 280, 175), para, fontname="helv", fontsize=10, align=3)
    page.insert_text((100, 214), "x = y + z", fontname="helv", fontsize=10)
    page.insert_text((266, 214), "(3)", fontname="helv", fontsize=10)
    page.insert_textbox(pymupdf.Rect(60, 230, 280, 295), para, fontname="helv", fontsize=10, align=3)
    page.insert_textbox(pymupdf.Rect(320, 110, 535, 310), para * 4, fontname="helv", fontsize=10, align=3)
    doc.save(sys.argv[1]); sys.exit()
if kind == "tablecol":                              # two columns of running text, a ruled table inside the left one
    page = doc.new_page(width=595, height=842)
    para = "Every request is read by two people before the panel decides whether a meeting will be needed for it, and the applicant hears from the office within a week. "
    page.insert_textbox(pymupdf.Rect(60, 110, 280, 175), para, fontname="helv", fontsize=10, align=3)
    for r in range(3):
        for c in range(2):
            rect = pymupdf.Rect(60 + c * 100, 200 + r * 20, 160 + c * 100, 220 + r * 20)
            page.draw_rect(rect, color=(0.4, 0.4, 0.4), width=0.8)
            page.insert_text((rect.x0 + 6, rect.y0 + 14), "cell %d%d" % (r, c), fontname="helv", fontsize=9)
    page.insert_textbox(pymupdf.Rect(60, 280, 280, 345), para, fontname="helv", fontsize=10, align=3)
    page.insert_textbox(pymupdf.Rect(320, 110, 535, 360), para * 5, fontname="helv", fontsize=10, align=3)
    doc.save(sys.argv[1]); sys.exit()
if kind == "dropcap":                               # a large first letter beside the first three lines of a paragraph
    page = doc.new_page(width=595, height=842)
    page.insert_text((60, 134), "T", fontname="helv", fontsize=30)
    for i, t in enumerate(("he best views are free, but the", "guided sunrise hike is worth every", "cent and ends with a proper breakfast.")):
        page.insert_text((84, 110 + i * 12), t, fontname="helv", fontsize=10)
    for i, t in enumerate(("Wake early and walk down to the water while", "the light is still soft and the streets belong")):
        page.insert_text((60, 148 + i * 12), t, fontname="helv", fontsize=10)
    doc.save(sys.argv[1]); sys.exit()
if kind == "chart":                                 # a picture that two gridlines cross, with labels at the left
    page = doc.new_page(width=595, height=842)
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 60, 30), False)
    for yy in range(30):
        for xx in range(60):
            pix.set_pixel(xx, yy, (20 + xx * 3, 60 + yy * 4, 120))
    page.insert_image(pymupdf.Rect(100, 100, 400, 250), pixmap=pix, keep_proportion=False)
    for y, label in ((120, "96"), (190, "48")):
        page.draw_line((60, y), (535, y), color=(0.8, 0.8, 0.8), width=0.5)
        page.insert_text((62, y - 3), label, fontname="helv", fontsize=9)
    page.insert_text((60, 300), "Revenue by quarter", fontname="helv", fontsize=10)
    doc.save(sys.argv[1]); sys.exit()
if kind == "beside":                                # a photo with text wrapped round it
    page = doc.new_page(width=595, height=842)
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 40, 40), False)
    for yy in range(40):
        for xx in range(40):
            pix.set_pixel(xx, yy, (20 + xx * 3, 60 + yy * 3, 120))
    page.insert_image(pymupdf.Rect(60, 100, 160, 200), pixmap=pix)
    for i in range(6):
        page.insert_text((165, 110 + i * 15), "Text wrapped round the photo, line %d" % (i + 1), fontname="helv", fontsize=10)
    for i in range(3):
        page.insert_text((60, 225 + i * 15), "Text below the photo runs the full width of the column, line %d" % (i + 1), fontname="helv", fontsize=10)
    doc.save(sys.argv[1]); sys.exit()
if kind == "tall":                                  # a shaded panel more than half a page high
    page = doc.new_page(width=595, height=842)
    page.draw_rect(pymupdf.Rect(50, 100, 270, 600), color=(0.6, 0.6, 0.6), fill=(0.95, 0.95, 0.9))
    for i in range(3):
        page.insert_text((70, 130 + i * 20), "Text inside the panel, line %d" % (i + 1), fontname="helv", fontsize=11)
    doc.save(sys.argv[1]); sys.exit()
if kind == "unknownfont":                           # a font Windows does not have
    page = doc.new_page(width=595, height=842)
    buf = open(os.path.join(os.environ.get("WINDIR", "C:/Windows"), "Fonts", "arial.ttf"), "rb").read()
    page.insert_font(fontname="PomeloNoSuchSans", fontbuffer=buf)
    page.insert_text((60, 100), "Set in a font that is not installed", fontname="PomeloNoSuchSans", fontsize=12)
    doc.save(sys.argv[1]); sys.exit()
if kind == "centred":                              # a centred title on two lines of different widths
    page = doc.new_page(width=595, height=842)
    for i, t in enumerate(("A centred title that runs onto", "a second line")):
        w = pymupdf.get_text_length(t, fontname="hebo", fontsize=18)
        page.insert_text(((595 - w) / 2, 100 + i * 22), t, fontname="hebo", fontsize=18)
    page.insert_text((60, 200), "Body text under the title.", fontname="helv", fontsize=11)
    doc.save(sys.argv[1]); sys.exit()
if kind == "words":                                # lines that start with a word beginning in "o", and two real bullets
    page = doc.new_page(width=595, height=842)
    for i, t in enumerate(("The cost rose by a factor of two in the year,", "of the parts listed here only the first", "on the next line a word starts the same way", "or one more, and then the paragraph ends.")):
        page.insert_text((60, 100 + i * 14), t, fontname="helv", fontsize=11)
    for i, t in enumerate(("o A real bullet written as the letter o", "• A bullet glyph")):
        page.insert_text((60, 200 + i * 16), t, fontname="helv", fontsize=11)
    doc.save(sys.argv[1]); sys.exit()
if kind == "stamp":                                 # a word turned 30 degrees up to the right, in green across a red frame, on a page of running text
    page = doc.new_page(width=595, height=842)
    for i in range(6):
        page.insert_text((60, 100 + i * 18), "Ordinary body text line number %d of the page." % (i + 1), fontname="helv", fontsize=11)
    page.draw_rect(pymupdf.Rect(150, 300, 450, 400), color=(0.8, 0.1, 0.1), width=2)
    page.insert_text((180, 370), "APPROVED", fontname="hebo", fontsize=30, color=(0, 0.6, 0), morph=(pymupdf.Point(180, 370), pymupdf.Matrix(30)))
    page.insert_text((60, 500), "Text after the stamp.", fontname="helv", fontsize=11)
    doc.save(sys.argv[1]); sys.exit()
if kind == "watermark":                             # a large pale word turned across running text, the text black; with an extra argument: another angle, size and place
    page = doc.new_page(width=595, height=842)
    other = len(sys.argv) > 3
    for i in range(6):
        page.insert_text((60, 150 + i * 16), "Running paragraph number %d goes straight across the whole width of the sheet." % (i + 1), fontname="helv", fontsize=12)
    at, angle, size = (pymupdf.Point(90, 330), 20, 90) if other else (pymupdf.Point(100, 330), 45, 120)
    page.insert_text(at, "DRAFT", fontname="hebo", fontsize=size, color=(0.95, 0.75, 0.75), morph=(at, pymupdf.Matrix(angle)))
    doc.save(sys.argv[1]); sys.exit()
if kind == "sigline":                               # a short line to the right of its label, a stroke or (with an extra argument) a thin bar
    page = doc.new_page(width=595, height=842)
    bar = len(sys.argv) > 3
    for i in range(3):
        page.insert_text((60, 100 + i * 14), "Ordinary line of text above the signature block, number %d." % i, fontname="helv", fontsize=11)
    page.insert_text((60, 300), "Signature", fontname="helv", fontsize=11)
    if bar:
        page.draw_rect(pymupdf.Rect(130, 300, 290, 301.2), color=None, fill=(0.2, 0.4, 0.6))
    else:
        page.draw_line((130, 301), (270, 301), color=(0.4, 0.2, 0.0), width=1.0)
    doc.save(sys.argv[1]); sys.exit()
if kind == "callout":                               # a filled box with a bar along its left edge (with an extra argument: along its top edge, other colours; or a bar beside the box, not over it)
    page = doc.new_page(width=595, height=842)
    top = len(sys.argv) > 3 and sys.argv[3] == "top"
    beside = len(sys.argv) > 3 and sys.argv[3] == "beside"
    for i in range(3):
        page.insert_text((60, 100 + i * 14), "Ordinary line of text above the callout, number %d." % i, fontname="helv", fontsize=11)
    page.draw_rect(pymupdf.Rect(64 if beside else 60, 300, 420, 360), color=None, fill=(0.9, 0.95, 0.98) if top else (0.95, 0.95, 0.8))
    page.draw_rect(pymupdf.Rect(60, 300, 420, 303) if top else pymupdf.Rect(60, 300, 64, 360), color=None, fill=(0.2, 0.2, 0.6) if top else (0.8, 0.4, 0.0))
    page.insert_text((75, 325), "Note: the callout text sits inside the box.", fontname="helv", fontsize=11)
    page.insert_text((75, 342), "A second line of the callout.", fontname="helv", fontsize=11)
    doc.save(sys.argv[1]); sys.exit()
if kind == "caption":                               # a photo with a dark band drawn over its foot (with an extra argument: over its top) and a white caption on the band
    page = doc.new_page(width=595, height=842)
    top = len(sys.argv) > 3
    for i in range(3):
        page.insert_text((60, 100 + i * 14), "Ordinary line of text above the photo, number %d." % i, fontname="helv", fontsize=11)
    photo = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 160, 100), False)
    photo.clear_with(225)
    page.insert_image(pymupdf.Rect(60, 200, 400, 400), stream=photo.tobytes("jpeg"))
    page.draw_rect(pymupdf.Rect(60, 200, 400, 230) if top else pymupdf.Rect(60, 370, 400, 400), color=None, fill=(0.4, 0.0, 0.0) if top else (0.1, 0.15, 0.3))
    page.insert_text((70, 220 if top else 390), "Caption on the band", fontname="helv", fontsize=11, color=(1, 1, 1))
    doc.save(sys.argv[1]); sys.exit()
if kind == "rounded":                               # a rounded filled box and a square one, each with text (with an extra argument: a rounded outline only)
    page = doc.new_page(width=595, height=842)
    outline = len(sys.argv) > 3
    for i in range(3):
        page.insert_text((60, 100 + i * 14), "Ordinary line of text above the boxes, number %d." % i, fontname="helv", fontsize=11)
    if outline:
        page.draw_rect(pymupdf.Rect(60, 300, 400, 350), color=(0.2, 0.2, 0.6), fill=None, width=2, radius=0.3)
    else:
        page.draw_rect(pymupdf.Rect(60, 300, 400, 360), color=None, fill=(0.8, 0.8, 1.0), radius=0.25)
    page.insert_text((75, 330), "Text inside the rounded box.", fontname="helv", fontsize=11)
    page.draw_rect(pymupdf.Rect(60, 420, 400, 480), color=None, fill=(1.0, 0.8, 0.8))
    page.insert_text((75, 450), "Text inside the square box.", fontname="helv", fontsize=11)
    doc.save(sys.argv[1]); sys.exit()
if kind == "faint":                                 # a see-through word over black text, and a see-through box on paper with text in it (with an extra argument: other opacities, colours and size)
    page = doc.new_page(width=595, height=842)
    other = len(sys.argv) > 3
    size = 14 if other else 24
    page.insert_text((60, 100), "Black text that a pale word crosses", fontname="helv", fontsize=size)
    page.insert_text((60, 100), "STAMP", fontname="hebo", fontsize=size, color=(0.2, 0.2, 0.6) if other else (1, 0, 0), fill_opacity=0.6 if other else 0.3)
    page.draw_rect(pymupdf.Rect(60, 300, 400, 360), color=None, fill=(0.2, 0.4, 0.6) if other else (0, 0, 1), fill_opacity=0.4 if other else 0.5)
    page.insert_text((75, 335), "Text in the tinted box", fontname="helv", fontsize=11)
    doc.save(sys.argv[1]); sys.exit()
if kind == "veil":                                  # a very faint box over running text (with an extra argument: another colour, opacity, size and place)
    page = doc.new_page(width=595, height=842)
    other = len(sys.argv) > 3
    size = 14 if other else 12
    for i in range(6):
        page.insert_text((60, 100 + i * 20), "Running paragraph number %d goes straight across the whole width of the sheet." % (i + 1), fontname="helv", fontsize=size)
    box = pymupdf.Rect(50, 128, 480, 206) if other else pymupdf.Rect(50, 140, 420, 200)
    page.draw_rect(box, color=None, fill=(0.2, 0.3, 0.9) if other else (1, 0.8, 0), fill_opacity=0.2 if other else 0.15)
    doc.save(sys.argv[1]); sys.exit()
if kind == "clipmode":                              # text in the invisible mode beside text in a clip mode (with an extra argument: all on one line, in another size)
    page = doc.new_page(width=595, height=842)
    other = len(sys.argv) > 3
    size = 24 if other else 40
    if other:
        for word, x, mode in (("Plain", 60, 0), ("Invisible", 130, 3), ("Clipped", 250, 7), ("Closing", 360, 0)):
            page.insert_text((x, 200), word, fontname="hebo", fontsize=size, render_mode=mode)
    else:
        page.insert_text((60, 100), "Plain visible line", fontname="helv", fontsize=14)
        page.insert_text((60, 160), "Invisible mode", fontname="helv", fontsize=size, render_mode=3)
        page.insert_text((60, 240), "Clipped mode", fontname="hebo", fontsize=size, render_mode=7)
    doc.save(sys.argv[1]); sys.exit()
if kind == "leaders":                               # contents lines: a title, a run of spaced dots and a page number, in one piece (with an extra argument: solid dots as a piece of their own, another size)
    page = doc.new_page(width=595, height=842)
    other = len(sys.argv) > 3
    size = 10 if other else 12
    for i, (title, number) in enumerate((("Introduction", "3"), ("Methods and materials", "14"), ("Results", "127"))):
        y = 120 + i * 24
        wide = pymupdf.get_text_length(title, fontname="helv", fontsize=size)
        if other:
            page.insert_text((60, y), title, fontname="helv", fontsize=size)
            dots = "." * int((460 - 60 - wide) / pymupdf.get_text_length(".", fontname="helv", fontsize=size))
            page.insert_text((60 + wide + 6, y), dots + " " + number, fontname="helv", fontsize=size)
        else:
            dots = ". " * int((470 - 60 - wide) / pymupdf.get_text_length(". ", fontname="helv", fontsize=size))
            page.insert_text((60, y), title + " " + dots + number, fontname="helv", fontsize=size)
    doc.save(sys.argv[1]); sys.exit()
if kind == "stroke":                                # menu lines: a name, a dotted stroke along the baseline and a price (with an extra argument: a dashed one, another size)
    page = doc.new_page(width=595, height=842)
    other = len(sys.argv) > 3
    size = 10 if other else 12
    for i, (name, price) in enumerate((("Tomato soup", "4.50"), ("Grilled halloumi with herbs", "9.00"), ("Lemon tart", "5.25"))):
        y = 120 + i * 24
        wide = pymupdf.get_text_length(name, fontname="helv", fontsize=size)
        page.insert_text((60, y), name, fontname="helv", fontsize=size)
        page.insert_text((450, y), price, fontname="helv", fontsize=size)
        page.draw_line((60 + wide + 6, y), (444, y), color=(0.3, 0.3, 0.3), width=1.0, dashes="[4 3] 0" if other else "[1 3] 0")
    doc.save(sys.argv[1]); sys.exit()
if kind == "huge":                                  # a page larger than Word's 22 inches, portrait (with an extra argument: a long banner), with a link on a line of its text
    banner = len(sys.argv) > 3
    page = doc.new_page(width=3000 if banner else 1700, height=400 if banner else 2400)
    size = 60 if banner else 40
    page.insert_text((60, 150), "Visit the example site", fontname="helv", fontsize=size)
    page.insert_link({"kind": pymupdf.LINK_URI, "from": pymupdf.Rect(60, 150 - size, 60 + 12 * size, 150 + size / 4), "uri": "https://example.com/"})
    page.insert_text((60, 300), "A second line of the page that Word must still hold as text", fontname="helv", fontsize=size)
    doc.save(sys.argv[1]); sys.exit()
if kind == "spaced":                                # a word whose letters are set apart one by one (with an extra argument: another size and spacing), among ordinary lines
    page = doc.new_page(width=595, height=842)
    size, extra = (10, 0.6) if len(sys.argv) > 3 else (14, 1.0)
    for i in range(3):
        page.insert_text((60, 100 + i * 14), "Ordinary line of running text number %d." % i, fontname="helv", fontsize=11)
    buf = open(os.path.join(os.environ.get("WINDIR", "C:/Windows"), "Fonts", "arial.ttf"), "rb").read()
    page.insert_font(fontname="Trk", fontbuffer=buf, set_simple=True)
    font = pymupdf.Font(fontbuffer=buf)
    x = 60
    for ch in "TRACKED":
        page.insert_text((x, 200), ch, fontname="Trk", fontsize=size)
        x += font.text_length(ch, fontsize=size) + extra
    page.insert_text((60, 260), "A closing ordinary line of text.", fontname="helv", fontsize=11)
    doc.save(sys.argv[1]); sys.exit()
if kind == "marker":                                # short words after a bullet (with an extra argument: after a number, in another size)
    page = doc.new_page(width=595, height=842)
    other = len(sys.argv) > 3
    buf = open(os.path.join(os.environ.get("WINDIR", "C:/Windows"), "Fonts", "arial.ttf"), "rb").read()
    page.insert_font(fontname="Trk", fontbuffer=buf, set_simple=True)
    for i, word in enumerate(("Gym", "Pool", "Spa")):
        page.insert_text((60, 100 + i * 16), ("%d. %s" % (i + 1, word)) if other else ("• " + word), fontname="Trk", fontsize=12 if other else 11)
    doc.save(sys.argv[1]); sys.exit()
if kind == "captions":                              # a photo with a one-line caption and a two-line caption on it (with an extra argument: other places and sizes)
    page = doc.new_page(width=595, height=842)
    other = len(sys.argv) > 3
    for i in range(3):
        page.insert_text((60, 100 + i * 14), "Ordinary line of text above the photo, number %d." % i, fontname="helv", fontsize=11)
    photo = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 160, 100), False)
    photo.clear_with(60)
    page.insert_image(pymupdf.Rect(60, 200, 500, 420), stream=photo.tobytes("jpeg"))
    size = 13 if other else 11
    page.insert_text((100, 260), "One line caption", fontname="helv", fontsize=size, color=(1, 1, 1))
    page.insert_text((300 if other else 100, 340), "First of two", fontname="helv", fontsize=size, color=(1, 1, 1))
    page.insert_text((300 if other else 100, 340 + 1.3 * size), "Second of two", fontname="helv", fontsize=size, color=(1, 1, 1))
    doc.save(sys.argv[1]); sys.exit()
if kind == "footrow":                               # a title at the left and a page number at the right in the last 30 pt of the sheet, close under the text (with an extra argument: a letter-size sheet)
    letter = len(sys.argv) > 3
    height = 792 if letter else 842
    page = doc.new_page(width=595, height=height)
    for i in range(42 if letter else 45):
        page.insert_text((60, 100 + i * 16), "Running line of the report, number %d, which fills the page." % i, fontname="helv", fontsize=11)
    page.insert_text((60, height - 8), "Annual report", fontname="helv", fontsize=8)
    page.insert_text((480, height - 8), "Page 7", fontname="helv", fontsize=8)
    doc.save(sys.argv[1]); sys.exit()
if kind == "fieldfoot":                             # a page of text that fills the sheet, check boxes in it, and a title and a number at the foot (with an extra argument: Letter paper and a text field as well)
    other = len(sys.argv) > 3
    height = 792 if other else 842
    page = doc.new_page(width=612 if other else 595, height=height)
    for i in range(41 if other else 46):
        page.insert_text((60, 60 + i * 16), "Running line of the form, number %d, which fills the page from top to bottom." % i, fontname="helv", fontsize=11)
    for i in range(2):
        w = pymupdf.Widget()
        w.field_type, w.field_name, w.rect = pymupdf.PDF_WIDGET_TYPE_CHECKBOX, "box%d" % i, pymupdf.Rect(480 + i * 40, 100, 492 + i * 40, 112)
        w.border_color, w.border_width = (0, 0, 0), 0.8
        page.add_widget(w)
    if other:
        w = pymupdf.Widget()
        w.field_type, w.field_name, w.rect, w.field_value = pymupdf.PDF_WIDGET_TYPE_TEXT, "name", pymupdf.Rect(420, 200, 560, 216), "Typed in"
        w.border_color, w.border_width = (0, 0, 0), 0.8
        page.add_widget(w)
    page.insert_text((60, height - 8), "Annual report", fontname="helv", fontsize=8)
    page.insert_text((480, height - 8), "Page 7", fontname="helv", fontsize=8)
    doc.save(sys.argv[1]); sys.exit()
if kind == "microtext":                             # the same label, set very small on a coloured bar, three times at three heights (with an extra argument: smaller, dark on yellow)
    other = len(sys.argv) > 3
    page = doc.new_page(width=595, height=842)
    for i in range(3):
        page.insert_text((60, 100 + i * 14), "Ordinary line of running text number %d." % i, fontname="helv", fontsize=11)
    for y in (300, 450, 600):
        page.draw_rect(pymupdf.Rect(50, y - 8, 90, y + 10), color=None, fill=(1, 0.9, 0.3) if other else (0.1, 0.3, 0.7))
        page.insert_text((53, y), "Gate in: seal and", fontname="helv", fontsize=1.5 if other else 2, color=(0, 0, 0) if other else (1, 1, 1))
        page.insert_text((53, y + 3), "damage check", fontname="helv", fontsize=1.5 if other else 2, color=(0, 0, 0) if other else (1, 1, 1))
    doc.save(sys.argv[1]); sys.exit()
if kind == "fullbar":                               # text at the left and a coloured bar the full height of the sheet at the right, with a number at its foot (with an extra argument: a landscape slide)
    other = len(sys.argv) > 3
    w, h = (960, 540) if other else (595, 842)
    page = doc.new_page(width=w, height=h)
    page.draw_rect(pymupdf.Rect(w - 70, 0, w, h), color=None, fill=(0.0, 0.13, 0.38))
    page.insert_text((60, 70), "Agenda", fontname="helv", fontsize=28)
    for i in range(5):
        page.insert_text((60, 130 + i * 30), "Item number %d of the agenda" % (i + 1), fontname="helv", fontsize=16)
    page.insert_text((w - 40, h - 14), "2", fontname="helv", fontsize=8, color=(0.7, 0.7, 0.7))
    doc.save(sys.argv[1]); sys.exit()
if kind == "footnear":                              # body text down to the last tenth of the sheet and a small line 36 pt from the foot (with an extra argument: "a4", A4 and 40 pt, or "runon", body text that goes on to the foot and no small line)
    mode = sys.argv[3] if len(sys.argv) > 3 else ""
    other = mode == "a4"
    w, h = (595, 842) if other else (612, 792)
    page = doc.new_page(width=w, height=h)
    for i in range(50 if mode == "runon" else int((h - 120) / 14) + 1):
        page.insert_text((60, (67 if mode == "runon" else 60) + i * 14), "Running line of the form, number %d, which fills the page." % i, fontname="helv", fontsize=10)
    if mode != "runon":
        page.insert_text((60, h - (38 if other else 34)), "Cat. No. 10231X", fontname="helv", fontsize=7)
        page.insert_text((w - 160, h - (38 if other else 34)), "Form W-9 (Rev. 3-2024)", fontname="helv", fontsize=7)
    doc.save(sys.argv[1]); sys.exit()
if kind == "sheetgrid":                            # a spreadsheet page: a ruled grid of 30 rows and 5 columns, a header band that runs on past the grid and off the sheet, every third row shaded (extra argument: the grid as thin filled rectangles, on Letter paper)
    other = len(sys.argv) > 3
    page = doc.new_page(width=612 if other else 595, height=792 if other else 842)
    xs, top, row = [50, 140, 230, 320, 410, 500], 60, 14
    page.draw_rect(pymupdf.Rect(50, top, 900, top + row), color=None, fill=(0.0, 0.13, 0.38))
    for r in range(1, 30):
        if r % 3 == 0:
            page.draw_rect(pymupdf.Rect(50, top + r * row, 500, top + (r + 1) * row), color=None, fill=(0.85, 0.9, 0.95))
    for r in range(30):
        for c in range(5):
            text = ("Cost centre", "Region", "Budget", "Actual", "Variance")[c] if r == 0 else ("CC-%d" % (4100 + r), "Region %d" % (r % 4), "%d,%03d" % (r * 7, r * 13), "%d,%03d" % (r * 6, r * 11), "%d" % (r * 3))[c]
            page.insert_text((xs[c] + 3, top + r * row + 10), text, fontname="helv", fontsize=8, color=(1, 1, 1) if r == 0 else (0, 0, 0))
    for r in range(31):
        y = top + r * row
        if other:
            page.draw_rect(pymupdf.Rect(50, y - 0.25, 500, y + 0.25), color=None, fill=(0.6, 0.6, 0.6))
        else:
            page.draw_line((50, y), (500, y), color=(0.6, 0.6, 0.6), width=0.5)
    for x in xs:
        if other:
            page.draw_rect(pymupdf.Rect(x - 0.25, top, x + 0.25, top + 30 * row), color=None, fill=(0.6, 0.6, 0.6))
        else:
            page.draw_line((x, top), (x, top + 30 * row), color=(0.6, 0.6, 0.6), width=0.5)
    doc.save(sys.argv[1]); sys.exit()
if kind == "shadedrows":                            # a ledger of narrow columns whose texts nearly touch, every second row shaded by one rectangle across the first three columns (extra argument: wider columns and a larger size)
    other = len(sys.argv) > 3
    page = doc.new_page(width=595, height=842)
    size, xs, top, row = (10, [50, 96, 176, 256, 336], 60, 16) if other else (8, [50, 86, 150, 210, 290], 60, 13)
    for r in range(16):
        y = top + r * row
        if r % 2 == 1:
            page.draw_rect(pymupdf.Rect(xs[0], y, xs[3], y + row), color=None, fill=(0.95, 0.95, 0.95))
        page.draw_rect(pymupdf.Rect(xs[3], y, xs[4], y + row), color=None, fill=(0.9, 0.95, 0.6 + r / 60))
        bar = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 10, 4), False)
        bar.clear_with(120)
        page.insert_image(pymupdf.Rect(xs[3] + 1, y + 2, xs[3] + 1 + 3 + 2 * r, y + row - 2), pixmap=bar)
        page.draw_line((xs[0], y), (xs[4], y), color=(0.6, 0.6, 0.6), width=0.5)
        if other:
            page.draw_rect(pymupdf.Rect(xs[0], y - 0.25, xs[4], y + 0.25), color=None, fill=(0.6, 0.6, 0.6))
        cells =("CC-%d" % (4100 + r), ("Northern", "Sabah", "East Coast", "Sarawak")[r % 4], "L. Wong", "%d,%03d" % (r * 7, r * 13))
        for c in range(4):
            page.insert_text((xs[c] + 1, y + row - 3.5), cells[c], fontname="helv", fontsize=size)
    for x in xs:
        page.draw_line((x, top), (x, top + 16 * row), color=(0.6, 0.6, 0.6), width=0.5)
    page.draw_line((xs[0], top + 16 * row), (xs[4], top + 16 * row), color=(0.6, 0.6, 0.6), width=0.5)
    doc.save(sys.argv[1]); sys.exit()
if kind == "chevrons":                              # three filled chevrons down the left, white labels on them, white outlined rounded boxes beside them, only two holding text, all inside a hairline frame (extra argument: other colours and sizes)
    other = len(sys.argv) > 3
    page = doc.new_page(width=720 if other else 960, height=405 if other else 540)
    fill = (0.8, 0.4, 0.1) if other else (0.27, 0.45, 0.77)
    page.insert_text((40, 60), "How a container moves", fontname="helv", fontsize=24)
    k = 0.75 if other else 1.0
    page.draw_rect(pymupdf.Rect(37.3 * k, 156.7 * k, 920.5 * k, 380.6 * k), color=(0, 0, 0), width=0.14)
    for i in range(3):
        y = (160 + i * 68) * k
        page.draw_polyline([(40 * k, y), (69.4 * k, y + 12 * k), (98.8 * k, y), (98.8 * k, y + 72 * k), (69.4 * k, y + 84 * k), (40 * k, y + 72 * k)], fill=fill, color=fill, closePath=True)
        page.insert_text((46 * k, y + 44 * k), ("Gate in", "Vessel out", "Yard stack")[i], fontname="helv", fontsize=6 * k, color=(1, 1, 1))
        page.draw_rect(pymupdf.Rect(98.8 * k, y, 920 * k, y + 54.6 * k), color=fill, fill=(1, 1, 1), radius=0.2)
    page.insert_text((110 * k, 190 * k), "Quay: crane moves 28 per hour", fontname="helv", fontsize=14 * k)
    page.insert_text((110 * k, 258 * k), "Gate out: release by customs", fontname="helv", fontsize=14 * k)
    doc.save(sys.argv[1]); sys.exit()
if kind == "panel":                                 # running text and a small outlined panel of figures at the foot of the right column, as a climate chart is (extra argument: A4 paper and a larger panel)
    other = len(sys.argv) > 3
    w, h = (595, 842) if other else (612, 792)
    page = doc.new_page(width=w, height=h)
    for i in range(34):
        page.insert_text((50, 60 + i * 14), "Ordinary line of running text number %d which fills the left of the page." % i, fontname="helv", fontsize=10)
    x0, y0, side = (w - 200, h - 330, 150) if other else (w - 190, h - 290, 140)
    page.draw_rect(pymupdf.Rect(x0 - 8, y0 - 8, x0 + side + 40, y0 + 190), color=(0.8, 0.8, 0.8), width=0.8)
    for c in range(12):
        x = x0 + c * (side + 20) / 12
        page.insert_text((x, y0 + 10), "JFMAMJJASOND"[c], fontname="helv", fontsize=6)
        for r in range(3):
            page.insert_text((x, y0 + 30 + r * 40), "%d" % (20 + c + r * 5), fontname="helv", fontsize=6)
        page.draw_rect(pymupdf.Rect(x, y0 + 60 - c, x + 5, y0 + 80), color=None, fill=(0.3, 0.5, 0.8))
    doc.save(sys.argv[1]); sys.exit()
if kind == "bars":                                  # a column chart on a page of text: three bars of one colour drawn as one path, a second series, gridlines and labels above the bars (extra argument: each bar as a closed run of lines, other colours)
    other = len(sys.argv) > 3
    page = doc.new_page(width=595, height=842)
    for i in range(3):
        page.insert_text((60, 80 + i * 14), "Ordinary line of running text number %d above the chart." % i, fontname="helv", fontsize=10)
    for y in (200, 240, 280, 320):
        page.draw_line((70, y), (400, y), color=(0.85, 0.85, 0.85), width=0.5)
    series = ((0.9, 0.5, 0.2) if not other else (0.2, 0.6, 0.3), (0.27, 0.45, 0.77))
    shape = page.new_shape()
    for i, top in enumerate((230, 215, 250)):
        x = 100 + i * 100
        if other:
            shape.draw_polyline([(x + 30, top), (x + 60, top), (x + 60, 340), (x + 30, 340)])
            shape.draw_line((x + 30, 340), (x + 30, top))
        else:
            shape.draw_rect(pymupdf.Rect(x + 30, top, x + 60, 340))
    shape.finish(fill=series[0], color=None, closePath=other)
    shape.commit()
    for i, top in enumerate((250, 240, 260)):
        page.draw_rect(pymupdf.Rect(100 + i * 100, top, 130 + i * 100, 340), color=None, fill=series[1])
        page.insert_text((105 + i * 100, top - 6), "%d" % (45800 + i * 3100), fontname="helv", fontsize=7)
    page.insert_text((60, 420), "A line of running text below the chart.", fontname="helv", fontsize=10)
    doc.save(sys.argv[1]); sys.exit()
if kind == "clipped":                               # a long title in a cell that is narrower than it: the page's clip path cuts the title off (extra argument: another size, place and width, or "edge": no clip path, the title runs over the foot of the sheet)
    edge = len(sys.argv) > 3 and sys.argv[3] == "edge"
    other = len(sys.argv) > 3 and not edge
    page = doc.new_page(width=595, height=842)
    size, x, y, wide = (9, 80, 300, 60) if other else (12, 60, 841 if edge else 100, 100)
    page.insert_text((x, y), "Harbourline Logistics Berhad: cost centre ledger", fontname="helv", fontsize=size)
    if not edge:
        page.clean_contents()
        xref = page.get_contents()[0]
        clip = b"q %d %d %d %d re W n\\n" % (x, 842 - y - size, wide, size * 1.5)
        doc.update_stream(xref, clip + doc.xref_stream(xref) + b"\\nQ\\n")
    page.insert_text((60, 500), "An ordinary line below the title.", fontname="helv", fontsize=11)
    doc.save(sys.argv[1]); sys.exit()
if kind == "footrule":                              # text and a long rule below all of it (with an extra argument: the rule as a thin bar, nearer the text)
    page = doc.new_page(width=595, height=842)
    bar = len(sys.argv) > 3
    for i in range(8):
        page.insert_text((60, 100 + i * 16), "Running line of the report, number %d, above the rule." % i, fontname="helv", fontsize=11)
    y = 400 if bar else 800
    if bar:
        page.draw_rect(pymupdf.Rect(40, y, 555, y + 1.2), color=None, fill=(0.4, 0.4, 0.5))
    else:
        page.draw_line((40, y), (555, y), color=(0.8, 0.8, 0.85), width=0.75)
    doc.save(sys.argv[1]); sys.exit()
if kind == "letterhead":                            # a letter with a logo at the top, a two-line address and paragraphs (with an extra argument: other sizes)
    page = doc.new_page(width=595, height=842)
    other = len(sys.argv) > 3
    size = 12 if other else 11
    logo = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 60, 60), False)
    logo.clear_with(90)
    page.insert_image(pymupdf.Rect(50, 40, 110, 100), stream=logo.tobytes("png"))
    page.insert_text((130, 60), "Harbour and Sons Ltd", fontname="hebo", fontsize=14)
    page.insert_text((130, 76), "12 Quay Street, Portside", fontname="helv", fontsize=9)
    page.insert_text((130, 88), "Telephone 020 5550 0142", fontname="helv", fontsize=9)
    for i in range(12):
        page.insert_text((50, 150 + i * size * 1.4), "Dear customer, this paragraph of the letter runs across the page and on to line %d of it." % (i + 1), fontname="helv", fontsize=size)
    doc.save(sys.argv[1]); sys.exit()
if kind == "stripedrows":                           # thirty rows of figures, every other row on a shaded band that spans the page, no lines (with an extra argument: other size, colour and band)
    page = doc.new_page(width=595, height=842)
    other = len(sys.argv) > 3
    size, pitch = (9, 19) if other else (11, 22)
    for i in range(40 if other else 30):
        y = 80 + i * pitch
        if i % 2 == 0:
            page.draw_rect(pymupdf.Rect(40, y - pitch + 6, 555, y + 6), color=None, fill=(0.85, 0.9, 0.8) if other else (0.94, 0.95, 0.97))
        for j, x in enumerate((50, 200, 330, 450)):
            page.insert_text((x, y), ("Item %d" % i, "Units %d" % (i * 3), "Cost %d.50" % (i + 10), "Total %d" % (i * 7))[j], fontname="helv", fontsize=size)
    doc.save(sys.argv[1]); sys.exit()
if kind == "ruledpaper":                            # running text inside rules down both sides and along the foot: the rules are one figure whose box covers the sheet and whose ink does not (with an extra argument: another pitch and place)
    page = doc.new_page(width=595, height=842)
    other = len(sys.argv) > 3
    pitch, left, right = (18, 70, 540) if other else (24, 100, 580)
    for i in range(28):
        page.insert_text((left + 6, 80 + i * pitch), "Line %d of the ruled page runs across the sheet from the left edge to the right edge." % (i + 1), fontname="helv", fontsize=9)
    page.draw_line((left, 10), (left, 800), color=(0, 0, 0), width=1)
    page.draw_line((right, 10), (right, 800), color=(0, 0, 0), width=1)
    page.draw_line((left, 780), (right, 780), color=(0, 0, 0), width=1)
    doc.save(sys.argv[1]); sys.exit()
if kind == "mathpage":                              # paragraphs of running text and rows of short pieces of an equation, with a small picture (with an extra argument: other size)
    page = doc.new_page(width=595, height=842)
    size = 10 if len(sys.argv) > 3 else 11
    pic = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 60, 60), False)
    pic.clear_with(120)
    page.insert_image(pymupdf.Rect(450, 40, 510, 100), stream=pic.tobytes("png"))
    y = 120
    for p in range(3):
        for i in range(5):
            page.insert_text((72, y), "Paragraph %d line %d holds a sentence that fills the width of the page." % (p + 1, i + 1), fontname="helv", fontsize=size)
            y += 1.4 * size
        y += 8
        for r in range(6):
            for x, t in zip((100, 150, 200, 290, 420), ("E%d" % (p * 6 + r), "=", "m", "c2", "(%d)" % (p * 6 + r + 1))):
                page.insert_text((x, y), t, fontname="helv", fontsize=size)
            y += 1.8 * size
        y += 8
    doc.save(sys.argv[1]); sys.exit()
if kind == "examgrid":                              # a box and a ruled grid of short labels that touch, with a sentence of instructions inside both, on a page of plain text (with an extra argument: other size)
    page = doc.new_page(width=595, height=842)
    size = 10 if len(sys.argv) > 3 else 9
    for i in range(8):
        page.insert_text((50, 70 + i * 14), "Plain text of the exam paper runs across the page, line %d." % (i + 1), fontname="helv", fontsize=size)
    page.draw_rect(pymupdf.Rect(50, 363, 420, 391), color=(0, 0, 0), width=1)
    page.draw_rect(pymupdf.Rect(397, 397, 533, 437), color=None, fill=(0.9, 0.91, 0.92))
    for k in range(11):
        page.draw_line((397, 397 + k * 19.8), (533, 397 + k * 19.8), color=(0, 0, 0), width=0.7)
    for x in (397, 476, 533):
        page.draw_line((x, 397), (x, 615), color=(0, 0, 0), width=0.7)
    page.insert_text((410, 412), "Question", fontname="hebo", fontsize=size)
    page.insert_text((490, 412), "Mark", fontname="hebo", fontsize=size)
    for k in range(8):
        page.insert_text((430, 450 + k * 19.8), str(k + 1), fontname="helv", fontsize=size)
    page.insert_text((55, 430), "Instructions", fontname="hebo", fontsize=size)
    page.insert_text((55, 450), "Use black ink or black ball-point pen. Draw diagrams in pencil.", fontname="helv", fontsize=size)
    doc.save(sys.argv[1]); sys.exit()
if kind == "chartlabels":                           # a line chart with its axis labels on a page of plain text (with an extra argument: other labels and size)
    page = doc.new_page(width=595, height=842)
    other = len(sys.argv) > 3
    size = 10 if other else 9
    for i in range(20):
        page.insert_text((60, 60 + i * 13), "Plain text above the chart runs across the page, line %d of the report." % (i + 1), fontname="helv", fontsize=9)
    page.draw_line((120, 400), (120, 580), color=(0, 0, 0), width=1)
    page.draw_line((120, 580), (420, 580), color=(0, 0, 0), width=1)
    points = [(120, 560), (180, 520), (240, 540), (300, 470), (360, 440), (420, 420)]
    for a, b in zip(points, points[1:]):
        page.draw_line(a, b, color=(0.8, 0.1, 0.1), width=2)
    for k, v in enumerate(("0", "5", "10", "15", "20") if other else ("0", "50", "100", "150", "200")):
        page.insert_text((125, 556 - k * 35), v, fontname="helv", fontsize=size)
    for k, m in enumerate(("Q1", "Q2", "Q3", "Q4", "Q5", "Q6") if other else ("Jan", "Feb", "Mar", "Apr", "May", "Jun")):
        page.insert_text((140 + k * 45, 574), m, fontname="helv", fontsize=size)
    doc.save(sys.argv[1]); sys.exit()
if kind == "wordmark":                              # a mark drawn in vector next to its name on one line, then a paragraph (with an extra argument: a taller mark and another size)
    page = doc.new_page(width=595, height=842)
    other = len(sys.argv) > 3
    page.draw_oval(pymupdf.Rect(68, 43, 102, 90 if other else 81), color=None, fill=(0.2, 0.5, 0.35))
    page.draw_line((85, 47), (85, 86 if other else 77), color=(1, 1, 1), width=1)
    page.insert_text((104, 70 if other else 66), "Verdant and Co", fontname="hebo", fontsize=16 if other else 14)
    for i in range(10):
        page.insert_text((68, 160 + i * 15), "Dear customer, this paragraph of the letter runs across the page and on to line %d of it." % (i + 1), fontname="helv", fontsize=11)
    doc.save(sys.argv[1]); sys.exit()
if kind == "fragments":                             # rows of pieces of mathematics placed at points, with a fraction bar and a small picture, among a few lines of text (with an extra argument: other places)
    page = doc.new_page(width=595, height=842)
    other = len(sys.argv) > 3
    pic = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 60, 30), False)
    pic.clear_with(150)
    page.insert_image(pymupdf.Rect(480, 40, 540, 70), stream=pic.tobytes("png"))
    for i in range(3):
        page.insert_text((72, 70 + i * 14), "A sentence of the thesis that runs across the whole width of the page, line %d." % (i + 1), fontname="helv", fontsize=11)
    for r in range(12):
        y = 160 + r * 32
        for x, t in zip((90, 130, 180, 250, 330, 420) if not other else (100, 160, 205, 300, 360, 450), ("x", "=", "a", "+", "b", "%d" % r)):
            page.insert_text((x, y), t, fontname="helv", fontsize=11)
        page.draw_line((170, y - 14), (230, y - 14), color=(0, 0, 0), width=0.8)
    doc.save(sys.argv[1]); sys.exit()
if kind == "beyond":                                # a column of running text on the left, a picture behind a label on the right (with an extra argument: the label on another line)
    page = doc.new_page(width=595, height=842)
    other = len(sys.argv) > 3
    pic = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 100, 40), False)
    pic.clear_with(200)
    page.insert_image(pymupdf.Rect(430, 700 if other else 100, 530, 740 if other else 140), stream=pic.tobytes("png"))
    page.insert_text((450, 725 if other else 125), "Label on picture", fontname="helv", fontsize=9, color=(0, 0, 0))
    for i in range(12):
        page.insert_text((72, 100 + i * 14), "A column of text at the left of the sheet, line %d." % (i + 1), fontname="helv", fontsize=10)
    doc.save(sys.argv[1]); sys.exit()
if kind == "statement":                             # a statement: a header band, rows of date, two-line description, category and figures, every other row shaded, a rule under each row, printers' marks in the margin (with an extra argument: Letter paper, fills only, other columns, the marks at the right edge)
    other = len(sys.argv) > 3
    page = doc.new_page(width=612 if other else 595, height=792 if other else 842)
    left, right = (36, 560) if other else (42.5, 552.8)
    pitch, size = (27.0, 9) if other else (23.2, 8)
    cols = (44, 100, 290, 400) if other else (48.5, 91, 306, 424.9)
    page.draw_rect(pymupdf.Rect(left, 100, right, 116), color=None, fill=(0.04, 0.36, 0.48))
    for x, t in zip(cols, ("Date", "Description", "Category", "Amount")):
        page.insert_text((x, 111), t, fontname="hebo", fontsize=size, color=(1, 1, 1))
    for i in range(22 if other else 30):
        top = 116 + i * pitch
        if i % 2 == 0:
            page.draw_rect(pymupdf.Rect(left, top, right, top + pitch), color=None, fill=(0.96, 0.97, 0.98))
        if not other:
            page.draw_line((left, top + pitch), (right, top + pitch), color=(0.87, 0.89, 0.91), width=0.25)
        page.insert_text((cols[0], top + 11), "%d Aug" % (i + 1), fontname="helv", fontsize=size)
        page.insert_text((cols[1], top + 11), "SHOP NUMBER %d" % i, fontname="helv", fontsize=size)
        if not other or i % 3:
            page.insert_text((cols[1], top + 19), "CARD 4417 REF %d" % (i * 7), fontname="helv", fontsize=size - 2)
        page.insert_text((cols[2], top + 11), ("Groceries", "Transport", "Health")[i % 3], fontname="helv", fontsize=size)
        figure = "%d.%02d" % (i * 3 + 5, i * 7 % 100)
        page.insert_text((cols[3] + 60 - pymupdf.get_text_length(figure, fontname="helv", fontsize=size), top + 11), figure, fontname="helv", fontsize=size)
    for y in (160, 172, 230):
        x = 586 if other else 11.3
        page.draw_rect(pymupdf.Rect(x, y, x + 17, y + 2.3), color=None, fill=(0, 0, 0))
    doc.save(sys.argv[1]); sys.exit()
if kind == "indexcols":                             # an index in three columns, each entry a name and its page number flush right, the columns eight points apart (with an extra argument: two columns, numbers of one to three digits, another size)
    page = doc.new_page(width=595, height=842)
    other = len(sys.argv) > 3
    size = 10 if other else 8.5
    page.insert_text((48.5, 90), "Index", fontname="hebo", fontsize=26)
    starts = (50, 300) if other else (48.5, 214.6, 380.7)
    wide = 238 if other else 158
    for c, x in enumerate(starts):
        for i in range(24):
            number = str(i * 7 + 3 if other else i + 3)
            page.insert_text((x, 120 + i * 13), "Entry %d of column %d" % (i + 1, c + 1), fontname="helv", fontsize=size)
            page.insert_text((x + wide - pymupdf.get_text_length(number, fontname="helv", fontsize=size), 120 + i * 13), number, fontname="helv", fontsize=size)
    doc.save(sys.argv[1]); sys.exit()
if kind == "daygrid":                               # a month as a grid of ruled cells, each with a large bold day number (with an extra argument: other size)
    page = doc.new_page(width=595, height=842)
    other = len(sys.argv) > 3
    size = 16 if other else 20
    for r in range(5):
        for c in range(7):
            x, y = 40 + c * 73, 100 + r * 90
            page.draw_rect(pymupdf.Rect(x, y, x + 73, y + 90), color=(0.6, 0.6, 0.6), width=0.8)
            page.insert_text((x + 6, y + size + 4), str(r * 7 + c + 1), fontname="hebo", fontsize=size)
            page.insert_text((x + 6, y + 70), "note", fontname="helv", fontsize=9)
    doc.save(sys.argv[1]); sys.exit()
if kind == "doublespace":                           # one paragraph of five full lines set at double spacing (with an extra argument: two and a half lines)
    page = doc.new_page(width=595, height=842)
    pitch = 30 if len(sys.argv) > 3 else 24
    text = "The quick brown fox jumps over the lazy dog while the afternoon light fades slowly across the valley."
    for i in range(5):
        page.insert_text((60, 150 + i * pitch), "%s Line %d." % (text, i + 1), fontname="helv", fontsize=9.5)
    doc.save(sys.argv[1]); sys.exit()
if kind == "sideways":                              # a landscape sheet stored turned (/Rotate), as a drawing with labels on a coloured ground, or (second argument) running text; 270 as a third argument
    page = doc.new_page(width=842, height=595)
    what, angle = (sys.argv[3] if len(sys.argv) > 3 else "drawing"), (int(sys.argv[4]) if len(sys.argv) > 4 else 90)
    if what == "drawing":
        page.draw_rect(pymupdf.Rect(0, 0, 842, 595), color=None, fill=(0.85, 0.92, 0.9))
        page.draw_rect(pymupdf.Rect(150, 150, 450, 400), color=(0.2, 0.5, 0.5), fill=(0.7, 0.85, 0.8), width=2)
        for i, label in enumerate(("North gate", "Stage", "Queue lane", "First aid", "Plant room")):
            page.insert_text((170 + (i % 2) * 150, 190 + i * 40), label, fontname="helv", fontsize=14, color=(0.1, 0.3, 0.3))
    else:
        for i in range(14):
            page.insert_text((60, 90 + i * 16), "Running paragraph line %d of text set on a sheet stored sideways, long enough to span the sheet." % (i + 1), fontname="helv", fontsize=11)
    page.set_rotation(angle)
    doc.save(sys.argv[1]); sys.exit()
if kind == "scan-sideways":                         # a landscape page stored with /Rotate 270, its picture and its invisible text layer turned with it; argument: the size of the text
    size = float(sys.argv[3])
    words = ["Cost summary for the harbour depot", "The first line of the report runs across the page.", "A second line follows it on the same sheet."]
    src = pymupdf.open(); sp = src.new_page(width=842, height=595)
    for i, t in enumerate(words):
        sp.insert_text((60, 100 + i * 30), t, fontname="helv", fontsize=size + (6 if i == 0 else 0))
    page = doc.new_page(width=595, height=842)
    page.insert_image(page.rect, pixmap=sp.get_pixmap(dpi=100), rotate=270)
    for i, t in enumerate(words):
        page.insert_text((495 - i * 30, 60), t, fontname="helv", fontsize=size + (6 if i == 0 else 0), rotate=270, render_mode=3)
    page.set_rotation(270)
    doc.save(sys.argv[1]); sys.exit()
if kind == "scan-faint":                            # one dark line and the show-through of the other side of the sheet; argument: grey of the ghost : mirror or plain : size
    grey, how, size = sys.argv[3].split(":")
    src = pymupdf.open(); sp = src.new_page(width=595, height=842)
    sp.draw_rect(sp.rect, color=None, fill=(0.97, 0.97, 0.97))
    sp.insert_text((60, 120), "Delivery note for the harbour depot", fontname="helv", fontsize=float(size) + 4, color=(0.1, 0.1, 0.1))
    for i, t in enumerate(("Back of the sheet printed in another ink that shows through", "A second line of the same ghost text on the back page", "And a third line that nobody can read in daylight")):
        kw = dict(morph=(pymupdf.Point(297, 421), pymupdf.Matrix(-1, 0, 0, 1, 0, 0))) if how == "mirror" else {}
        sp.insert_text((60, 300 + i * 30), t, fontname="helv", fontsize=float(size), color=(float(grey),) * 3, **kw)
    page = doc.new_page(width=595, height=842)
    page.insert_image(page.rect, pixmap=sp.get_pixmap(dpi=150))
    doc.save(sys.argv[1]); sys.exit()
if kind == "scan-photo":                            # a picture of a page with an invisible text layer; argument: how much of the light is left at the far side of the sheet : the angle each line differs from the one above
    shade, bend = (float(v) for v in sys.argv[3].split(":"))
    lines = ["Water supply review for the northern districts", "The first line of the note is set across the page.", "A second line follows it on the same sheet.", "And a third line closes the paragraph.", "Contact the office on the number printed above."]
    src = pymupdf.open(); sp = src.new_page(width=595, height=842)
    for i in range(40):
        g = 1 - (1 - shade) * i / 39
        sp.draw_rect(pymupdf.Rect(i * 595 / 40, 0, (i + 1) * 595 / 40 + 1, 842), color=None, fill=(0.96 * g,) * 3)
    page = doc.new_page(width=595, height=842)
    def put(p, mode):
        for i, t in enumerate(lines):
            p.insert_text((60, 150 + i * 40), t, fontname="helv", fontsize=12, color=(0.1,) * 3, render_mode=mode, morph=(pymupdf.Point(60, 150 + i * 40), pymupdf.Matrix((i - 2) * bend)))
    put(sp, 0)
    page.insert_image(page.rect, pixmap=sp.get_pixmap(dpi=100))
    put(page, 3)
    doc.save(sys.argv[1]); sys.exit()
if kind == "scan-stamp":                            # a scan with a red stamp; argument: over (the stamp lies across two lines, the page carries a text layer) or tilt (a stamp turned by an angle below the text, no layer) : the angle : the size of the text
    how, tilt, size = sys.argv[3].split(":")
    tilt, size = float(tilt), float(size)
    lines = ["Delivery note for the harbour depot at Pasir Gudang", "The goods listed below were received in good order on the date shown.", "Any damage must be reported to the office within seven days of this date.",
             "A second copy of this note is kept with the shipping documents.", "Questions about this delivery should be sent to the records office."]
    src = pymupdf.open(); sp = src.new_page(width=595, height=842)
    sp.draw_rect(sp.rect, color=None, fill=(0.96, 0.96, 0.96))
    for i, t in enumerate(lines):
        sp.insert_text((60, 150 + i * 28), t, fontname="helv", fontsize=size, color=(0.1,) * 3)
    red = (0.8, 0.1, 0.15)
    if how == "over":
        sp.insert_text((330, 230), "RECEIVED", fontname="hebo", fontsize=size * 2.2, color=red)
        sp.draw_rect(pymupdf.Rect(320, 195, 480, 245), color=red, width=2)
    else:
        pivot = pymupdf.Point(250, 420)
        sp.insert_text(pivot, "RECEIVED 09 NOV 2026", fontname="hebo", fontsize=size * 2, color=red, morph=(pivot, pymupdf.Matrix(tilt)))
    page = doc.new_page(width=595, height=842)
    page.insert_image(page.rect, pixmap=sp.get_pixmap(dpi=150))
    if how == "over":
        for i, t in enumerate(lines):
            page.insert_text((60, 150 + i * 28), t, fontname="helv", fontsize=size, render_mode=3)
        page.insert_text((330, 230), "RECEIVED", fontname="hebo", fontsize=size * 2.2, render_mode=3)
    doc.save(sys.argv[1]); sys.exit()
if kind == "scan-pen":                              # a scan of black print with two lines written over it by hand in a coloured pen, all with a text layer; argument: blue or green : the size of the text
    pen, size = sys.argv[3].split(":")
    size = float(size)
    ink = {"blue": (0.1, 0.2, 0.75), "green": (0.05, 0.5, 0.2)}[pen]
    lines = ["Delivery note for the harbour depot at Pasir Gudang", "The goods listed below were received in good order on the date shown.", "Checked against the order and signed for by the night supervisor.",
             "Two crates were damaged and are to be returned to the supplier.", "Questions about this delivery should be sent to the records office."]
    src = pymupdf.open(); sp = src.new_page(width=595, height=842)
    sp.draw_rect(sp.rect, color=None, fill=(0.96, 0.96, 0.96))
    page = doc.new_page(width=595, height=842)
    for i, t in enumerate(lines):
        by_hand = i in (2, 3)
        sp.insert_text((60, 150 + i * 28), t, fontname="heit" if by_hand else "helv", fontsize=size, color=ink if by_hand else (0.1,) * 3)
    page.insert_image(page.rect, pixmap=sp.get_pixmap(dpi=150))
    for i, t in enumerate(lines):
        page.insert_text((60, 150 + i * 28), t, fontname="heit" if i in (2, 3) else "helv", fontsize=size, render_mode=3)
    doc.save(sys.argv[1]); sys.exit()
if kind == "scan-mixed":                            # a scan slanted by an angle whose text layer sets each word at the height of its own box and puts the last three words of a row on a baseline of their own; argument: the angle : the size of the text : how far those words stand off the row
    tilt, size, drift = (float(v) for v in sys.argv[3].split(":"))
    rows = ["Thank you for your letter of 2 November. As you asked, we have closed the account.", "The closing balance has been transferred to your account at the bank in full.", "Interest was added on the day of closure and a final statement will follow soon."]
    jit = [1.0, 0.9, 1.1, 0.95, 1.15, 0.9, 1.05, 0.95]
    src = pymupdf.open(); sp = src.new_page(width=595, height=842)
    page = doc.new_page(width=595, height=842)
    def put(p, x, y, t, s, mode):
        p.insert_text((x, y), t, fontname="helv", fontsize=s, render_mode=mode, morph=(pymupdf.Point(60, 150), pymupdf.Matrix(tilt)))
    for i, row in enumerate(rows):
        x = 60.0
        for k, w in enumerate(row.split()):
            put(sp, x, 150 + i * 24, w, size, 0)
            put(page, x, 150 + i * 24 + (drift if k >= len(row.split()) - 3 else 0), w, size * jit[(k + i) % len(jit)], 3)
            x += pymupdf.get_text_length(w + " ", fontname="helv", fontsize=size)
    page.insert_image(page.rect, pixmap=sp.get_pixmap(dpi=100), overlay=False)
    doc.save(sys.argv[1]); sys.exit()
if kind == "layer":                                 # a scan that carries a text layer: the picture of a page with a title, three lines and a signature, and the text of them drawn invisibly over it
    # (with an extra argument "under": the text drawn first and the picture over it; "skew": the lines of the layer slanted by 1.5 degrees)
    how = sys.argv[3] if len(sys.argv) > 3 else ""
    ink = pymupdf.open(); ip = ink.new_page(width=595, height=842)
    lines = [(60, 100, "Quarterly Report of the Harbour", 26)] + [(60, 200 + i * 20, t, 11) for i, t in enumerate(("The first line of the letter runs across the page.", "A second line follows it on the same sheet.", "And a third line closes the paragraph."))]
    for x, y, t, size in lines:
        ip.insert_text((x, y), t, fontname="helv", fontsize=size)
    for i in range(14):
        ip.draw_line((60 + i * 6, 340 + (i % 3) * 9), (95 + i * 8, 372 - (i % 4) * 7), color=(0, 0, 0), width=2.5)
    pix = ip.get_pixmap(dpi=100)
    page = doc.new_page(width=595, height=842)
    def text():
        for x, y, t, size in lines + [(60, 368, "Okafor", 26)]:
            kw = dict(morph=(pymupdf.Point(297, 421), pymupdf.Matrix(1.5))) if how == "skew" else {}
            page.insert_text((x, y), t, fontname="helv", fontsize=size, render_mode=0 if how == "under" else 3, color=(0, 0, 0), **kw)
    if how == "under":
        text()
    page.insert_image(page.rect, pixmap=pix)
    if how != "under":
        text()
    doc.save(sys.argv[1]); sys.exit()
if kind == "mathfonts":                             # a line in a font named CMMI10 (the italic letters of a TeX paper) and one in XYZABC+CMSY10 (its symbols), among running text (with an extra argument: LMMathItalic10 and MSAM10, another size)
    other = len(sys.argv) > 3
    page = doc.new_page(width=595, height=842)
    size = 16 if other else 11
    page.insert_text((72, 90), "A sentence of running text before the equation.", fontname="cour", fontsize=size)
    for name, file in (("mm", "times.ttf"), ("ms", "arial.ttf")):
        page.insert_font(fontname=name, fontfile="C:/Windows/Fonts/" + file, set_simple=True)
    page.insert_text((72, 130), "x + y = z", fontname="mm", fontsize=size)
    page.insert_text((72, 170), "( a = b )", fontname="ms", fontsize=size)
    page.insert_text((72, 210), "A sentence of running text after the equation.", fontname="cour", fontsize=size)
    doc.save(sys.argv[1]); doc.close()
    names = {"TimesNewRomanPSMT": "LMMathItalic10-Regular" if other else "CMMI10", "ArialMT": "QWERTY+MSAM10" if other else "XYZABC+CMSY10"}
    doc = pymupdf.open(sys.argv[1])
    for f in doc[0].get_fonts():
        if f[3] in names:
            doc.xref_set_key(f[0], "BaseFont", "/" + names[f[3]])
    doc.save(sys.argv[1] + ".tmp"); doc.close(); os.replace(sys.argv[1] + ".tmp", sys.argv[1]); sys.exit()
if kind == "mathletters":                           # letters of the mathematical alphabets (U+1D44E and its neighbours) drawn from a font that has them, among running text (with an extra argument: other letters and another size)
    other = len(sys.argv) > 3
    page = doc.new_page(width=595, height=842)
    size = 16 if other else 11
    page.insert_text((72, 90), "A sentence of running text before the equation.", fontname="helv", fontsize=size)
    text = "\u{1D6FC} + \u{1D6FD} = \u{1D7D8}" if other else "\u{1D44E} + \u{1D44F} = \u{1D450}"
    font = pymupdf.Font(fontfile="C:/Windows/Fonts/seguisym.ttf")
    tw = pymupdf.TextWriter(page.rect)
    tw.append((72, 130), text, font=font, fontsize=size)
    tw.write_text(page)
    page.insert_text((72, 170), "A sentence of running text after the equation.", fontname="helv", fontsize=size)
    xref = [f for f in page.get_fonts() if f[3].startswith("Segoe")][0][0]
    cmap = "/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Test def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange %d beginbfchar %s endbfchar endcmap CMapName currentdict /CMap defineresource pop end end"
    rows = ["<%04x> <%s>" % (font.has_glyph(ord(c)), c.encode("utf-16-be").hex()) for c in sorted(set(text))]
    doc.update_stream(int(doc.xref_get_key(xref, "ToUnicode")[1].split()[0]), (cmap % (len(rows), " ".join(rows))).encode())
    doc.save(sys.argv[1]); sys.exit()
if kind == "rtl":                                   # an Arabic paragraph of two lines and a Hebrew one, set right to left and shaped by the PDF writer (with an extra argument: a Latin word and a number in the Hebrew line, another size)
    other = len(sys.argv) > 3
    page = doc.new_page(width=595, height=842)
    css = "@font-face{font-family:AR;src:url(arial.ttf)} body{font-family:AR;font-size:%dpt}" % (16 if other else 13)
    fonts = pymupdf.Archive("C:/Windows/Fonts")
    arabic = "\u0645\u0631\u062d\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645 \u0647\u0630\u0627 \u0646\u0635 \u0639\u0631\u0628\u064a \u0637\u0648\u064a\u0644 \u064a\u0644\u0641 \u0639\u0644\u0649 \u0623\u0643\u062b\u0631 \u0645\u0646 \u0633\u0637\u0631 \u0648\u0627\u062d\u062f \u0641\u064a \u0627\u0644\u0635\u0641\u062d\u0629 \u0644\u0644\u0627\u062e\u062a\u0628\u0627\u0631"
    hebrew = "\u05e9\u05dc\u05d5\u05dd \u05e2\u05d5\u05dc\u05dd \u05d6\u05d4\u05d5 \u05e4\u05e1\u05e7\u05d4 \u05d1\u05e2\u05d1\u05e8\u05d9\u05ea \u05d0\u05e8\u05d5\u05db\u05d4 \u05e9\u05e2\u05d5\u05d8\u05e4\u05ea \u05d1\u05de\u05e1\u05e4\u05e8 \u05e9\u05d5\u05e8\u05d5\u05ea \u05d1\u05d3\u05e3 \u05d4\u05d6\u05d4 \u05dc\u05d1\u05d3\u05d9\u05e7\u05d4"
    if other:
        hebrew += " PDF 123 \u05d1\u05e1\u05d5\u05e3"
    page.insert_text((72, 90), "A sentence of running text above the right-to-left paragraphs.", fontname="helv", fontsize=11)
    page.insert_htmlbox(pymupdf.Rect(300, 120, 540, 260), '<p dir="rtl">%s</p>' % arabic, css=css, archive=fonts)
    page.insert_htmlbox(pymupdf.Rect(300, 280, 540, 460), '<p dir="rtl">%s</p>' % hebrew, css=css, archive=fonts)
    doc.save(sys.argv[1]); sys.exit()
if kind == "fields":                                # two rows of check boxes with labels, a text area and a list box with borders, all form widgets (with an extra argument: Letter paper, larger boxes, labels at the left, nothing ticked, empty bordered fields)
    other = len(sys.argv) > 3
    page = doc.new_page(width=612 if other else 595, height=792 if other else 842)
    size = 14 if other else 10
    def widget(ftype, rect, name, value=None, **kw):
        w = pymupdf.Widget()
        w.field_type, w.field_name, w.rect = ftype, name, pymupdf.Rect(rect)
        w.border_color, w.border_width, w.fill_color = (0, 0, 0), 0.8, (0.8, 0.84, 1)
        for k, v in kw.items():
            setattr(w, k, v)
        page.add_widget(w)
        if value:
            for added in page.widgets():
                if added.field_name == name:
                    added.field_value = value if isinstance(value, str) else added.on_state()
                    added.update()
    page.insert_text((72, 90), "Tick every box that applies to the applicant.", fontname="helv", fontsize=11)
    for i, label in enumerate(("Employed", "Retired", "Student")):
        x = 72 + i * 130
        if other:
            page.insert_text((x, 124), label, fontname="helv", fontsize=11)
            widget(pymupdf.PDF_WIDGET_TYPE_CHECKBOX, (x + 70, 112, x + 70 + size, 112 + size), "box%d" % i, False)
        else:
            widget(pymupdf.PDF_WIDGET_TYPE_CHECKBOX, (x, 112, x + size, 112 + size), "box%d" % i, i == 1)
            page.insert_text((x + size + 6, 121), label, fontname="helv", fontsize=11)
    for i, label in enumerate(("Single", "Married")):
        x = 72 + i * 130
        widget(pymupdf.PDF_WIDGET_TYPE_CHECKBOX, (x, 152, x + size, 152 + size), "status%d" % i, bool(i == 1 and not other))
        page.insert_text((x + size + 6, 161), label, fontname="helv", fontsize=11)
    if other:
        for i, label in enumerate(("Surname", "Forename")):
            page.insert_text((72, 218 + i * 30), label, fontname="helv", fontsize=11)
            widget(pymupdf.PDF_WIDGET_TYPE_TEXT, (150, 205 + i * 30, 380, 223 + i * 30), "name%d" % i, "", fill_color=None)
    else:
        page.insert_text((72, 218), "Comments", fontname="helv", fontsize=11)
        widget(pymupdf.PDF_WIDGET_TYPE_TEXT, (72, 226, 400, 286), "notes", "Free text of the applicant.", field_flags=pymupdf.PDF_TX_FIELD_IS_MULTILINE)
        page.insert_text((72, 316), "Days", fontname="helv", fontsize=11)
        widget(pymupdf.PDF_WIDGET_TYPE_LISTBOX, (150, 304, 280, 364), "days", "Monday", choice_values=["Monday", "Tuesday", "Wednesday"])
    doc.save(sys.argv[1]); sys.exit()
if kind == "drawnboxes":                            # three answers, each after a small square drawn as a stroke (with an extra argument: larger squares, thicker strokes and text)
    other = len(sys.argv) > 3
    page = doc.new_page(width=595, height=842)
    side, size = (12, 12) if other else (9, 10)
    for i, label in enumerate(("Employment", "Study", "Family reunion")):
        y = 120 + i * 30
        page.draw_rect(pymupdf.Rect(72, y - side + 2, 72 + side, y + 2), color=(0, 0, 0), width=1.2 if other else 0.7)
        page.insert_text((72 + side + 8, y), label, fontname="helv", fontsize=size)
    doc.save(sys.argv[1]); sys.exit()
if kind == "narrow":                                # a line in Arial whose embedded subset carries the metrics of Courier New, so that measuring the embedded font would squeeze it (with an extra argument: another size and line)
    other = len(sys.argv) > 3
    page = doc.new_page(width=595, height=842)
    page.insert_font(fontname="nr", fontfile="C:/Windows/Fonts/arial.ttf", set_simple=True)
    page.insert_text((72, 100), "A fictional form for software testing." if other else "A line of narrow text for the foot of the page.", fontname="nr", fontsize=9 if other else 6.5)
    page.insert_text((72, 140), "Ordinary text in Helvetica beside it.", fontname="helv", fontsize=11)
    doc.save(sys.argv[1]); doc.close()
    doc = pymupdf.open(sys.argv[1])
    font = [f for f in doc[0].get_fonts() if f[4] == "nr"][0][0]
    descriptor = int(doc.xref_get_key(font, "FontDescriptor")[1].split()[0])
    doc.update_stream(int(doc.xref_get_key(descriptor, "FontFile2")[1].split()[0]), open("C:/Windows/Fonts/cour.ttf", "rb").read())
    doc.xref_set_key(font, "BaseFont", "/AAAAAA+ArialMT")
    doc.xref_set_key(descriptor, "FontName", "/AAAAAA+ArialMT")
    doc.save(sys.argv[1] + ".tmp"); doc.close(); os.replace(sys.argv[1] + ".tmp", sys.argv[1]); sys.exit()
if kind == "worksheet":                             # questions with a row of answer choices under each and the marks at the right edge on a line of their own (with an extra argument: Letter paper, three choices, the marks further out and smaller)
    other = len(sys.argv) > 3
    page = doc.new_page(width=612 if other else 595, height=792 if other else 842)
    for n in range(5):
        y = 70 + n * 78
        page.insert_text((57, y), "%d   Which of the choices below is the right answer to question %d?" % (n + 1, n + 1), fontname="helv", fontsize=10.5)
        choices = (91, 185, 278) if other else ((108, 278) if n % 2 == 0 else (91, 185, 278, 372))
        for k, x in enumerate(choices):
            page.insert_text((x, y + 25), "%s  %d" % ("ABCD"[k], n * 7 + k), fontname="helv", fontsize=13)
        page.insert_text((480 if other else 452, y + 48), "[%d mark%s]" % (n + 1, "" if n == 0 else "s"), fontname="helv", fontsize=8 if other else 9)
    doc.save(sys.argv[1]); sys.exit()
if kind == "running":                               # three pages of words with a running title and a page number at the foot; the title and the number are drawn after the words; with an extra argument they are drawn before them, as Word prints a header and a footer
    top = len(sys.argv) > 3
    for p in range(3):
        page = doc.new_page(width=595, height=842)
        def furniture():
            page.insert_text((72, 60 if top else 800), "Quarterly review of the estuary survey", fontname="helv", fontsize=9)
            page.insert_text((500, 800), "Page %d of 3" % (p + 1), fontname="helv", fontsize=9)
        if top:
            furniture()
        for i in range(8):
            page.insert_text((72, 120 + i * 20), "alpha%d bravo%d charlie%d delta%d echo%d" % (p * 8 + i, p * 8 + i, p * 8 + i, p * 8 + i, p * 8 + i), fontname="helv", fontsize=11)
        if not top:
            furniture()
    doc.save(sys.argv[1]); sys.exit()
if kind == "poster":                                # text set freely on a coloured page, as on a slide or a flyer
    page = doc.new_page(width=595, height=842)
    page.draw_rect(pymupdf.Rect(0, 0, 595, 842), color=None, fill=(0.1, 0.2, 0.45))
    page.draw_circle((460, 620), 90, color=None, fill=(0.95, 0.7, 0.1))
    page.insert_text((60, 150), "SUMMER SALE", fontname="hebo", fontsize=40, color=(1, 1, 1))
    for i, t in enumerate(("Everything half price this week,", "while the sun is out and the", "shelves are full.")):
        page.insert_text((60, 230 + i * 16), t, fontname="helv", fontsize=12, color=(1, 1, 1))
    page.insert_text((400, 625), "Open daily 9 to 5", fontname="hebo", fontsize=12, color=(0.1, 0.2, 0.45))
    page.insert_text((60, 800), "www.example.com", fontname="helv", fontsize=10, color=(0.8, 0.8, 0.9))
    doc.save(sys.argv[1]); sys.exit()
if kind == "figures":                               # a column of figures of the same width, on a coloured page or (with an extra argument) on paper
    page = doc.new_page(width=595, height=842)
    paper = len(sys.argv) > 3
    if not paper:
        page.draw_rect(pymupdf.Rect(0, 0, 595, 842), color=None, fill=(0.1, 0.2, 0.45))
    for i, t in enumerate(("1,198,420", "1,079,115", "496,302.0", "431,066.5")):
        page.insert_text((60, 150 + i * 18), t, fontname="helv", fontsize=14 if paper else 10, color=(0, 0, 0) if paper else (1, 1, 1))
    doc.save(sys.argv[1]); sys.exit()
if kind == "tight":                                 # running text set tighter than the font's own line height, on paper or (with an extra argument) on a coloured page
    page = doc.new_page(width=595, height=842)
    design = len(sys.argv) > 3
    if design:
        page.draw_rect(pymupdf.Rect(0, 0, 595, 842), color=None, fill=(0.1, 0.2, 0.45))
    for i in range(6):
        page.insert_text((60, 100 + i * 11), "Tightly set line number %d of a paragraph that runs on." % (i + 1), fontname="helv", fontsize=12, color=(1, 1, 1) if design else (0, 0, 0))
    doc.save(sys.argv[1]); sys.exit()
if kind == "writtenorder":                          # a coloured page with two columns whose rows line up, written down the left column and then down the right one
    page = doc.new_page(width=595, height=842)
    page.draw_rect(pymupdf.Rect(0, 0, 595, 842), color=None, fill=(0.1, 0.2, 0.45))
    page.draw_circle((460, 620), 90, color=None, fill=(0.95, 0.7, 0.1))
    for x, side in ((60, "Left"), (330, "Right")):
        for i in range(3):
            page.insert_text((x, 150 + i * 120), "%s paragraph %d" % (side, i + 1), fontname="helv", fontsize=14, color=(1, 1, 1))
    doc.save(sys.argv[1]); sys.exit()
if kind == "across":                                # label and value rows written across, then three columns written down each column
    page = doc.new_page(width=595, height=842)
    for i in range(4):
        page.insert_text((60, 100 + i * 20), "Label %d" % (i + 1), fontname="helv", fontsize=11)
        page.insert_text((200, 100 + i * 20), "Value %d" % (i + 1), fontname="helv", fontsize=11)
    page.insert_text((60, 230), "A sentence that runs across the whole width of the page between the two blocks.", fontname="helv", fontsize=11)
    for x, name in ((60, "Left"), (200, "Middle"), (340, "Right")):
        for i in range(3):
            page.insert_text((x, 300 + i * 14), "%s column line %d" % (name, i + 1), fontname="helv", fontsize=11)
    doc.save(sys.argv[1]); sys.exit()
if kind == "designtable":                           # a 3 x 3 ruled table on a coloured page, then rows of a table drawn with no rules
    page = doc.new_page(width=595, height=842)
    page.draw_rect(pymupdf.Rect(0, 0, 595, 842), color=None, fill=(0.9, 0.95, 1.0))
    page.draw_circle((480, 700), 80, color=None, fill=(0.95, 0.7, 0.1))
    page.insert_text((60, 100), "PRICE LIST", fontname="hebo", fontsize=30)
    for r in range(3):
        for c in range(3):
            rect = pymupdf.Rect(60 + c * 150, 200 + r * 30, 210 + c * 150, 230 + r * 30)
            page.draw_rect(rect, color=(0.4, 0.4, 0.4), fill=(0.1, 0.3, 0.5) if r == 0 else None, width=0.8)
            page.insert_text((rect.x0 + 8, rect.y0 + 19), ["Item", "Unit", "Price"][c] if r == 0 else "cell %d%d" % (r, c), fontname="helv", fontsize=11, color=(1, 1, 1) if r == 0 else (0, 0, 0))
    for i, (a, b) in enumerate((("-sS", "TCP SYN scan"), ("-sU", "UDP scan"), ("-sA", "TCP ACK scan"), ("-sW", "TCP window scan"))):
        page.insert_text((60, 400 + i * 14), a, fontname="helv", fontsize=10)
        page.insert_text((140, 400 + i * 14), b, fontname="helv", fontsize=10)
    doc.save(sys.argv[1]); sys.exit()
if kind == "wordtable":                             # a table as Word draws it: 0.5 pt rules as filled rectangles, each shaded cell a whole-cell fill plus an inset one
    page = doc.new_page(width=595, height=842)
    page.insert_text((60, 80), "Quarterly figures", fontname="hebo", fontsize=16)
    for i in range(4):
        page.insert_text((60, 110 + i * 14), "The figures below are in thousands and have not been audited at the date of writing.", fontname="helv", fontsize=11)
    cols, ink = [60, 200, 340, 480], (0.79, 0.83, 0.88)
    rows = [(200, 224, (0.07, 0.16, 0.29)), (224, 248, (0.93, 0.95, 0.97)), (248, 272, None), (272, 296, (0.93, 0.95, 0.97)), (296, 320, None)]
    for r, (y0, y1, fill) in enumerate(rows):
        for c in range(3):
            x0, x1 = cols[c], cols[c + 1]
            if fill:
                page.draw_rect(pymupdf.Rect(x0, y0, x1, y1), color=None, fill=fill)
                page.draw_rect(pymupdf.Rect(x0 + 5.4, y0, x1 - 5.4, y1), color=None, fill=fill)
            page.insert_text((x0 + 5.4, y0 + 16), ["Region", "Units", "Revenue"][c] if r == 0 else "r%dc%d" % (r, c), fontname="hebo" if r == 0 else "helv", fontsize=11, color=(1, 1, 1) if r == 0 else (0, 0, 0))
    for y in [200, 224, 248, 272, 296, 320]:
        page.draw_rect(pymupdf.Rect(60, y - 0.25, 480, y + 0.25), color=None, fill=ink)
    for x in cols:
        page.draw_rect(pymupdf.Rect(x - 0.25, 200, x + 0.25, 320), color=None, fill=ink)
    doc.save(sys.argv[1]); sys.exit()
if kind == "bandtable":                             # a ruled table whose header and stripes are one rectangle for the whole row ("cell": one for each cell, "wide": four columns in other colours)
    page = doc.new_page(width=595, height=842)
    mode = sys.argv[3] if len(sys.argv) > 3 else "row"
    cols = [60, 160, 260, 360, 460] if mode == "wide" else [60, 200, 340, 480]
    navy, band = ((115 / 255, 26 / 255, 51 / 255), (245 / 255, 230 / 255, 179 / 255)) if mode == "wide" else ((0.07, 0.16, 0.29), (0.93, 0.95, 0.97))
    page.insert_text((60, 80), "Quarterly figures", fontname="hebo", fontsize=16)
    for i in range(4):
        page.insert_text((60, 110 + i * 14), "The figures below are in thousands and have not been audited at the date of writing.", fontname="helv", fontsize=11)
    for r, (y0, y1, fill) in enumerate([(200, 224, navy), (224, 248, band), (248, 272, None), (272, 296, band), (296, 320, None)]):
        if fill and mode == "cell":
            for c in range(len(cols) - 1):
                page.draw_rect(pymupdf.Rect(cols[c], y0, cols[c + 1], y1), color=None, fill=fill)
        elif fill:
            page.draw_rect(pymupdf.Rect(cols[0], y0, cols[-1], y1), color=None, fill=fill)
        for c in range(len(cols) - 1):
            page.insert_text((cols[c] + 5.4, y0 + 16), ["Region", "Units", "Revenue", "Margin"][c] if r == 0 else "r%dc%d" % (r, c), fontname="hebo" if r == 0 else "helv", fontsize=11, color=(1, 1, 1) if r == 0 else (0, 0, 0))
    for y in [200, 224, 248, 272, 296, 320]:
        page.draw_rect(pymupdf.Rect(cols[0], y - 0.25, cols[-1], y + 0.25), color=None, fill=(0.79, 0.83, 0.88))
    for x in cols:
        page.draw_rect(pymupdf.Rect(x - 0.25, 200, x + 0.25, 320), color=None, fill=(0.79, 0.83, 0.88))
    doc.save(sys.argv[1]); sys.exit()
if kind == "hiding":                                # text the sheet does not show beside text it does; with an extra argument: larger text, a tinted band as the ground and a navy cover
    page = doc.new_page(width=595, height=842)
    other = len(sys.argv) > 3
    size = 20 if other else 12
    cream = (0.99, 0.93, 0.75)
    page.insert_text((60, 100), "Visible black line", fontname="helv", fontsize=size)
    page.insert_text((60, 160), "Covered words", fontname="helv", fontsize=size)
    page.draw_rect(pymupdf.Rect(50, 160 - 1.3 * size, 400, 160 + 0.5 * size), color=None, fill=(0.1, 0.2, 0.4) if other else (0.8, 0.8, 0.8))
    if other:
        page.draw_rect(pymupdf.Rect(40, 200, 555, 250), color=None, fill=cream)
    page.insert_text((60, 235 if other else 220), "Same as the ground", fontname="helv", fontsize=size, color=cream if other else (1, 1, 1))
    page.insert_text((60, 290), "Invisible mode", fontname="helv", fontsize=size, render_mode=3)
    page.draw_rect(pymupdf.Rect(50, 330, 400, 330 + 2 * size), color=None, fill=(0.1, 0.2, 0.4))
    page.insert_text((60, 330 + 1.4 * size), "White on a dark box", fontname="helv", fontsize=size, color=(1, 1, 1))
    doc.save(sys.argv[1]); sys.exit()
if kind == "scatter":                               # short pieces of text at many left edges and nothing drawn: an ordinary page, not a design
    page = doc.new_page(width=595, height=842)
    for i in range(20):
        page.insert_text((40 + (i % 7) * 70, 60 + i * 30), "Item %d" % i, fontname="helv", fontsize=10)
    doc.save(sys.argv[1]); sys.exit()
if kind == "tracked":                               # a letter-spaced title that reaches the right edge of its column
    page = doc.new_page(width=595, height=842)
    buf = open(os.path.join(os.environ.get("WINDIR", "C:/Windows"), "Fonts", "arialbd.ttf"), "rb").read()
    page.insert_font(fontname="Trk", fontbuffer=buf, set_simple=True)
    page.insert_text((45, 70), "Seller name", fontname="hebo", fontsize=13)
    page.insert_text((45, 90), "Street 12", fontname="helv", fontsize=9)
    page.insert_text((409, 70), "INVOICE", fontname="Trk", fontsize=30)
    page.insert_text((387, 100), "NUMBER", fontname="helv", fontsize=8)
    page.insert_text((461, 100), "INV-2026-1", fontname="hebo", fontsize=9.5)
    for xref in page.get_contents():
        data = doc.xref_stream(xref)
        if b"/Trk 30 Tf" in data:
            doc.update_stream(xref, data.replace(b"/Trk 30 Tf", b"/Trk 30 Tf 3 Tc"))
    doc.save(sys.argv[1]); sys.exit()
if kind == "outlined":                              # two outlined boxes a few points apart, each a numbered paragraph set flush
    page = doc.new_page(width=595, height=842)
    for k, (y0, y1) in enumerate(((120, 180), (187, 230))):
        page.draw_rect(pymupdf.Rect(108, y0, 540, y1), color=(0.27, 0.27, 0.27), width=0.75)
        page.insert_text((120, y0 + 16), "(%d) First line of the party text, a company" % (k + 1), fontname="helv", fontsize=11)
        page.insert_text((120, y0 + 31), "second line of the same paragraph.", fontname="helv", fontsize=11)
    doc.save(sys.argv[1]); sys.exit()
if kind == "nested":                                # a table whose cells are an outer colour with a lighter tint inset in each, one row two lines tall
    page = doc.new_page(width=842, height=595)
    cols = [57, 137, 216, 296, 376]
    mid, dark, light = (0.48, 0.63, 0.8), (0.31, 0.51, 0.74), (0.83, 0.88, 0.93)
    rows = [(111, 125, "head", ["Line", "Apr", "May", "Jun"]), (126, 152, "tint", ["Product revenue", "317", "334", "351"]), (153, 180, "white", ["Service revenue", "426", "443", "460"]),
            (181, 195, "tint", ["Subscriptions", "535", "552", "569"]), (196, 209, "white", ["Cost of sales", "644", "661", "678"]), (210, 224, "tint", ["Gross profit", "753", "770", "787"])]
    for y0, y1, tone, cells in rows:
        for k, text in enumerate(cells):
            x0, x1 = cols[k], cols[k + 1]
            if tone == "head":
                page.draw_rect(pymupdf.Rect(x0, y0, x1, y1), color=None, fill=mid)
                page.draw_rect(pymupdf.Rect(x0 + 5, y0, x1 - 6, y1), color=None, fill=dark)
            elif tone == "tint":
                page.draw_rect(pymupdf.Rect(x0, y0, x1, y1), color=None, fill=light)
                page.draw_rect(pymupdf.Rect(x0 + 5, y0, x1 - 6, min(y1, y0 + 13)), color=None, fill=light)
            page.insert_text((x0 + 8, y0 + 10), text, fontname="helv", fontsize=9)
        page.draw_rect(pymupdf.Rect(cols[0], y1, cols[-1], y1 + 1), color=None, fill=mid)
    doc.save(sys.argv[1]); sys.exit()
if kind == "manypictures":                          # 250 tiny pictures on the first page, a few on the second
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 4, 4), False)
    pix.clear_with(90)
    for count in (250, 5):
        page = doc.new_page(width=595, height=842)
        for i in range(count):
            x, y = 40 + (i % 25) * 20, 120 + (i // 25) * 20
            page.insert_image(pymupdf.Rect(x, y, x + 8, y + 8), pixmap=pix)
        page.insert_text((60, 700), "Pictures above", fontname="helv", fontsize=11)
    doc.save(sys.argv[1]); sys.exit()
if kind == "limits":                                # a heading, a pull quote, a letter's closing and signature, and rows whose first cell has a trailing space
    page = doc.new_page(width=595, height=842)
    page.insert_text((60, 100), "Section One", fontname="hebo", fontsize=18)
    page.insert_text((60, 130), '"Trust is built one careful decision at a time."', fontname="heit", fontsize=18)
    for i in range(3):
        page.insert_text((60, 165 + i * 14), "Ordinary body text, line %d of the letter." % (i + 1), fontname="helv", fontsize=11)
    page.insert_text((60, 240), "Yours sincerely", fontname="helv", fontsize=11)
    page.insert_text((60, 270), "A. Rahman", fontname="heit", fontsize=20)
    for i, flag in enumerate(("-sS", "-sT", "-sU ", "-sA")):
        page.insert_text((60, 340 + i * 14), flag, fontname="helv", fontsize=12)
        page.insert_text((60 + pymupdf.get_text_length(flag, fontname="helv", fontsize=12) + 50, 340 + i * 14), "scan type %d" % (i + 1), fontname="helv", fontsize=12)
    doc.save(sys.argv[1]); sys.exit()
if kind == "abstract":                              # a title, then an indented paragraph that wraps by itself and ends in a line break before its keywords
    page = doc.new_page(width=595, height=842)
    page.insert_text((60, 80), "A Title That Spans The Width Of The Whole Page", fontname="hebo", fontsize=18)
    words = "We measured the response of the system under a range of operating conditions and report the mean of five independent runs. The effect saturates above a critical threshold, in agreement with the theoretical prediction. The experiment was repeated by a second group using different equipment, and the outcome was consistent within uncertainty.".split()
    rows, row = [], ""
    for w in words:
        if pymupdf.get_text_length(row + " " + w, fontname="helv", fontsize=9) > 420:
            rows.append(row); row = w
        else:
            row = (row + " " + w).strip()
    rows += [row, "both synthetic and experimental data."]
    for i, row in enumerate(rows):
        page.insert_text((80, 110 + i * 11.2), row, fontname="helv", fontsize=9)
    page.insert_text((80, 110 + len(rows) * 11.2), "Keywords:", fontname="hebo", fontsize=9)
    page.insert_text((80 + pymupdf.get_text_length("Keywords: ", fontname="hebo", fontsize=9), 110 + len(rows) * 11.2), "sensing networks, coupling", fontname="helv", fontsize=9)
    doc.save(sys.argv[1]); sys.exit()
if kind == "logo":                                  # the same small picture at the top of each of three pages, and a line of text
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 30, 12), False)
    pix.clear_with(60)
    for n in range(3):
        page = doc.new_page(width=595, height=842)
        page.insert_image(pymupdf.Rect(60, 30, 120, 54), pixmap=pix)
        page.insert_text((60, 200), "Body text of page %d" % (n + 1), fontname="helv", fontsize=11)
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
if kind == "zwlist":                                # bullets written as a glyph and a zero-width character; extra: "font:hex of the character", more: the size
    face, zw = sys.argv[3].split(":")
    size = float(sys.argv[4])
    page = doc.new_page(width=595, height=842)
    page.insert_font(fontname="zf", fontfile="C:/Windows/Fonts/" + face + ".ttf")
    for i, t in enumerate(("First item of the plan", "Second item of the plan", "Third item that runs a little longer than the others")):
        page.insert_text((72, 100 + i * 24), "\\u25cf" + chr(int(zw, 16)), fontname="zf", fontsize=size)
        page.insert_text((96, 100 + i * 24), t, fontname="zf", fontsize=size)
    doc.save(sys.argv[1]); sys.exit()
if kind == "badmap":                                # a font whose text map gives half of a surrogate pair for "A"; extra: the hex it maps to, more: the size
    page = doc.new_page(width=595, height=842)
    page.insert_text((72, 100), "A line of plain words after the letter", fontname="helv", fontsize=float(sys.argv[4]))
    cmap = "/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /X def 1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfchar <41> <%s> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end" % sys.argv[3]
    x = doc.get_new_xref()
    doc.update_object(x, "<<>>")
    doc.update_stream(x, cmap.encode(), new=True)
    doc.xref_set_key(doc.get_page_fonts(0)[0][0], "ToUnicode", "%d 0 R" % x)
    doc.save(sys.argv[1]); sys.exit()
if kind == "clauses":                               # numbered clauses whose numbers stand left of their text, beside a column of notes; extra: the labels, more: "number x:text x"
    labels = sys.argv[3].split(",")
    x_num, x_text = (float(v) for v in sys.argv[4].split(":"))
    page = doc.new_page(width=595, height=842)
    body = "Each party keeps the other's information confidential and uses it only for the purpose of this Agreement, and returns it when the Agreement ends."
    for i, label in enumerate(labels):
        y = 100 + i * 58
        page.insert_text((x_num, y), label, fontname="helv", fontsize=10)
        page.insert_textbox(pymupdf.Rect(x_text, y - 9, 380, y + 40), body, fontname="helv", fontsize=10)
        page.insert_text((410, y), "Note %d on this clause" % (i + 1), fontname="helv", fontsize=9)
    doc.save(sys.argv[1]); sys.exit()
if kind == "boxlist":                               # numbered paragraphs over a picture, so each is a text box; extra: the labels
    page = doc.new_page(width=595, height=842)
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 60, 84), False)
    for yy in range(84):
        for xx in range(60):
            pix.set_pixel(xx, yy, (170 + xx, 180 + yy // 2, 200))
    page.insert_image(pymupdf.Rect(0, 0, 595, 600), pixmap=pix)
    for i, label in enumerate(sys.argv[3].split(",")):
        y = 100 + i * 70
        page.insert_text((60, y), label, fontname="helv", fontsize=12)
        page.insert_text((90, y), "Each party keeps the other's information confidential and returns it", fontname="helv", fontsize=12)
        page.insert_text((90, y + 15), "when this Agreement ends, whichever comes first.", fontname="helv", fontsize=12)
    doc.save(sys.argv[1]); sys.exit()
if kind == "contents":                              # a contents page of two levels and the headed pages after it; extra: how the leader is drawn (text, apart, stroke), more: "none" to leave one entry without a heading
    rows = (("1", "Executive summary", 0, 3), ("1.1", "Key figures at a glance", 1, 3), ("2", "Service performance", 0, 4))
    page = doc.new_page(width=595, height=842)
    page.insert_text((70, 80), "Contents", fontname="hebo", fontsize=16)
    right = 535
    for i, (num, title, level, pg) in enumerate(rows):
        y = 110 + i * 18
        x_num, x_title = 70 + 11 * level, 94 + 24 * level
        if sys.argv[3] == "stroke":
            x_title, title = x_num, num + " " + title
        else:
            page.insert_text((x_num, y), num, fontname="helv", fontsize=10.5)
        end = pymupdf.get_text_length(str(pg), fontname="helv", fontsize=10.5)
        dot = pymupdf.get_text_length(".", fontname="helv", fontsize=10.5)
        used = pymupdf.get_text_length(title + " ", fontname="helv", fontsize=10.5)
        dots = int((right - x_title - used - end) / dot)
        if sys.argv[3] == "text":
            page.insert_text((x_title, y), title + " " + "." * dots + str(pg), fontname="helv", fontsize=10.5)
        else:
            page.insert_text((x_title, y), title, fontname="helv", fontsize=10.5)
            if sys.argv[3] == "apart":
                page.insert_text((x_title + used, y), "." * dots, fontname="helv", fontsize=10.5)
            else:
                page.draw_line((x_title + used, y), (right - end - 2, y), color=(0, 0, 0), width=0.8, dashes="[1 3] 0")
            page.insert_text((right - end, y), str(pg), fontname="helv", fontsize=10.5)
    for n, (num, title, level, pg) in enumerate(rows):
        page = doc.new_page(width=595, height=842)
        if len(sys.argv) > 4 and n == 2:
            title = "A different title"
        page.insert_text((60, 90), num, fontname="hebo", fontsize=14)
        page.insert_text((60 + pymupdf.get_text_length(num, fontname="hebo", fontsize=14) + 18, 90), title, fontname="hebo", fontsize=14)
        for k in range(6):
            page.insert_text((60, 130 + k * 14), "Ordinary body text of the section, line %d, set in the usual size." % (k + 1), fontname="helv", fontsize=10.5)
    doc.save(sys.argv[1]); sys.exit()
if kind == "outline":                               # headings with an outline and no contents page
    for n, title in enumerate(("Alpha plan", "Beta plan")):
        page = doc.new_page(width=595, height=842)
        page.insert_text((60, 90), title, fontname="hebo", fontsize=18)
        for k in range(6):
            page.insert_text((60, 130 + k * 14), "Ordinary body text of the section, line %d, set in the usual size." % (k + 1), fontname="helv", fontsize=10.5)
    doc.set_toc([[1, "Alpha plan", 1], [1, "Beta plan", 2]])
    doc.save(sys.argv[1]); sys.exit()
if kind == "numhead":                               # a heading of a section number and its title with a gap between them; extra: the size
    size = float(sys.argv[3])
    page = doc.new_page(width=595, height=842)
    for k in range(5):
        page.insert_text((60, 70 + k * 14), "Ordinary body text before the heading, line %d, set in the usual size." % (k + 1), fontname="helv", fontsize=10.5)
    page.insert_text((60, 170), "2.3", fontname="hebo", fontsize=size)
    page.insert_text((60 + pymupdf.get_text_length("2.3", fontname="hebo", fontsize=size) + 1.3 * size, 170), "Interruptions and outages", fontname="hebo", fontsize=size)
    for k in range(5):
        page.insert_text((60, 200 + k * 14), "Ordinary body text after the heading, line %d, set in the usual size." % (k + 1), fontname="helv", fontsize=10.5)
    doc.save(sys.argv[1]); sys.exit()
RUNNING = "Pressure management works best when the zone is small and the meters are read often. Crews close the valves at night, record the flow at each inlet and compare it with what customers are billed, so that a loss shows up in days and not in months. "
def fill_lines(text, widths, size=10):
    words, out, k = text.split(), [], 0
    while words:
        line = words.pop(0)
        while words and pymupdf.get_text_length(line + " " + words[0], fontname="helv", fontsize=size) <= widths(k):
            line += " " + words.pop(0)
        out.append(line)
        k += 1
    return out
def small_picture():
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 60, 40), False)
    for yy in range(40):
        for xx in range(60):
            pix.set_pixel(xx, yy, (30 + xx * 3, 80 + yy * 3, 140))
    return pix
def run_round(page, area, text, pitch=12, top=120, count=18, gap=12):
    # lines whose middle lies beside the area (x0, y0, x1, y1 at the left or right edge of the column 60 to 535) are as short as the area leaves it
    beside = lambda k: area[1] <= top + k * pitch - 3.5 <= area[3]
    left = area[0] <= 62
    width = lambda k: 475 - (area[2] - area[0] + gap) if beside(k) else 475
    lines = fill_lines(text * 8, width)[:count]
    for k, line in enumerate(lines):
        page.insert_text((area[2] + gap if left and beside(k) else 60, top + k * pitch), line, fontname="helv", fontsize=10)
    return lines
if kind == "wrap":                                  # a paragraph that runs round a picture at one edge of the column (extra: left or right; more: a caption under the picture)
    page = doc.new_page(width=595, height=842)
    pic = pymupdf.Rect(60, 150, 210, 230) if sys.argv[3] == "left" else pymupdf.Rect(385, 150, 535, 230)
    page.insert_image(pic, pixmap=small_picture(), keep_proportion=False)
    area = list(pic)
    if len(sys.argv) > 4:
        for k, t in enumerate(("Figure 2. The second intake on the", "river, seen from upstream")):
            page.insert_text((pic.x0, pic.y1 + 10 + k * 9), t, fontname="heit", fontsize=7.5)
        area[3] = pic.y1 + 21
    run_round(page, area, RUNNING)
    doc.save(sys.argv[1]); sys.exit()
if kind == "quote":                                 # a paragraph that runs round an outlined box at one edge of the column (extra: left or right)
    page = doc.new_page(width=595, height=842)
    box = pymupdf.Rect(60, 150, 190, 235) if sys.argv[3] == "left" else pymupdf.Rect(405, 150, 535, 235)
    page.draw_rect(box, color=(0.2, 0.3, 0.4), fill=None if sys.argv[3] == "left" else (0.9, 0.93, 0.97), width=1)
    for k, t in enumerate(("We used to get water", "only at night. Now the", "valves are set and the", "pressure is steady.")):
        page.insert_text((box.x0 + 8, box.y0 + 16 + k * 12), t, fontname="heit", fontsize=9)
    run_round(page, list(box), RUNNING)
    doc.save(sys.argv[1]); sys.exit()
if kind == "marked":                                # a phrase highlighted inside a line (extra: anything for one that runs over a line break)
    page = doc.new_page(width=595, height=842)
    lines = ["The annual figures were checked twice by the finance team before the report", "was sent to the board, and the highlighted phrase here needs a second reading", "because the number it quotes may change once the auditors have finished."]
    cut = lambda t, a, b: (60 + pymupdf.get_text_length(t[:a], fontname="helv", fontsize=11), 60 + pymupdf.get_text_length(t[:b], fontname="helv", fontsize=11))
    if len(sys.argv) > 3:
        x0, x1 = cut(lines[0], lines[0].index("before"), len(lines[0]))
        y0, y1 = cut(lines[1], 0, lines[1].index("and"))
        page.draw_rect(pymupdf.Rect(x0, 120 - 9, x1, 120 + 3), color=None, fill=(1, 1, 0))
        page.draw_rect(pymupdf.Rect(y0, 134 - 9, y1, 134 + 3), color=None, fill=(1, 1, 0))
    else:
        x0, x1 = cut(lines[1], lines[1].index("highlighted"), lines[1].index("here") + 4)
        page.draw_rect(pymupdf.Rect(x0, 134 - 9, x1, 134 + 3), color=None, fill=(1, 1, 0))
    for k, t in enumerate(lines):
        page.insert_text((60, 120 + k * 14), t, fontname="helv", fontsize=11)
    doc.save(sys.argv[1]); sys.exit()
if kind == "lastcap":                               # a large letter that opens a paragraph, drawn after (or, with a second extra, before) the lines beside it; extra: its size
    size = float(sys.argv[3])
    page = doc.new_page(width=595, height=842)
    def cap():
        page.insert_text((60, 88.6 + 0.905 * size), "T", fontname="helv", fontsize=size)
    if len(sys.argv) > 4:
        cap()
    lines = fill_lines(RUNNING * 3, lambda k: 475 - 0.55 * size if k < 3 else 475)[:6]
    for k, t in enumerate(lines):
        page.insert_text((60 + 0.55 * size if k < 3 else 60, 100 + k * 14), t[1:] if k == 0 else t, fontname="helv", fontsize=10.5)
    if len(sys.argv) <= 4:
        cap()
    doc.save(sys.argv[1]); sys.exit()
if kind == "hyphen":                                # lines that end at a hyphen: in left-aligned text, and in text justified to both edges (a broken word, a number); extra: the size
    size = float(sys.argv[3])
    page = doc.new_page(width=595, height=842)
    first, words = "The invoice must be paid in full by the customer within a three-", "month period of receipt, and the supplier may add interest to late payments after that date.".split()
    second = words[0]
    for w in words[1:]:
        if pymupdf.get_text_length(second + " " + w, fontname="helv", fontsize=size) <= pymupdf.get_text_length(first, fontname="helv", fontsize=size) + 2.4 * size:
            second += " " + w
    for k, t in enumerate((first, second)):
        page.insert_text((60, 100 + k * 14), t, fontname="helv", fontsize=size)
    for top, rows in ((200, ["Every request is read by two people at the depart-", "ment before the panel decides whether a meeting is"]), (260, ["Every request is answered within forty-", "five days unless the panel asks for more time to read"])):
        for k, row in enumerate(rows):
            words = row.split()
            gap = (400 - sum(pymupdf.get_text_length(w, fontname="helv", fontsize=size) for w in words)) / (len(words) - 1)
            x = 60
            for w in words:
                page.insert_text((x, top + k * 14), w, fontname="helv", fontsize=size)
                x += pymupdf.get_text_length(w, fontname="helv", fontsize=size) + gap
        page.insert_text((60, top + 28), "needed, and the applicant hears back within a week.", fontname="helv", fontsize=size)
    doc.save(sys.argv[1]); sys.exit()
if kind == "notes":                                # a page of text with raised marks and the notes they answer at its foot; extra: numbers (a short rule above them), symbols (no rule) or orphan (a note whose mark is not in the text)
    mode = sys.argv[3]
    page = doc.new_page(width=595, height=842)
    body = ["The water board reports its figures once a year to the members of the board", "and the figures for the year are checked by the finance team before they go out.", "Non-revenue water fell for the third year in a row across all six districts of the", "supply area, which the board puts down to pressure management and meter renewal.", "Customers who ask for a copy of the figures are sent one within a week of asking."]
    marks = {"numbers": ["1", "2"], "symbols": ["*", "\u00a7"], "orphan": ["1"]}[mode]
    for k, t in enumerate(body):
        page.insert_text((60, 100 + k * 14), t, fontname="helv", fontsize=10.5)
    for k, m in enumerate(marks):
        page.insert_text((60 + pymupdf.get_text_length(body[k * 2], fontname="helv", fontsize=10.5) + 1, 96.5 + k * 28), m, fontname="helv", fontsize=7)
    texts = {"numbers": ["1", "2"], "symbols": ["*", "\u00a7"], "orphan": ["1", "3"]}[mode]
    if mode != "symbols":
        page.draw_line((60, 690), (204, 690), width=0.5)
    for k, m in enumerate(texts):
        y = 706 + k * 24
        page.insert_text((60, y - 3), m, fontname="helv", fontsize=6.5)
        page.insert_text((66, y), "Note %s: the method is set out in the annual report." % ("one" if k == 0 else "two"), fontname="helv", fontsize=9)
        page.insert_text((66, y + 10), "It runs on to a second line here.", fontname="helv", fontsize=9)
    page.insert_text((280, 800), "Page 1", fontname="helv", fontsize=8)
    doc.save(sys.argv[1]); sys.exit()
if kind == "notecols":                             # two columns of text with a raised mark and its note at the foot; extra: letter paper
    w, h = (612, 792) if len(sys.argv) > 3 else (595, 842)
    page = doc.new_page(width=w, height=h)
    page.insert_text((60, 80), "A paper with two columns of text", fontname="hebo", fontsize=16)
    words = ("The water board reports its figures once a year to the members of the board and the figures for the year are checked by the finance team before they go out. " * 40).split()
    lines, line = [], ""
    for word in words:
        if pymupdf.get_text_length(line + " " + word, fontname="helv", fontsize=10) > 215:
            lines.append(line.strip()); line = ""
        line += " " + word
    for k in range(44):
        page.insert_text((60, 120 + k * 12.5), lines[k], fontname="helv", fontsize=10)
        page.insert_text((310, 120 + k * 12.5), lines[k + 44], fontname="helv", fontsize=10)
    page.insert_text((60 + pymupdf.get_text_length(lines[2], fontname="helv", fontsize=10) + 1, 120 + 2 * 12.5 - 3.5), "1", fontname="helv", fontsize=7)
    page.draw_line((60, h - 97), (204, h - 97), width=0.5)
    page.insert_text((60, h - 85), "1", fontname="helv", fontsize=6)
    page.insert_text((66, h - 82), "Note one: the method is set out in the annual report.", fontname="helv", fontsize=9)
    page.insert_text((280, h - 30), "Page 1", fontname="helv", fontsize=8)
    doc.save(sys.argv[1]); sys.exit()
if kind == "scale":                                # two picture panels with a grid picture on one, a narrow colour scale against them, a caption under; extra: side of the scale
    page = doc.new_page(width=595, height=842)
    for i in range(3):
        page.insert_text((60, 100 + i * 14), "Text above the figure, line %d of the page" % (i + 1), fontname="helv", fontsize=10)
    def panel(rect, shade):
        pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 40, 20), False)
        for yy in range(20):
            for xx in range(40):
                pix.set_pixel(xx, yy, (min(255, shade + xx * 3), 60 + yy * 4, 120))
        page.insert_image(rect, pixmap=pix)
    left = sys.argv[3] == "left"
    x0 = 120 if left else 100
    panel(pymupdf.Rect(x0, 200, x0 + 200, 300), 20)
    panel(pymupdf.Rect(x0 + 202, 200, x0 + 402, 300), 60)
    panel(pymupdf.Rect(x0, 200, x0 + 200, 300), 90)
    panel(pymupdf.Rect(x0 + 202, 200, x0 + 402, 300), 90)
    panel(pymupdf.Rect(x0 - 13, 200, x0 - 2, 300) if left else pymupdf.Rect(x0 + 404, 200, x0 + 415, 300), 140)
    page.insert_text((60, 330), "Figure 1. Two panels with a colour scale at the side.", fontname="helv", fontsize=9)
    for i in range(3):
        page.insert_text((60, 360 + i * 14), "Text under the figure, line %d of the page" % (i + 1), fontname="helv", fontsize=10)
    doc.save(sys.argv[1]); sys.exit()
if kind == "hyphens":                              # justified lines that end in a split word, or in the whole word; extra: size, extra2: yes or no, with -letter for Letter paper
    size = float(sys.argv[3]); split = sys.argv[4].startswith("yes")
    page = doc.new_page(width=612, height=792) if sys.argv[4].endswith("letter") else doc.new_page(width=595, height=842)
    page.insert_text((60, 70), "Report on the new building", fontname="hebo", fontsize=18)
    pairs = [("impor", "tant"), ("build", "ing"), ("govern", "ment"), ("depart", "ment"), ("require", "ments"), ("infra", "structure"), ("commit", "tee"), ("sched", "ule"), ("work", "shop"), ("agree", "ment"), ("proj", "ect"), ("account", "ing")]
    pool = "the council reviewed each proposal and decided that the funding for the new building could go ahead as soon as the committee had signed the schedule for the work".split()
    width = lambda ws: sum(pymupdf.get_text_length(w, fontname="helv", fontsize=size) for w in ws) + pymupdf.get_text_length(" ", fontname="helv", fontsize=size) * (len(ws) - 1)
    lines, k = [], 0
    for a, b in pairs:
        for head, tail in ((([], a + "-" if split else a + b)), (([b] if split else []), None)):
            words = list(head)
            while width(words + [pool[k % len(pool)]] + ([tail] if tail else [])) < 0.95 * 440:
                words.append(pool[k % len(pool)])
                k += 1
            lines.append(words + ([tail] if tail else []))
    lines.append("ends here.".split())
    y = 110
    for i, words in enumerate(lines):
        widths = [pymupdf.get_text_length(w, fontname="helv", fontsize=size) for w in words]
        gap = (440 - sum(widths)) / (len(words) - 1) if i < len(lines) - 1 else pymupdf.get_text_length(" ", fontname="helv", fontsize=size)
        x = 60
        for w, wd in zip(words, widths):
            page.insert_text((x, y), w, fontname="helv", fontsize=size)
            x += wd + gap
        y += size * 1.3
    doc.save(sys.argv[1]); sys.exit()
if kind == "axes":                                  # a plot drawn as curves, a legend inside it, tick labels one under another at its left and a row of them under it; extra: scale
    k = float(sys.argv[3])
    page = doc.new_page(width=595, height=842)
    for i in range(8):
        page.insert_text((60, 100 + i * 14), "Text above the plot, line %d of the page, set in a plain paragraph of the report." % (i + 1), fontname="helv", fontsize=10)
    x0, y0, w, h = 150, 240, 200 * k, 120 * k
    page.draw_polyline([(x0, y0), (x0 + w * 0.3, y0 + h * 0.5), (x0 + w * 0.6, y0 + h * 0.6), (x0 + w, y0 + h)], color=(0.9, 0.1, 0.1), width=1.2)
    page.draw_polyline([(x0, y0 + h * 0.9), (x0 + w * 0.4, y0 + h * 0.7), (x0 + w, y0 + h * 0.4)], color=(0.1, 0.6, 0.9), width=1.2)
    page.insert_text((x0 + w * 0.5, y0 + h * 0.3), "red", fontname="helv", fontsize=7)
    page.insert_text((x0 + w * 0.5, y0 + h * 0.8), "blue", fontname="helv", fontsize=7)
    for i, t in enumerate(["20", "10", "0"]):
        page.insert_text((x0 - 18, y0 + 4 + i * h / 2), t, fontname="helv", fontsize=7)
    for i in range(5):
        page.insert_text((x0 + i * w / 4 - 2, y0 + h + 14), str(i), fontname="helv", fontsize=7)
    page.insert_text((x0 + w / 2 - 15, y0 + h + 26), "iter. (1e4)", fontname="helv", fontsize=7)
    page.insert_text((60, y0 + h + 60), "Figure 1. Error against iterations for two runs.", fontname="helv", fontsize=9)
    for i in range(8):
        page.insert_text((60, y0 + h + 90 + i * 14), "Text under the plot, line %d of the page, set in a plain paragraph of the report." % (i + 1), fontname="helv", fontsize=10)
    doc.save(sys.argv[1]); sys.exit()
if kind == "labelcol":                             # a table set l|cc: rules over and under all three columns, vertical rules only right of the first; extra: scale
    k = float(sys.argv[3])
    page = doc.new_page(width=595, height=842)
    for i in range(8):
        page.insert_text((60, 100 + i * 14), "Text above the table, line %d of the page, set in a plain paragraph of the report." % (i + 1), fontname="helv", fontsize=10)
    xs = [150, 150 + 100 * k, 150 + 200 * k, 150 + 300 * k]
    rows = [("training data", "07+12", "07++12"), ("VGG-16", "73.2", "70.4"), ("ResNet-101", "76.4", "73.8"), ("Faster R-CNN", "75.0", "71.1")]
    for i in range(5):
        page.draw_line((xs[0], 200 + i * 18), (xs[3], 200 + i * 18), color=(0, 0, 0), width=0.5)
    for x in xs[1:]:
        page.draw_line((x, 200), (x, 272), color=(0, 0, 0), width=0.5)
    for i, row in enumerate(rows):
        for c, t in enumerate(row):
            page.insert_text((xs[c] + 8, 213 + i * 18), t, fontname="helv", fontsize=10)
    page.insert_text((60, 300), "Table 1. Error rates of two models.", fontname="helv", fontsize=9)
    for i in range(8):
        page.insert_text((60, 330 + i * 14), "Text under the table, line %d of the page, set in a plain paragraph of the report." % (i + 1), fontname="helv", fontsize=10)
    doc.save(sys.argv[1]); sys.exit()
if kind == "plotframe":                            # a plot: frame and gridlines in a grid, two long curves, tick labels; extra: scale
    k = float(sys.argv[3])
    page = doc.new_page(width=595, height=842)
    for i in range(8):
        page.insert_text((60, 100 + i * 14), "Text above the plot, line %d of the page, set in a plain paragraph of the report." % (i + 1), fontname="helv", fontsize=10)
    x0, y0, w, h = 150, 240, 240 * k, 120 * k
    for i in range(4):
        page.draw_line((x0, y0 + i * h / 3), (x0 + w, y0 + i * h / 3), color=(0.6, 0.6, 0.6), width=0.5)
        page.draw_line((x0 + i * w / 3, y0), (x0 + i * w / 3, y0 + h), color=(0.6, 0.6, 0.6), width=0.5)
    n = 24
    page.draw_polyline([(x0 + w * j / n, y0 + h * (0.2 + 0.5 * ((j * 7) % 11) / 11)) for j in range(n + 1)], color=(0.9, 0.1, 0.1), width=1)
    page.draw_polyline([(x0 + w * j / n, y0 + h * (0.9 - 0.6 * j / n + 0.05 * ((j * 5) % 7) / 7)) for j in range(n + 1)], color=(0.1, 0.5, 0.9), width=1)
    page.insert_text((x0 + w * 0.5, y0 + h * 0.15), "red", fontname="helv", fontsize=7)
    page.insert_text((x0 + w * 0.5, y0 + h * 0.95), "blue", fontname="helv", fontsize=7)
    for i, t in enumerate(["30", "20", "10", "0"]):
        page.insert_text((x0 - 14, y0 + 3 + i * h / 3), t, fontname="helv", fontsize=7)
    for i in range(4):
        page.insert_text((x0 + i * w / 3 - 2, y0 + h + 12), str(i), fontname="helv", fontsize=7)
    page.insert_text((60, y0 + h + 40), "Figure 1. Error against iterations for two runs.", fontname="helv", fontsize=9)
    for i in range(8):
        page.insert_text((60, y0 + h + 70 + i * 14), "Text under the plot, line %d of the page, set in a plain paragraph of the report." % (i + 1), fontname="helv", fontsize=10)
    doc.save(sys.argv[1]); sys.exit()
if kind == "builtup":                              # a fraction or a sum between paragraphs, numbered at the right, or a fraction inside a line of text; extra: size, extra2: fraction, sum or inline
    size, mode = float(sys.argv[3]), sys.argv[4]
    page = doc.new_page(width=595, height=842)
    page.insert_font(fontname="mm", fontfile="C:/Windows/Fonts/times.ttf", set_simple=True)
    times = pymupdf.Font(fontfile="C:/Windows/Fonts/times.ttf")
    text = lambda x, y, t, s=size, f="mm": page.insert_text((x, y), t, fontname=f, fontsize=s)
    width = lambda t, s=size: times.text_length(t, fontsize=s)
    for k in range(3):
        text(60, 100 + k * 14, "The paragraph above the equation runs on over line %d of the page." % (k + 1), 11, "helv")
    if mode == "inline":
        lead, small = "The leak rate is", 0.73 * size
        text(60, 200, lead, size, "helv")
        x = 60 + pymupdf.get_text_length(lead, fontname="helv", fontsize=size) + 5
        text(x + width("a+b", small) + 5, 200, "of the input volume, as measured on site.", size, "helv")
        text(x + 1, 200 - 0.59 * size, "a+b", small)
        page.draw_line((x - 1, 200 - 0.23 * size), (x + width("a+b", small) + 3, 200 - 0.23 * size), width=0.6)
        text(x + 1, 200 + 0.64 * size, "c+d", small)
    else:
        y = 300
        x = 180 + width("R=") + 2
        if mode == "fraction":
            text(x + 2, y - 0.9 * size, "a+b", size * 0.8)
            page.draw_line((x, y - 0.55 * size), (x + width("a+b", size * 0.8) + 4, y - 0.55 * size), width=0.7)
            text(x + 2, y + 0.75 * size, "c+d", size * 0.8)
            text(180, y, "R=")
            text(x + width("a+b", size * 0.8) + 8, y, "\u00d7100")
        else:
            text(x, y + 3, "S", size * 1.8)
            text(x + 3, y - 1.1 * size, "n", size * 0.7)
            text(x + 1, y + 1.05 * size, "i=1", size * 0.7)
            text(180, y, "R=")
            text(x + size * 1.5, y, "x")
            text(x + size * 2.4, y - 0.4 * size, "2", size * 0.7)
        text(520, y, "(1)", size, "helv")
    for k in range(3):
        text(60, 360 + k * 14, "The paragraph below the equation carries on from line %d of the page." % (k + 1), 11, "helv")
    doc.save(sys.argv[1]); doc.close()
    doc = pymupdf.open(sys.argv[1])
    for f in doc[0].get_fonts():
        if f[3] == "TimesNewRomanPSMT":
            doc.xref_set_key(f[0], "BaseFont", "/CMMI10")
    doc.save(sys.argv[1] + ".tmp"); doc.close(); os.replace(sys.argv[1] + ".tmp", sys.argv[1]); sys.exit()
if kind == "flipped":                               # a picture drawn turned over (its file has red above blue); extra: width, extra2: "stored" for a sheet stored with /Rotate 180
    page = doc.new_page(width=595, height=842)
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 40, 40), False)
    for yy in range(40):
        for xx in range(40):
            pix.set_pixel(xx, yy, (220, 30, 30) if yy < 20 else (30, 30, 220))
    side = float(sys.argv[3])
    page.insert_text((60, 100), "A picture drawn upside down", fontname="helv", fontsize=12)
    page.insert_image(pymupdf.Rect(60, 140, 60 + side, 140 + side * 0.6), stream=pix.tobytes("jpeg"), rotate=180)
    if len(sys.argv) > 4:
        page.set_rotation(180)
    doc.save(sys.argv[1]); sys.exit()
if kind == "title":                                 # a centred title of three lines on a sheet with nothing else; extra: size, extra2: sheet width
    size, width = float(sys.argv[3]), float(sys.argv[4])
    page = doc.new_page(width=width, height=842)
    for i, t in enumerate(("HARBOURMASTER", "WATCHMAN'S", "RECORD")):
        page.insert_text(((width - pymupdf.get_text_length(t, fontname="tiro", fontsize=size)) / 2, 150 + i * size * 1.3), t, fontname="tiro", fontsize=size)
    doc.save(sys.argv[1]); sys.exit()
if kind == "annots":                                # four lines of text and one annotation; extra: size, extra2: stamp, free (a note) or lit (a highlight over the text)
    page = doc.new_page(width=595, height=842)
    for i in range(4):
        page.insert_text((60, 100 + i * 16), "Body line %d of the page text" % (i + 1), fontname="helv", fontsize=11)
    if sys.argv[4] == "free":
        page.add_freetext_annot(pymupdf.Rect(300, 300, 500, 340), "Reviewer note here", fontsize=float(sys.argv[3]))
    elif sys.argv[4] == "stamp":
        page.add_stamp_annot(pymupdf.Rect(300, 400, 300 + 12 * float(sys.argv[3]), 450), stamp=pymupdf.STAMP_Draft)
    else:
        page.add_highlight_annot(pymupdf.Rect(60, 88, 200, 102))
    doc.save(sys.argv[1]); sys.exit()
if kind == "code":                                  # an indented block of fixed-pitch lines, the second to last reaching the right edge; extra: size, extra2: indent in blanks
    size, step = float(sys.argv[3]), int(sys.argv[4])
    page = doc.new_page(width=595, height=842)
    char = pymupdf.get_text_length("m", fontname="cour", fontsize=size)
    rows = ["[", " " * step + "{", " " * 2 * step + '"a": "short",', " " * 2 * step + '"file_path": "' + "p" * int((395 / char) - 24) + '",',
            " " * 2 * step + '"file_url": "' + "u" * int((460 / char) - 20) + '",', " " * 2 * step + '"id": "8",', " " * step + "}", "]"]
    for i, row in enumerate(rows):
        page.insert_text((60, 100 + i * size * 1.2), row, fontname="cour", fontsize=size)
    doc.save(sys.argv[1]); sys.exit()
if kind == "overflow":                              # a ruled sheet whose last column holds a note that runs on past the grid; extra: rows, extra2: columns
    rows, cols = int(sys.argv[3]), int(sys.argv[4])
    page = doc.new_page(width=842, height=595)
    for r in range(rows + 1):
        page.draw_line((60, 80 + r * 24), (60 + cols * 90, 80 + r * 24), color=(0.6, 0.6, 0.6), width=0.8)
    for c in range(cols + 1):
        page.draw_line((60 + c * 90, 80), (60 + c * 90, 80 + rows * 24), color=(0.6, 0.6, 0.6), width=0.8)
    for r in range(rows):
        for c in range(cols):
            page.insert_text((66 + c * 90, 96 + r * 24), "Note that goes on past the last rule of its row and then on for a good while after it" if c == cols - 1 and r > 0 else "cell %d %d" % (r, c), fontname="helv", fontsize=8)
    page.insert_text((60, 80 + rows * 24 + 30), "A closing paragraph below the table", fontname="helv", fontsize=10)
    doc.save(sys.argv[1]); sys.exit()
if kind == "noterules":                             # six ruled lines one under another for notes; extra: stroke or rect, extra2: pitch
    page = doc.new_page(width=595, height=842)
    pitch = float(sys.argv[4])
    page.insert_text((60, 100), "Notes", fontname="helv", fontsize=12)
    for i in range(6):
        y = 130 + i * pitch
        if sys.argv[3] == "stroke":
            page.draw_line((60, y), (535, y), color=(0, 0, 0), width=0.96)
        else:
            page.draw_rect(pymupdf.Rect(60, y - 0.5, 535, y + 0.5), color=None, fill=(0, 0, 0))
    page.insert_text((60, 130 + 6 * pitch + 20), "Text under the lines", fontname="helv", fontsize=12)
    doc.save(sys.argv[1]); sys.exit()
if kind == "orgrow":                                # a box over three boxes in a row, the connectors between the two rows touching the lower boxes by a point; extra: box width, extra2: gap
    w, gap = float(sys.argv[3]), float(sys.argv[4])
    page = doc.new_page(width=842, height=595)
    page.insert_text((60, 70), "Who does what", fontname="helv", fontsize=24)
    mid = 60 + (3 * w + 2 * gap) / 2
    page.draw_rect(pymupdf.Rect(mid - w / 2, 110, mid + w / 2, 180), color=None, fill=(0.05, 0.12, 0.35))
    page.insert_text((mid - 40, 150), "General Manager", fontname="helv", fontsize=11, color=(1, 1, 1))
    for k, name in enumerate(("Operations", "Engineering", "Commercial")):
        x = 60 + k * (w + gap)
        page.draw_rect(pymupdf.Rect(x, 260, x + w, 330), color=None, fill=(0.05, 0.12, 0.35))
        page.insert_text((x + 20, 300), name, fontname="helv", fontsize=11, color=(1, 1, 1))
    page.draw_polyline([(mid, 180), (mid, 220), (60 + w / 2, 220), (60 + w / 2, 261)], color=(0.4, 0.4, 0.4), width=1)
    page.draw_polyline([(60 + 1.5 * w + gap, 220), (60 + 1.5 * w + gap, 261)], color=(0.4, 0.4, 0.4), width=1)
    page.draw_polyline([(mid, 220), (60 + 2.5 * w + 2 * gap, 220), (60 + 2.5 * w + 2 * gap, 261)], color=(0.4, 0.4, 0.4), width=1)
    doc.save(sys.argv[1]); sys.exit()
if kind == "numbered":                              # running text with numbered captions between; extra: the numbers, extra2: the word before each
    page = doc.new_page(width=595, height=842)
    for i, n in enumerate(sys.argv[3].split(",")):
        page.insert_text((60, 100 + i * 90), "Some running text between the captions of the page.", fontname="helv", fontsize=11)
        page.insert_text((60, 140 + i * 90), "%s %s. Water use in year %d" % (sys.argv[4], n, i + 1), fontname="heit", fontsize=9)
    doc.save(sys.argv[1]); sys.exit()
if kind == "undertable":                            # a ruled grid and, half a point below its last rule by the middle of its line, a line of notes across its columns; extra: size, extra2: left edge
    size, left = float(sys.argv[3]), float(sys.argv[4])
    page = doc.new_page(width=595, height=842)
    for r in range(4):
        page.draw_line((left, 100 + r * 24), (left + 300, 100 + r * 24), color=(0.6, 0.6, 0.6), width=0.8)
    for c in range(4):
        page.draw_line((left + c * 100, 100), (left + c * 100, 172), color=(0.6, 0.6, 0.6), width=0.8)
    for r in range(3):
        for c in range(3):
            page.insert_text((left + 6 + c * 100, 116 + r * 24), "cell %d %d" % (r, c), fontname="helv", fontsize=9)
    page.insert_text((left, 400), "Sources", fontname="helv", fontsize=size)
    box = page.get_text("dict")["blocks"][-1]["lines"][0]["bbox"]
    page.insert_text((left, 400 + 172.5 - (box[1] + box[3]) / 2), "Notes: the figures above are rounded to the nearest whole number for every row", fontname="helv", fontsize=size)
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

const isFramed = (d, word) => /<w:framePr /.test((new RegExp(`<w:p>(?:(?!</w:p>).)*${word}`, 's').exec(d.xml) || [''])[0].match(/<w:p>(?:(?!<w:p>).)*$/s)?.[0] || '');

(async () => {
  const engines = convert.detectEngines();
  if (!engines.pdf) { console.log('PDF engine not installed: skipped'); return; }
  const dir = tmp.dir('layout');
  const make = path.join(dir, 'make.py');
  fs.writeFileSync(make, MAKE_PDF);
  const draw = (name, kind, extra = '', more = '') => { const f = path.join(dir, `${name}.pdf`); execFileSync(engines.pdf, ['-W', 'ignore', make, f, kind, ...(extra ? [extra] : []), ...(more ? [more] : [])], { windowsHide: true }); return f; };
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
  expect('no table row clips its text (no exact row height), and a short row stays whole on a sheet', !/<w:trHeight [^>]*w:hRule="exact"/.test(d.xml) && /<w:cantSplit\/>/.test(d.xml));
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

  console.log('a footer near the bottom edge');
  [docx] = await convert.convertFile(draw('footer', 'footer'), 'docx');
  d = await read(docx);
  expect('the footer is placed at its position on the sheet, so taller text above cannot push it onto a new sheet', /<w:framePr [^>]*w:vAnchor="page"[^>]*\/>(?:(?!<\/w:p>).)*Footer of the page/s.test(d.xml), d.text);
  expect('the body text is ordinary paragraphs', !/<w:framePr [^>]*\/>(?:(?!<\/w:p>).)*Body line 1/s.test(d.xml) && d.text.includes('Body line 4'));
  fs.rmSync(docx);

  console.log('a report: a running title, a footer with the page number, headings, a list and a caption');
  [docx] = await convert.convertFile(draw('report', 'report'), 'docx');
  d = await read(docx);
  const part = async (name) => (d.zip.file(name) ? d.zip.file(name).async('string') : '');
  const footer = await part('word/footer1.xml');
  const header = await part('word/header1.xml');
  const sections = d.xml.match(/<w:sectPr[ >]/g) || [];
  expect('the footer is a footer part with a page and a page-count field', /<w:instrText [^>]*> PAGE <\/w:instrText>/.test(footer) && /<w:instrText [^>]*> NUMPAGES <\/w:instrText>/.test(footer) && footer.includes('Page') && footer.includes('Ref. QR-2026-7'), footer.slice(-300));
  const footerRels = await part('word/_rels/footer1.xml.rels');
  const linkId = (footer.match(/<w:hyperlink r:id="(rId\d+)"/) || [])[1];
  expect('a link in the footer is related to the footer part, not to the document', Boolean(linkId) && new RegExp(`Id="${linkId}"[^>]*Target="https://example.com/report"|Target="https://example.com/report"[^>]*Id="${linkId}"`).test(footerRels), footerRels);
  expect('the running title is a header part, set once', header.includes('Quarterly Review') && !(await part('word/header2.xml')));
  expect('neither is also written in the body', !/Quarterly Review|Ref\. QR|Page \d? ?of/.test(d.text) && !/<w:t[^>]*>of<\/w:t>/.test(d.xml), d.text.slice(0, 300));
  expect('page 1, which has no running title, has no header, and the others carry on with the first', (d.xml.match(/<w:headerReference /g) || []).length === 1 && d.xml.indexOf('<w:footerReference ') < d.xml.indexOf('</w:sectPr>') && (d.xml.match(/<w:footerReference /g) || []).length === 1 && sections.length === 4);
  expect('the title, the headings, the list item and the caption have their styles', /<w:pStyle w:val="Title"\/>(?:(?!<\/w:p>).)*Annual Statement/s.test(d.xml) && /<w:pStyle w:val="Heading2"\/>(?:(?!<\/w:p>).)*Section 2/s.test(d.xml) && /<w:pStyle w:val="ListParagraph"\/>(?:(?!<\/w:p>).)*A list item/s.test(d.xml) && /<w:pStyle w:val="Caption"\/>(?:(?!<\/w:p>).)*Figure (?:(?!<\/w:p>).)*\. The plan/s.test(d.xml));
  const styles = await part('word/styles.xml');
  const heading1 = (styles.match(/<w:style [^>]*w:styleId="Heading1".*?<\/w:style>/s) || [''])[0];
  expect('the styles are there, and a heading style adds no look and no keep-with-next of its own', ['Normal', 'Title', 'Heading1', 'Heading2', 'Heading3', 'ListParagraph', 'Caption'].every((id) => styles.includes(`w:styleId="${id}"`)) && !/<w:rPr>|<w:keepNext/.test(heading1), heading1);
  fs.rmSync(docx);

  console.log('two columns, the right one reaching the edge of its cell');
  [docx] = await convert.convertFile(draw('columns', 'columns'), 'docx');
  d = await read(docx);
  const cells = d.xml.match(/<w:tc>.*?<\/w:tc>/gs) || [];
  expect('the columns are table cells', cells.length === 2, `${cells.length} cells`);
  expect('a line that fills its cell to the edge is set a little narrower, so a rounding in Word cannot wrap it', cells.length === 2 && /<w:spacing w:val="-1"\/>/.test(cells[1]) && !/w:right="-/.test(cells[1]), (cells[1] || '').slice(0, 300));
  fs.rmSync(docx);

  console.log('running text in two columns');
  [docx] = await convert.convertFile(draw('flow', 'flow'), 'docx');
  d = await read(docx);
  const sects = d.xml.match(/<w:sectPr[ >].*?<\/w:sectPr>/gs) || [];
  expect('the columns are a Word section of two columns, not table cells', /<w:cols w:num="2"/.test(d.xml) && !/<w:tc>/.test(d.xml), (d.xml.match(/<w:cols [^>]*>/) || [''])[0]);
  expect('the section starts on the same sheet and the page keeps one size', sects.length === 3 && /<w:type w:val="continuous"\/>/.test(sects[1]) && new Set(sects.map((s) => (s.match(/<w:pgSz [^>]*>/) || [''])[0])).size === 1, sects.map((s) => s.slice(0, 60)).join(' | '));
  expect('columns that end together have no column break, so Word balances them and typing runs on into the next', !/<w:br w:type="column"\/>/.test(d.xml));
  expect('the left column is read before the right one', d.text.indexOf('Left column paragraph 3') > -1 && d.text.indexOf('Left column paragraph 3') < d.text.indexOf('Right column paragraph 1'), d.text.slice(0, 200));
  expect('the title stays above the columns, in the first section', d.xml.indexOf('Findings of the review') < d.xml.indexOf('<w:cols '));
  fs.rmSync(docx);

  console.log('columns that end at different heights');
  [docx] = await convert.convertFile(draw('uneven', 'uneven'), 'docx');
  d = await read(docx);
  const breaks = d.xml.match(/<w:p>(?:(?!<\/w:p>).)*?<w:br w:type="column"\/><\/w:r><\/w:p>/gs) || [];
  expect('the first column ends in a column break', (d.xml.match(/<w:br w:type="column"\/>/g) || []).length === 1);
  expect('the break is a paragraph of its own, so it does not stretch the last line of the column or add a line to the next', breaks.length === 1 && !/<w:t[ >]/.test(breaks[0]), breaks.join(' | ').slice(0, 200));
  fs.rmSync(docx);

  console.log('an equation with its number, and a table, inside a column');
  [docx] = await convert.convertFile(draw('equation', 'equation'), 'docx');
  d = await read(docx);
  expect('the equation does not end the columns: both columns are one Word section', (d.xml.match(/<w:cols w:num="2"/g) || []).length === 1 && !/<w:tc>/.test(d.xml));
  expect('the equation and its number are one paragraph with a right tab at the edge of the column', /<w:tab w:val="right" [^>]*\/>(?:(?!<\/w:p>).)*x = y \+ z(?:(?!<\/w:p>).)*\(3\)/s.test(d.xml) || /x = y \+ z(?:(?!<\/w:p>).)*<w:tab\/>(?:(?!<\/w:p>).)*\(3\)/s.test(d.xml));
  fs.rmSync(docx);
  [docx] = await convert.convertFile(draw('tablecol', 'tablecol'), 'docx');
  d = await read(docx);
  expect('a table inside the left column stays in the columns, as a real Word table', (d.xml.match(/<w:cols w:num="2"/g) || []).length === 1 && (d.xml.match(/<w:tbl>/g) || []).length === 1 && d.xml.indexOf('<w:tbl>') < d.xml.indexOf('<w:cols '));
  fs.rmSync(docx);

  console.log('a drop capital');
  [docx] = await convert.convertFile(draw('dropcap', 'dropcap'), 'docx');
  d = await read(docx);
  const cap = /<w:p><w:pPr><w:framePr w:dropCap="drop" w:lines="3" w:wrap="around" w:vAnchor="text" w:hAnchor="text"\/>(?:(?!<\/w:p>).)*<w:t[^>]*>T<\/w:t><\/w:r><\/w:p><w:p>(?:(?!<\/w:p>).)*?<w:t[^>]*>he best views/s;
  expect('the large letter is a Word drop capital over three lines, followed by the paragraph that starts after it', cap.test(d.xml), d.text.slice(0, 120));
  expect('the paragraph has no indent for the lines beside the capital', !/<w:ind [^>]*w:firstLine=/.test(d.xml.slice(d.xml.indexOf('he best views') - 600, d.xml.indexOf('he best views'))));
  fs.rmSync(docx);

  console.log('a picture that gridlines cross');
  [docx] = await convert.convertFile(draw('chart', 'chart'), 'docx');
  d = await read(docx);
  expect('the picture is placed on the page, so the labels do not stack under its height', /<wp:anchor /.test(d.xml) && !/<wp:inline /.test(d.xml), (d.xml.match(/<wp:(anchor|inline)/) || [''])[0]);
  expect('the labels are still text', !missingFrom(d.text, ['96', '48', 'Revenue by quarter']).length, d.text);
  fs.rmSync(docx);

  console.log('a photo with text wrapped round it');
  [docx] = await convert.convertFile(draw('beside', 'beside'), 'docx');
  d = await read(docx);
  expect('the photo is placed on the page and the text stays at its own height', /<wp:anchor /.test(d.xml) && !/<wp:inline /.test(d.xml), (d.xml.match(/<wp:(anchor|inline)/) || [''])[0]);
  expect('all the text is there', !missingFrom(d.text, ['Text wrapped round the photo, line 6', 'Text below the photo runs the full width of the column, line 3']).length, d.text);
  fs.rmSync(docx);

  console.log('a panel more than half a page high');
  [docx] = await convert.convertFile(draw('tall', 'tall'), 'docx');
  d = await read(docx);
  expect('its row may split across sheets, so Word does not clip it', !/<w:cantSplit\/>/.test(d.xml) && /<w:tbl>/.test(d.xml));
  expect('the text inside is there', !missingFrom(d.text, ['Text inside the panel, line 1', 'Text inside the panel, line 3']).length);
  fs.rmSync(docx);

  console.log('a font that Windows does not have');
  [docx] = await convert.convertFile(draw('unknownfont', 'unknownfont'), 'docx');
  d = await read(docx);
  const normal = ((await d.zip.file('word/styles.xml').async('string')).match(/<w:style [^>]*w:styleId="Normal".*?<\/w:style>/s) || [''])[0];
  expect('the text is set in an installed family chosen for it, not left to Word', /w:rFonts w:ascii="(Calibri|Arial|Segoe UI)"/.test(normal) && !/PomeloNoSuchSans/.test(d.xml + normal), normal);
  fs.rmSync(docx);

  console.log('a centred title on two lines');
  [docx] = await convert.convertFile(draw('centred', 'centred'), 'docx');
  d = await read(docx);
  const title = (d.xml.match(/<w:p>(?:(?!<\/w:p>).)*A centred title(?:(?!<\/w:p>).)*<\/w:p>/s) || [''])[0];
  expect('it is one centred paragraph with no hanging or first-line indent, so Word cannot push it off the left margin', /<w:jc w:val="center"\/>/.test(title) && title.includes('a second line') && !/w:hanging|w:firstLine/.test(title), title.slice(0, 300));
  fs.rmSync(docx);

  console.log('lines that start with a word beginning in o');
  [docx] = await convert.convertFile(draw('words', 'words'), 'docx');
  d = await read(docx);
  expect('"of", "on", "or" and "one" at the start of a line are kept as words', !missingFrom(d.text, ['of the parts', 'on the next line', 'or one more']).length, d.text);
  expect('only the letter o on its own and the bullet glyph make list items', (d.xml.match(/<w:numPr>/g) || []).length === 2, (d.xml.match(/<w:numPr>/g) || []).length + ' list items');
  fs.rmSync(docx);

  console.log('a poster: text set freely on a coloured page');
  [docx] = await convert.convertFile(draw('poster', 'poster'), 'docx');
  d = await read(docx);
  const POSTER = ['SUMMER SALE', 'Everything half price this week,', 'shelves are full.', 'Open daily 9 to 5', 'www.example.com'];
  const boxes = d.xml.match(/<wp:anchor [^>]*>(?:(?!<\/wp:anchor>).)*?<wps:txbx>.*?<\/wp:anchor>/gs) || [];
  expect('the text is real text, in text boxes', boxes.length === 4 && !missingFrom(d.text, POSTER).length && !/<w:t[ >]/.test(d.xml.replace(/<w:txbxContent>.*?<\/w:txbxContent>/gs, '')), missingFrom(d.text, POSTER).join(' | '));
  const heading = boxes.find((b) => b.includes('SUMMER SALE')) || '';
  const at = (re) => Number((heading.match(re) || [])[1]) / 12700;
  expect('the title box sits where the title is on the sheet', Math.abs(at(/<wp:positionH [^>]*><wp:posOffset>(\d+)</) - 60) < 4 && Math.abs(at(/<wp:positionV [^>]*><wp:posOffset>(\d+)</) - 115) < 12, heading.slice(0, 400));
  expect('the page without its text is one picture behind the text, the size of the sheet', (d.xml.match(/behindDoc="1"/g) || []).length === 1 && /<wp:extent cx="7556500" cy="10693400"\/>/.test(d.xml));
  expect('the page is one sheet: it cannot flow onto another', (d.xml.match(/<w:sectPr/g) || []).length === 1);
  fs.rmSync(docx);

  console.log('line spacing of running text');
  const tightPara = (x) => (x.match(/<w:p>(?:(?!<\/w:p>).)*Tightly(?:(?!<\/w:p>).)*<\/w:p>/s) || [''])[0];
  [docx] = await convert.convertFile(draw('tight', 'tight'), 'docx');
  d = await read(docx);
  const multiple = Number((/w:line="(\d+)" w:lineRule="auto"/.exec(tightPara(d.xml)) || [])[1]);
  expect('tight lines on a document page are a multiple of the font\'s own line height, below one and above a half, so they follow the font size', !/<wps:txbx>/.test(d.xml) && multiple > 150 && multiple < 240, String(multiple));
  fs.rmSync(docx);
  [docx] = await convert.convertFile(draw('tight-design', 'tight', 'design'), 'docx');
  d = await read(docx);
  expect('the same lines in a text box on a designed page keep an exact height', /<wps:txbx>/.test(d.xml) && /w:lineRule="exact"/.test(tightPara(d.xml)), tightPara(d.xml).slice(0, 300));
  fs.rmSync(docx);

  console.log('a column of figures');
  for (const [name, extra] of [['figures', ''], ['figures-paper', 'paper']]) {
    [docx] = await convert.convertFile(draw(name, 'figures', extra), 'docx');
    d = await read(docx);
    expect(`${name}: figures of the same width are not justified text, so Word cannot break one across two lines`, !/<w:jc w:val="both"\/>/.test(d.xml) && !missingFrom(d.text, ['1,198,420', '431,066.5']).length, d.xml.match(/<w:jc [^>]*>/g)?.join(' '));
    fs.rmSync(docx);
  }

  console.log('a designed page whose text the PDF wrote column by column');
  [docx] = await convert.convertFile(draw('writtenorder', 'writtenorder'), 'docx');
  d = await read(docx);
  const placed = ['Left paragraph 1', 'Left paragraph 2', 'Left paragraph 3', 'Right paragraph 1', 'Right paragraph 2', 'Right paragraph 3'].map((t) => d.xml.indexOf(t));
  expect('the text boxes are in the order the PDF wrote them, not row by row', placed.every((p, i) => p >= 0 && (!i || placed[i - 1] < p)), placed.join(' '));
  fs.rmSync(docx);

  console.log('label and value rows, and columns, on a flowing page');
  [docx] = await convert.convertFile(draw('across', 'across'), 'docx');
  d = await read(docx);
  const rowOrder = ['Label 1', 'Value 1', 'Label 2', 'Value 2', 'Label 4', 'Value 4'].map((t) => d.text.indexOf(t));
  expect('rows the PDF wrote across read label, value, label, value', rowOrder.every((p, i) => p >= 0 && (!i || rowOrder[i - 1] < p)), d.text.slice(0, 300));
  const acrossCells = [...d.xml.matchAll(/<w:tc>.*?<\/w:tc>/gs)].map((m) => m[0].replace(/<[^>]+>/g, ''));
  expect('three columns the PDF wrote down each column are the three cells of one row', acrossCells.length === 3 && acrossCells[0].includes('Left column line 3') && acrossCells[1].includes('Middle column line 1') && !acrossCells[0].includes('Middle'), acrossCells.join(' | '));
  fs.rmSync(docx);

  console.log('a word turned by an angle that is not a quarter');
  [docx] = await convert.convertFile(draw('stamp', 'stamp'), 'docx');
  d = await read(docx);
  const angle = Number((/<a:xfrm rot="(\d+)"/.exec(d.xml) || [])[1]) / 60000;
  expect('it is real text in a text box turned 330 degrees clockwise, which is the 30 up to the right that the PDF shows', d.text.includes('APPROVED') && Math.abs(angle - 330) < 1, String(angle));
  const sharp = require('sharp');
  let green = 0;
  for (const name of Object.keys(d.zip.files).filter((n) => n.startsWith('word/media/'))) {
    const { data, info } = await sharp(await d.zip.file(name).async('nodebuffer')).raw().toBuffer({ resolveWithObject: true });
    for (let i = 0; i < data.length; i += info.channels) green += data[i] < 80 && data[i + 1] > 120 && data[i + 2] < 80;
  }
  expect('the word is not also in a picture, while the frame it crosses still is', green === 0 && /<pic:pic>/.test(d.xml), `${green} green pixels`);
  fs.rmSync(docx);

  console.log('tables on a designed page');
  [docx] = await convert.convertFile(draw('designtable', 'designtable'), 'docx');
  d = await read(docx);
  const tbls = d.xml.match(/<w:tbl>.*?<\/w:tbl>/gs) || [];
  const ruledTable = tbls.find((t) => t.includes('cell 22')) || '';
  const bareTable = tbls.find((t) => t.includes('TCP window scan')) || '';
  const inBoxes = [...d.xml.matchAll(/<w:txbxContent>(.*?)<\/w:txbxContent>/gs)].map((m) => m[1]).join('');
  expect('a ruled table and a table drawn with no rules are two Word tables placed on the sheet, one above the other',
    tbls.length === 2 && tbls.every((t) => /<w:tblpPr [^>]*w:vertAnchor="page"[^>]*w:tblpY="\d+"/.test(t) && /<w:tblOverlap w:val="overlap"\/>/.test(t)), `${tbls.length} tables`);
  const tableStyle = async (zip, tbl) => {
    const id = (tbl.match(/<w:tblStyle w:val="(\w+)"/) || [])[1];
    return ((await zip.file('word/styles.xml').async('string')).match(new RegExp(`<w:style [^>]*w:styleId="${id}".*?</w:style>`, 's')) || [''])[0];
  };
  const ruledStyle = await tableStyle(d.zip, ruledTable);
  expect('the ruled table has its nine cells, and its rules and shaded header come from its table style; none of its text is in a text box',
    (ruledTable.match(/<w:tc>/g) || []).length === 9 && /<w:tblStylePr w:type="firstRow">.*w:fill="1A4D80"/is.test(ruledStyle) && /<w:left w:val="single"/.test(ruledStyle) && !/cell \d\d|Price/.test(inBoxes), ruledStyle.slice(0, 300));
  expect('the rows without rules are four rows of two cells with no borders, and are not in text boxes',
    (bareTable.match(/<w:tr>/g) || []).length === 4 && (bareTable.match(/<w:tc>/g) || []).length === 8 && !/w:val="single"/.test(bareTable) && !/TCP|-sS/.test(inBoxes), bareTable.slice(0, 300));
  expect('the heading is still a text box and no row is an exact height', /PRICE LIST/.test(inBoxes) && !/<w:trHeight [^>]*w:hRule="exact"/.test(d.xml));
  fs.rmSync(docx);

  console.log('a table drawn as Word draws one');
  [docx] = await convert.convertFile(draw('wordtable', 'wordtable'), 'docx');
  d = await read(docx);
  const wordTable = (d.xml.match(/<w:tbl>.*?<\/w:tbl>/s) || [''])[0];
  const wordStyle = await tableStyle(d.zip, wordTable);
  const left = Number((wordTable.match(/<w:tblCellMar>.*?<w:left w:w="(\d+)"/s) || [])[1]) / 20;
  expect('three columns, not one for each side of a rule, and no merged cell', (wordTable.match(/<w:gridCol /g) || []).length === 3 && !/gridSpan/.test(wordTable) && (wordTable.match(/<w:tr>/g) || []).length === 5, wordTable.slice(0, 400));
  expect('the table has a style of its own that holds the rule, the navy header and the grey stripe, and the first row repeats',
    /<w:tblBorders>.*w:color="C9D4E0"/s.test(wordStyle) && /<w:tblStylePr w:type="firstRow">.*w:fill="12294A"/s.test(wordStyle) && /<w:tblStylePr w:type="band1Horz">.*w:fill="EDF2F7"/s.test(wordStyle)
      && /<w:tblLook [^>]*w:firstRow="1"[^>]*w:noHBand="0"/.test(wordTable) && /<w:tr><w:trPr>(?:(?!<\/w:trPr>).)*<w:tblHeader\/>/s.test(wordTable), wordStyle.slice(0, 500));
  expect('the cells state no fill and no border, and the padding is the gap between a rule and its text', !/<w:shd |<w:tcBorders/.test(wordTable) && Math.abs(left - 5.5) < 0.6, `padding ${left} pt`);
  fs.rmSync(docx);

  console.log('a header and stripes drawn as one rectangle for a whole row');
  for (const [name, mode, navy, band] of [['bandrow', 'row', '12294A', 'EDF2F7'], ['bandwide', 'wide', '731A33', 'F5E6B3'], ['bandcell', 'cell', '12294A', 'EDF2F7']]) {
    [docx] = await convert.convertFile(draw(name, 'bandtable', mode), 'docx');
    d = await read(docx);
    const bandTable = (d.xml.match(/<w:tbl[ >].*?<\/w:tbl>/s) || [''])[0];
    const bandStyle = await tableStyle(d.zip, bandTable);
    expect(`${name}: the white header text has its navy header and the stripes are in the table style, and no picture is left behind`,
      new RegExp(`<w:tblStylePr w:type="firstRow">.*w:fill="${navy}"`, 's').test(bandStyle) && new RegExp(`<w:tblStylePr w:type="band1Horz">.*w:fill="${band}"`, 's').test(bandStyle) && !/<w:drawing>/.test(d.xml), bandStyle.slice(0, 400));
    fs.rmSync(docx);
  }

  console.log('rules, bars and shapes that are not text');
  const shapes = (x) => x.match(/<wps:wsp[ >][^]*?<wps:cNvSpPr\/><wps:spPr>.*?<\/wps:spPr>/gs) || [];
  for (const [name, extra, color, length] of [['sigline', '', '663300', 140], ['sigline-bar', 'bar', '336699', 160]]) {
    [docx] = await convert.convertFile(draw(name, 'sigline', extra), 'docx');
    d = await read(docx);
    const lines = shapes(d.xml).filter((s) => /prst="line"/.test(s));
    const cx = Number((/<a:ext cx="(\d+)"/.exec(lines[0] || '') || [])[1]) / 12700;
    expect(`${name}: a line right of its label is a line shape of its colour and length`, lines.length === 1 && lines[0].includes(`<a:srgbClr val="${color}"/>`) && Math.abs(cx - length) < 2, `${lines.length} lines, ${cx} pt`);
    fs.rmSync(docx);
  }
  for (const [name, extra, side, size, color] of [['callout', '', 'left', 32, 'CC6600'], ['callout-top', 'top', 'top', 24, '333399'], ['callout-beside', 'beside', 'left', 32, 'CC6600']]) {
    [docx] = await convert.convertFile(draw(name, 'callout', extra), 'docx');
    d = await read(docx);
    expect(`${name}: the bar along the ${side} edge is that side of the box's border, and not a picture`,
      new RegExp(`<w:${side} w:val="single" w:sz="${size}" w:space="0" w:color="${color}"/>`).test(d.xml) && !/<w:drawing>/.test(d.xml) && !missingFrom(d.text, ['the callout text sits inside the box']).length, (d.xml.match(/<w:tcBorders>.*?<\/w:tcBorders>/s) || [''])[0]);
    fs.rmSync(docx);
  }
  for (const [name, extra, top] of [['caption', '', false], ['caption-top', 'top', true]]) {
    [docx] = await convert.convertFile(draw(name, 'caption', extra), 'docx');
    d = await read(docx);
    const media = await Promise.all(Object.keys(d.zip.files).filter((f) => /^word\/media\//.test(f)).map((f) => d.zip.file(f).async('nodebuffer')));
    const { data, info } = await require('sharp')(media.sort((p, q) => q.length - p.length)[0]).greyscale().raw().toBuffer({ resolveWithObject: true });
    const mean = (y0, y1) => { let sum = 0, n = 0; for (let y = Math.floor(info.height * y0); y < info.height * y1; y++) for (let x = 0; x < info.width; x++) { sum += data[y * info.width + x]; n++; } return sum / n; };
    const band = top ? mean(0.02, 0.1) : mean(0.9, 0.98), photo = top ? mean(0.5, 0.9) : mean(0.1, 0.5);
    expect(`${name}: the band drawn over the photo is in the picture, and the caption is text`, band < 90 && photo > 180 && !missingFrom(d.text, ['Caption on the band']).length, `band ${band.toFixed(0)}, photo ${photo.toFixed(0)}`);
    fs.rmSync(docx);
  }
  for (const [name, extra, fill, line] of [['rounded', '', 'CCCCFF', null], ['rounded-outline', 'outline', null, '<a:ln w="25400"><a:solidFill><a:srgbClr val="333399"/>']]) {
    [docx] = await convert.convertFile(draw(name, 'rounded', extra), 'docx');
    d = await read(docx);
    const round = shapes(d.xml).filter((s) => /prst="roundRect"/.test(s));
    expect(`${name}: the rounded box is a roundRect shape with its fill and border behind its text, the square one is not`,
      round.length === 1 && /<a:gd name="adj" fmla="val \d+"\/>/.test(round[0]) && (fill ? round[0].includes(`<a:solidFill><a:srgbClr val="${fill}"/>`) : round[0].includes('<a:noFill/>')) && (!line || round[0].includes(line))
        && (d.xml.match(/<w:shd /g) || []).length === 1 && !missingFrom(d.text, ['Text inside the rounded box', 'Text inside the square box']).length, round[0] ? round[0].slice(0, 300) : 'no shape');
    fs.rmSync(docx);
  }

  console.log('see-through text and colour');
  for (const [name, extra, alpha, fill] of [['faint', '', 70000, '8080FF'], ['faint-other', 'other', 40000, 'ADC2D6']]) {
    [docx] = await convert.convertFile(draw(name, 'faint', extra), 'docx');
    d = await read(docx);
    const stamp = (d.xml.match(/<w:r><w:rPr>(?:(?!<\/w:rPr>).)*<\/w:rPr><w:t[^>]*>STAMP<\/w:t>/s) || [''])[0];
    const val = Number((/<w14:alpha w14:val="(\d+)"\/>/.exec(stamp) || [])[1]);
    expect(`${name}: the see-through word keeps its transparency and the text under it is still there`, Math.abs(val - alpha) < 600 && /<w:color w:val="[0-9A-F]{6}"\/>/.test(stamp) && !missingFrom(d.text, ['Black text that a pale word crosses', 'STAMP']).length, `${val} in ${stamp.slice(0, 200)}`);
    expect(`${name}: the see-through box is shaded with the colour it makes on the paper`, d.xml.includes(`w:fill="${fill}"`) && !missingFrom(d.text, ['Text in the tinted box']).length, (d.xml.match(/w:fill="[0-9A-F]{6}"/g) || []).join(' '));
    fs.rmSync(docx);
  }

  console.log('a see-through box too faint for shading');
  for (const [name, extra] of [['veil', ''], ['veil-other', 'other']]) {
    [docx] = await convert.convertFile(draw(name, 'veil', extra), 'docx');
    d = await read(docx);
    let tinted = 0;
    for (const media of Object.keys(d.zip.files).filter((f) => /^word\/media\//.test(f))) {
      const { data } = await require('sharp')(await d.zip.file(media).async('nodebuffer')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      for (let i = 0; i < data.length; i += 3) if (Math.min(data[i], data[i + 1], data[i + 2]) > 150 && Math.min(data[i], data[i + 1], data[i + 2]) < 235) tinted++;
    }
    expect(`${name}: the colour stays in a picture, and the lines under it are ordinary text and not a table`,
      !/<w:tbl[ >]/.test(d.xml) && tinted > 500 && !missingFrom(d.text, ['Running paragraph number 4', 'Running paragraph number 6']).length, `${(d.xml.match(/<w:tbl[ >]/g) || []).length} tables, ${tinted} tinted pixels`);
    fs.rmSync(docx);
  }

  console.log('a turned word across running text');
  for (const [name, extra] of [['watermark', ''], ['watermark-other', 'other']]) {
    [docx] = await convert.convertFile(draw(name, 'watermark', extra), 'docx');
    d = await read(docx);
    let dark = 0;
    for (const media of Object.keys(d.zip.files).filter((f) => /^word\/media\//.test(f))) {
      const { data } = await require('sharp')(await d.zip.file(media).async('nodebuffer')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      for (let i = 0; i < data.length; i += 3) if (data[i] < 90 && data[i + 1] < 90 && data[i + 2] < 90) dark++;
    }
    expect(`${name}: the running text under the turned word is written once, and no picture holds it as well`,
      d.text.split('Running paragraph number 1 ').length === 2 && d.text.split('Running paragraph number 6 ').length === 2 && dark < 20, `${dark} dark pixels in the pictures`);
    fs.rmSync(docx);
  }

  console.log('text the sheet does not show');
  const hiddenWords = (xml) => [...xml.matchAll(/<w:r><w:rPr>(?:(?!<\/w:rPr>).)*<w:vanish\/>(?:(?!<\/w:rPr>).)*<\/w:rPr><w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('|');
  for (const [name, extra, hides, shows] of [['hiding', '', ['Covered words', 'Same as the ground', 'Invisible mode'], ['Visible black line', 'White on a dark box']],
    ['hiding-other', 'other', ['Covered words', 'Same as the ground', 'Invisible mode'], ['Visible black line', 'White on a dark box']]]) {
    [docx] = await convert.convertFile(draw(name, 'hiding', extra), 'docx');
    d = await read(docx);
    const gone = hiddenWords(d.xml);
    expect(`${name}: what the sheet hides is written as hidden text, so the words are in the file`, hides.every((t) => gone.includes(t)) && !missingFrom(d.text, hides).length, gone);
    expect(`${name}: what the sheet shows is not hidden, white text on a dark box included`, shows.every((t) => !gone.includes(t)) && !missingFrom(d.text, shows).length, gone);
    expect(`${name}: the hidden text takes no room, so the page is still one sheet`, (d.xml.match(/<w:sectPr/g) || []).length === 1);
    fs.rmSync(docx);
  }

  console.log('text in a clip mode is not hidden text');
  for (const [name, extra, hides, shows, clipped] of [['clipmode', '', 'Invisible mode', 'Plain visible line', 'Clipped mode'], ['clipmode-line', 'other', 'Invisible', 'Plain', 'Clipped']]) {
    [docx] = await convert.convertFile(draw(name, 'clipmode', extra), 'docx');
    d = await read(docx);
    const gone = hiddenWords(d.xml);
    expect(`${name}: the invisible mode is hidden text, and the clip mode is neither hidden text nor written as text, since the picture shows through its letters`,
      gone === hides && !d.text.includes(clipped) && !missingFrom(d.text, [shows]).length, `hidden "${gone}", text "${d.text.slice(0, 120)}"`);
    fs.rmSync(docx);
  }

  console.log('dot leaders');
  for (const [name, kind, extra, tails] of [['leaders', 'leaders', '', ['3', '14', '127']], ['leaders-other', 'leaders', 'other', ['3', '14', '127']]]) {
    [docx] = await convert.convertFile(draw(name, kind, extra), 'docx');
    d = await read(docx);
    const stops = d.xml.match(/<w:tab w:val="right" w:leader="dot" w:pos="\d+"\/>/g) || [];
    expect(`${name}: each contents line is a title, a tab with a dot leader and its page number, and no run of dots is written`,
      stops.length === 3 && (d.xml.match(/<w:tab\/>/g) || []).length === 3 && !/[.·]{3,}/.test(d.text) && !missingFrom(d.text, ['Introduction', 'Methods and materials', 'Results', ...tails]).length, `${stops.length} stops, ${d.text.slice(0, 160)}`);
    fs.rmSync(docx);
  }
  for (const [name, extra, leader] of [['stroke', '', 'dot'], ['stroke-dashed', 'other', 'hyphen']]) {
    [docx] = await convert.convertFile(draw(name, 'stroke', extra), 'docx');
    d = await read(docx);
    expect(`${name}: a ${leader === 'dot' ? 'dotted' : 'dashed'} stroke between a name and its price is the leader of the tab between them, and is not also drawn as a line`,
      new RegExp(`<w:tab w:val="(right|left)" w:leader="${leader}" w:pos="\\d+"/>`).test(d.xml) && !/prst="line"/.test(d.xml) && !missingFrom(d.text, ['Tomato soup', '4.50', 'Lemon tart', '5.25']).length, (d.xml.match(/<w:tabs>.*?<\/w:tabs>/) || [''])[0]);
    fs.rmSync(docx);
  }

  console.log('pages larger than Word allows');
  for (const [name, extra, ratio] of [['huge', '', 1700 / 2400], ['huge-banner', 'banner', 3000 / 400]]) {
    [docx] = await convert.convertFile(draw(name, 'huge', extra), 'docx');
    d = await read(docx);
    const sheet = /<w:pgSz w:w="(\d+)" w:h="(\d+)"/.exec(d.xml) || [];
    const [pw, ph] = [Number(sheet[1]), Number(sheet[2])];
    expect(`${name}: the page is scaled to fit the largest sheet Word has, in proportion, with its text and its link`,
      Math.max(pw, ph) <= 31680 && Math.max(pw, ph) > 31000 && Math.abs(pw / ph - ratio) < 0.02 * ratio && /<w:hyperlink /.test(d.xml) && !missingFrom(d.text, ['Visit the example site', 'A second line of the page that Word must still hold as text']).length, `${pw} x ${ph} twips`);
    fs.rmSync(docx);
  }

  console.log('letter spacing');
  const spacingOf = (xml, word) => Number((new RegExp(`<w:rPr>(?:(?!</w:rPr>).)*?<w:spacing w:val="(-?\\d+)"/>(?:(?!</w:rPr>).)*</w:rPr><w:t[^>]*>${word}</w:t>`, 's').exec(xml) || [])[1] || 0);
  for (const [name, extra, twips] of [['spaced', '', 20], ['spaced-other', 'other', 12]]) {
    [docx] = await convert.convertFile(draw(name, 'spaced', extra), 'docx');
    d = await read(docx);
    expect(`${name}: letters set apart are written with that spacing`, Math.abs(spacingOf(d.xml, 'TRACKED') - twips) <= 3 && !missingFrom(d.text, ['TRACKED']).length, String(spacingOf(d.xml, 'TRACKED')));
    fs.rmSync(docx);
  }
  for (const [name, extra] of [['marker', ''], ['marker-number', 'other']]) {
    [docx] = await convert.convertFile(draw(name, 'marker', extra), 'docx');
    d = await read(docx);
    const spaced = ['Gym', 'Pool', 'Spa'].filter((w) => spacingOf(d.xml, w) > 0);
    expect(`${name}: a short word after a list marker has no letter spacing, whatever the marker took of its box`, !spaced.length && !missingFrom(d.text, ['Gym', 'Pool', 'Spa']).length, spaced.join(' '));
    fs.rmSync(docx);
  }

  console.log('frames and the foot of the sheet');
  for (const [name, extra] of [['captions', ''], ['captions-other', 'other']]) {
    [docx] = await convert.convertFile(draw(name, 'captions', extra), 'docx');
    d = await read(docx);
    const frame = (word) => (new RegExp(`<w:framePr([^>]*)/>(?:(?!</w:p>).)*${word}`, 's').exec(d.xml) || [])[1] || '';
    expect(`${name}: the frame of one line has no width, so Word sizes it to its text, and the frame of two lines keeps one`,
      frame('One line caption') !== '' && !/w:w=/.test(frame('One line caption')) && /w:w="\d+"/.test(frame('First of two')), `${frame('One line caption')} | ${frame('First of two')}`);
    fs.rmSync(docx);
  }
  for (const [name, extra] of [['footrow', ''], ['footrow-letter', 'letter']]) {
    [docx] = await convert.convertFile(draw(name, 'footrow', extra), 'docx');
    d = await read(docx);
    expect(`${name}: a title and a number in the last 30 pt of the sheet are placed on it, not set after the text, where Word's own foot margin would push them to a new sheet`,
      isFramed(d, 'Annual report') && isFramed(d, 'Page 7') && !missingFrom(d.text, ['Annual report', 'Page 7']).length, 'not placed');
    fs.rmSync(docx);
  }

  console.log('placed text is written before the text that flows');
  for (const [name, extra] of [['fieldfoot', ''], ['fieldfoot-letter', 'letter']]) {
    [docx] = await convert.convertFile(draw(name, 'fieldfoot', extra), 'docx');
    d = await read(docx);
    const paras = d.xml.match(/<w:p>(?:(?!<\/w:p>).)*<\/w:p>/gs) || [];
    const framed = paras.map((p, i) => (/<w:framePr /.test(p) ? i : -1)).filter((i) => i >= 0);
    const flow = paras.findIndex((p) => !/<w:framePr /.test(p));
    expect(`${name}: the frames of a page are before its running text, so a page the text fills does not push them to the next sheet`,
      framed.length >= 4 && Math.max(...framed) < flow && !missingFrom(d.text, ['Annual report', 'Page 7', 'number 0', 'number 40']).length, `${framed.length} frames, flow from ${flow}, last frame ${Math.max(...framed)}`);
    expect(`${name}: the page is one section`, (d.xml.match(/<w:sectPr/g) || []).length === 1);
    fs.rmSync(docx);
  }

  console.log('very small text on a coloured bar');
  for (const [name, extra] of [['microtext', ''], ['microtext-small', 'small']]) {
    [docx] = await convert.convertFile(draw(name, 'microtext', extra), 'docx');
    d = await read(docx);
    expect(`${name}: the label is in the document each time it is drawn`, (d.text.match(/Gate in: seal and/g) || []).length === 3 && (d.text.match(/damage check/g) || []).length === 3, d.text.slice(0, 200));
    fs.rmSync(docx);
  }

  console.log('a box or a row that reaches the foot of the sheet');
  for (const [name, extra, limit] of [['fullbar', '', 842], ['fullbar-slide', 'slide', 540]]) {
    [docx] = await convert.convertFile(draw(name, 'fullbar', extra), 'docx');
    d = await read(docx);
    const heights = [...d.xml.matchAll(/<w:trHeight w:val="(\d+)"/g)].map((m) => Number(m[1]));
    expect(`${name}: no row is as tall as the sheet, so the paragraph after it does not start a new sheet`, heights.length > 0 && heights.every((h) => h <= (limit - 4) * 20), heights.join());
    expect(`${name}: the number on the bar is kept`, !missingFrom(d.text, ['Agenda', 'Item number 5', '2']).length);
    fs.rmSync(docx);
  }

  console.log('a line near the foot of a full page');
  for (const [name, extra] of [['footnear', ''], ['footnear-a4', 'a4']]) {
    [docx] = await convert.convertFile(draw(name, 'footnear', extra), 'docx');
    d = await read(docx);
    expect(`${name}: a line in the last 5 % of the sheet is placed on it, and the text above stays in the flow`, isFramed(d, 'Cat. No.') && isFramed(d, 'Rev. 3-2024') && !isFramed(d, 'number 5,'), 'not placed');
    fs.rmSync(docx);
  }
  [docx] = await convert.convertFile(draw('footnear-runon', 'footnear', 'runon'), 'docx');
  d = await read(docx);
  expect('body text that goes on to the foot of the sheet stays in its paragraph', !/<w:framePr /.test(d.xml) && !missingFrom(d.text, ['number 0,', 'number 48,']).length, (d.xml.match(/<w:framePr /g) || []).length + ' frames');
  fs.rmSync(docx);

  console.log('page class and tables');
  for (const [name, extra] of [['sheetgrid', ''], ['sheetgrid-rects', 'rects']]) {
    [docx] = await convert.convertFile(draw(name, 'sheetgrid', extra), 'docx');
    d = await read(docx);
    const rows = (d.xml.match(/<w:tr[ >]/g) || []).length;
    expect(`${name}: a ruled grid whose header band runs past it is a Word table of its rows, not a text box for each cell`, rows >= 30 && !/<wps:txbx>/.test(d.xml) && !missingFrom(d.text, ['CC-4129', 'Variance']).length, `${rows} rows`);
    fs.rmSync(docx);
  }
  for (const [name, extra] of [['shadedrows', ''], ['shadedrows-wide', 'wide']]) {
    [docx] = await convert.convertFile(draw(name, 'shadedrows', extra), 'docx');
    d = await read(docx);
    const cells = (d.xml.match(/<w:tc>.*?<\/w:tc>/gs) || []).map((c) => c.replace(/<[^>]+>/g, ''));
    const joined = cells.filter((c) => /CC-41\d\d/.test(c) && /[A-Za-z]{4}/.test(c.replace(/CC-41\d\d/g, '')));
    const inline = (d.xml.match(/<w:tc>(?:(?!<\/w:tc>).)*<wp:inline/gs) || []).length;
    expect(`${name}: a text that runs on from one cell into the next, and a shaded row that runs across columns, give a cell for each column, and neither a bar on the row of a figure nor a rule drawn twice adds a line to it`, cells.length >= 16 * 4 && !joined.length && !inline && !/<w:pBdr>/.test(d.xml) && !missingFrom(d.text, ['CC-4115', 'East Coast']).length, `${cells.length} cells, joined: ${joined.slice(0, 2).join(' | ')}`);
    fs.rmSync(docx);
  }
  for (const [name, extra] of [['chevrons', ''], ['chevrons-small', 'small']]) {
    [docx] = await convert.convertFile(draw(name, 'chevrons', extra), 'docx');
    d = await read(docx);
    expect(`${name}: filled shapes that are not rectangles stay in the file as a picture, with their white labels as text`, /<a:blip /.test(d.xml) && !missingFrom(d.text, ['Gate in', 'Vessel out', 'Yard stack', 'Quay: crane']).length);
    fs.rmSync(docx);
  }
  for (const [name, extra] of [['panel', ''], ['panel-a4', 'a4']]) {
    [docx] = await convert.convertFile(draw(name, 'panel', extra), 'docx');
    d = await read(docx);
    expect(`${name}: figures in a small outlined panel do not make a page of running text a designed page`, !/<wps:txbx>/.test(d.xml) && !missingFrom(d.text, ['number 0 ', 'number 33']).length, 'text boxes');
    fs.rmSync(docx);
  }
  for (const [name, extra] of [['bars', ''], ['bars-lines', 'lines']]) {
    [docx] = await convert.convertFile(draw(name, 'bars', extra), 'docx');
    d = await read(docx);
    expect(`${name}: the bars of a chart are not one shaded box`, !/w:fill="(E58033|33994D)"/i.test(d.xml) && /<a:blip /.test(d.xml) && !missingFrom(d.text, ['45800', 'below the chart']).length);
    fs.rmSync(docx);
  }
  for (const [name, extra] of [['clipped', ''], ['clipped-other', 'other'], ['clipped-edge', 'edge']]) {
    [docx] = await convert.convertFile(draw(name, 'clipped', extra), 'docx');
    d = await read(docx);
    const run = (word) => (new RegExp(`<w:r>(?:(?!</w:r>).)*${word}(?:(?!</w:r>).)*</w:r>`, 's').exec(d.xml) || [''])[0];
    const cut = extra !== 'edge';
    expect(`${name}: ${cut ? 'the part of a title that a clip path cuts off is hidden text, and all of it is still in the file' : 'letters cut by the edge of the sheet are not hidden'}`, cut === /<w:vanish\/>/.test(run('Berhad')) &&!/<w:vanish\/>/.test(run('Harbourline')) && !missingFrom(d.text, ['Harbourline Logistics Berhad: cost centre ledger']).length, run('Berhad').slice(0, 200));
    fs.rmSync(docx);
  }

  console.log('a rule below all the text');
  for (const [name, extra] of [['footrule', ''], ['footrule-bar', 'bar']]) {
    [docx] = await convert.convertFile(draw(name, 'footrule', extra), 'docx');
    d = await read(docx);
    expect(`${name}: a rule below everything is a line on the sheet and not a paragraph with a long space before it`, /prst="line"/.test(d.xml) && !/<w:pBdr><w:bottom/.test(d.xml) && !missingFrom(d.text, ['number 0', 'number 7']).length, (d.xml.match(/<w:pBdr>.*?<\/w:pBdr>/) || [''])[0]);
    fs.rmSync(docx);
  }

  console.log('a letter, a calendar and double spacing');
  for (const [name, extra] of [['letterhead', ''], ['letterhead-other', 'other']]) {
    [docx] = await convert.convertFile(draw(name, 'letterhead', extra), 'docx');
    d = await read(docx);
    expect(`${name}: a letter with a logo and a short address is ordinary text, not text boxes`, !/<wps:txbx>/.test(d.xml) && !missingFrom(d.text, ['Harbour and Sons Ltd', 'Telephone 020 5550 0142', 'line 12 of it']).length, `${(d.xml.match(/<wps:txbx>/g) || []).length} text boxes`);
    fs.rmSync(docx);
  }
  for (const [name, extra] of [['daygrid', ''], ['daygrid-other', 'other']]) {
    [docx] = await convert.convertFile(draw(name, 'daygrid', extra), 'docx');
    d = await read(docx);
    expect(`${name}: the day numbers of a calendar grid are not headings`, !/<w:pStyle w:val="Heading\d"\/>/.test(d.xml) && !missingFrom(d.text, ['35']).length, (d.xml.match(/<w:pStyle w:val="Heading\d"\/>/g) || []).length + ' headings');
    fs.rmSync(docx);
  }
  for (const [name, extra] of [['doublespace', ''], ['doublespace-wide', 'wide']]) {
    [docx] = await convert.convertFile(draw(name, 'doublespace', extra), 'docx');
    d = await read(docx);
    const para = (d.xml.match(/<w:p>(?:(?!<\/w:p>).)*Line 1\.(?:(?!<\/w:p>).)*<\/w:p>/s) || [''])[0];
    expect(`${name}: five lines at double spacing are one paragraph, whatever the spacing`, para.includes('Line 5.') && /w:lineRule="(atLeast|auto|exact)"/.test(para), para.slice(0, 200));
    fs.rmSync(docx);
  }

  console.log('statements, ruled paper and equations are ordinary text');
  for (const [name, extra] of [['stripedrows', ''], ['stripedrows-other', 'other']]) {
    [docx] = await convert.convertFile(draw(name, 'stripedrows', extra), 'docx');
    d = await read(docx);
    expect(`${name}: shaded rows without lines are one Word table of ordinary text, not text boxes`, !/<wps:txbx>/.test(d.xml) && (d.xml.match(/<w:tbl[ >]/g) || []).length >= 1 && !missingFrom(d.text, ['Item 0', 'Total 203']).length, `${(d.xml.match(/<wps:txbx>/g) || []).length} text boxes, ${(d.xml.match(/<w:tbl[ >]/g) || []).length} tables`);
    fs.rmSync(docx);
  }
  for (const [name, extra] of [['ruledpaper', ''], ['ruledpaper-other', 'other']]) {
    [docx] = await convert.convertFile(draw(name, 'ruledpaper', extra), 'docx');
    d = await read(docx);
    expect(`${name}: running text on ruled paper is ordinary text, not text boxes`, !/<wps:txbx>/.test(d.xml) && !missingFrom(d.text, ['Line 1 of', 'Line 28 of']).length, `${(d.xml.match(/<wps:txbx>/g) || []).length} text boxes`);
    fs.rmSync(docx);
  }
  for (const [name, extra] of [['mathpage', ''], ['mathpage-other', 'other']]) {
    [docx] = await convert.convertFile(draw(name, 'mathpage', extra), 'docx');
    d = await read(docx);
    expect(`${name}: paragraphs with rows of short equation pieces are ordinary text, not text boxes`, !/<wps:txbx>/.test(d.xml) && !missingFrom(d.text, ['Paragraph 1 line 1', 'Paragraph 3 line 5', 'E17']).length, `${(d.xml.match(/<wps:txbx>/g) || []).length} text boxes`);
    fs.rmSync(docx);
  }
  for (const [name, extra] of [['examgrid', ''], ['examgrid-other', 'other']]) {
    [docx] = await convert.convertFile(draw(name, 'examgrid', extra), 'docx');
    d = await read(docx);
    expect(`${name}: the labels of a ruled box that holds a sentence are text, not part of a picture`, !missingFrom(d.text, ['Instructions', 'Use black ink or black ball-point pen', 'Question', 'Mark']).length, d.text.slice(0, 300));
    fs.rmSync(docx);
  }
  for (const [name, extra, words] of [['chartlabels', '', ['Mar', 'Jun']], ['chartlabels-other', 'other', ['Q3', 'Q6']]]) {
    [docx] = await convert.convertFile(draw(name, 'chartlabels', extra), 'docx');
    d = await read(docx);
    expect(`${name}: the labels of a chart are text placed on the drawing, not pixels in it`, !missingFrom(d.text, words).length, d.text.slice(-200));
    fs.rmSync(docx);
  }
  for (const [name, extra] of [['wordmark', ''], ['wordmark-tall', 'tall']]) {
    [docx] = await convert.convertFile(draw(name, 'wordmark', extra), 'docx');
    d = await read(docx);
    expect(`${name}: a logo with its name beside it is placed on the sheet, so the name does not drop below it`, /<wp:anchor /.test(d.xml) && !/<wp:inline/.test(d.xml) && !missingFrom(d.text, ['Verdant and Co']).length, `${(d.xml.match(/<wp:inline/g) || []).length} inline pictures`);
    fs.rmSync(docx);
  }
  for (const [name, extra] of [['fragments', ''], ['fragments-other', 'other']]) {
    [docx] = await convert.convertFile(draw(name, 'fragments', extra), 'docx');
    d = await read(docx);
    expect(`${name}: pieces of mathematics that are no word stay text boxes at their places`, /<wps:txbx>/.test(d.xml), `${(d.xml.match(/<wps:txbx>/g) || []).length} text boxes`);
    fs.rmSync(docx);
  }
  for (const [name, extra] of [['beyond', ''], ['beyond-low', 'low']]) {
    [docx] = await convert.convertFile(draw(name, 'beyond', extra), 'docx');
    d = await read(docx);
    const frame = (new RegExp('<w:framePr([^>]*)/>(?:(?!</w:p>).)*Label on picture', 's').exec(d.xml) || [])[1] || '';
    expect(`${name}: the frame of one line outside the text column has a width, which Word would otherwise cut at the margin`, /w:w="\d+"/.test(frame) && !missingFrom(d.text, ['Label on picture']).length, frame);
    fs.rmSync(docx);
  }

  console.log('a statement with shaded rows and rules, and an index of names and numbers');
  for (const [name, extra, last] of [['statement', '', 29], ['statement-other', 'other', 21]]) {
    [docx] = await convert.convertFile(draw(name, 'statement', extra), 'docx');
    d = await read(docx);
    const tables = (d.xml.match(/<w:tbl[ >]/g) || []).length;
    const columns = (d.xml.match(/<w:gridCol /g) || []).length;
    expect(`${name}: the rows are one Word table of four columns, with no nested table and no text box`, tables === 1 && columns === 4 && !/<wps:txbx>/.test(d.xml) && !missingFrom(d.text, ['SHOP NUMBER 0', `SHOP NUMBER ${last}`, 'Amount']).length, `${tables} tables, ${columns} columns`);
    fs.rmSync(docx);
  }
  for (const [name, extra] of [['indexcols', ''], ['indexcols-other', 'other']]) {
    [docx] = await convert.convertFile(draw(name, 'indexcols', extra), 'docx');
    d = await read(docx);
    const entry = (new RegExp('<w:p>(?:(?!</w:p>).)*Entry 24 of column 2(?:(?!</w:p>).)*</w:p>', 's').exec(d.xml) || [''])[0];
    expect(`${name}: a name and its number are one line with a tab to the number's edge, not two lines`, !/<w:br\/>/.test(d.xml) && /<w:tab w:val="right" w:leader="none"/.test(entry) && /<w:t[^>]*>\d+<\/w:t>/.test(entry) && !missingFrom(d.text, ['Entry 1 of column 1', extra ? 'Entry 24 of column 2' : 'Entry 24 of column 3']).length, entry.slice(0, 300));
    fs.rmSync(docx);
  }

  console.log('mathematics: the letters of a TeX paper and the characters of its symbol fonts');
  const runOf = (xml, text) => (xml.match(/<w:r>.*?<\/w:r>/gs) || []).find((r) => r.replace(/<[^>]+>/g, '').replace(/\s/g, '').includes(squash(text))) || '';
  for (const [name, extra, letters, symbols] of [['mathfonts', '', 'CMMI10', 'XYZABC+CMSY10'], ['mathfonts-other', 'other', 'LMMathItalic10', 'QWERTY+MSAM10']]) {
    [docx] = await convert.convertFile(draw(name, 'mathfonts', extra), 'docx');
    d = await read(docx);
    const italic = runOf(d.xml, 'x+y=z');
    const symbol = runOf(d.xml, '(a=b)');
    expect(`${name}: plain letters in ${letters} are italic text in a text family, since Cambria Math would set them upright`, /<w:i\/>/.test(italic) && !/Cambria Math/.test(italic) && /w:rFonts w:ascii="[^"]+"/.test(italic), italic);
    expect(`${name}: a span in ${symbols} is written in Cambria Math, and running text beside it is not`, /w:rFonts w:ascii="Cambria Math"/.test(symbol) && !/Cambria Math/.test(runOf(d.xml, 'before the equation')), symbol);
    fs.rmSync(docx);
  }
  for (const [name, extra] of [['mathletters', ''], ['mathletters-other', 'other']]) {
    [docx] = await convert.convertFile(draw(name, 'mathletters', extra), 'docx');
    d = await read(docx);
    const letters = runOf(d.xml, extra ? '\u{1D6FC}' : '\u{1D44E}');
    expect(`${name}: mathematical letters (U+1D400 to U+1D7FF) are written in Cambria Math`, /w:rFonts w:ascii="Cambria Math"/.test(letters) && letters.includes(extra ? '\u{1D6FD}' : '\u{1D44F}'), letters);
    fs.rmSync(docx);
  }

  console.log('right-to-left text');
  for (const [name, extra] of [['rtl', ''], ['rtl-other', 'other']]) {
    [docx] = await convert.convertFile(draw(name, 'rtl', extra), 'docx');
    d = await read(docx);
    const paras = d.xml.match(/<w:p[ >].*?<\/w:p>/gs) || [];
    const arabic = paras.find((p) => p.includes('مرحبا')) || '';
    const hebrew = paras.find((p) => p.includes('שלום')) || '';
    const inOrder = (p, words) => { const at = words.map((w) => squash(p.replace(/<[^>]+>/g, '')).indexOf(squash(w))); return at.every((i, k) => i >= 0 && (!k || i > at[k - 1])); };
    expect(`${name}: each paragraph is one right-to-left paragraph, aligned to its start, not a paragraph for each line`, /<w:bidi\/>/.test(arabic) && /<w:bidi\/>/.test(hebrew) && !/<w:jc w:val="right"/.test(arabic + hebrew) && paras.filter((p) => /<w:bidi\/>/.test(p)).length === 2, `${paras.length} paragraphs`);
    expect(`${name}: the words are in reading order, the letters are the base letters (Word shapes them), the runs are marked right to left`, inOrder(arabic, ['مرحبا', 'بالعالم', 'سطر', 'للاختبار']) && !/[\ufb50-\ufdff\ufe70-\ufeff]/.test(arabic) && /<w:rtl\/>/.test(arabic), arabic.replace(/<[^>]+>/g, '').slice(0, 120));
    expect(`${name}: so are the words of the Hebrew paragraph${extra ? ', with a Latin word and a number inside the line and a Hebrew word after them' : ''}`, inOrder(hebrew, extra ? ['שלום', 'לבדיקה', 'PDF', '123', 'בסוף'] : ['שלום', 'פסקה', 'לבדיקה']), hebrew.replace(/<[^>]+>/g, '').slice(0, 120));
    fs.rmSync(docx);
  }

  console.log('form fields');
  const outlined = (xml) => (xml.match(/prst="rect"><a:avLst\/><\/a:prstGeom><a:noFill\/><a:ln w=/g) || []).length;
  for (const [name, extra, ticked, outlines, words] of [['fields', '', 2, 2, ['Employed', 'Retired', 'Student', 'Single', 'Married', 'Free text of the applicant.', 'Wednesday']], ['fields-other', 'other', 0, 2, ['Employed', 'Retired', 'Student', 'Single', 'Married', 'Surname', 'Forename']]]) {
    [docx] = await convert.convertFile(draw(name, 'fields', extra), 'docx');
    d = await read(docx);
    const count = (c) => d.text.split(c).length - 1;
    expect(`${name}: the five check boxes are characters, ${ticked} of them ticked, and no tick is left as a text of its own`, count('☐') === 5 - ticked && count('☒') === ticked && !missingFrom(d.text, words).length && !/✓|✔|Wingdings|ZapfDingbats/.test(d.text), d.text.slice(-120));
    expect(`${name}: the text area and the list box, or the two empty fields, keep their outline as a shape behind the text`, outlined(d.xml) === outlines, `${outlined(d.xml)} outlines`);
    fs.rmSync(docx);
  }

  console.log('check boxes drawn as squares');
  for (const [name, extra] of [['drawnboxes', ''], ['drawnboxes-other', 'other']]) {
    [docx] = await convert.convertFile(draw(name, 'drawnboxes', extra), 'docx');
    d = await read(docx);
    const numbering = await d.zip.file('word/numbering.xml').async('string');
    const glyphs = [...numbering.matchAll(/w:lvlText w:val="([^"]*)"/g)].map((m) => m[1]);
    expect(`${name}: each answer starts with an empty-box character from Segoe UI Symbol, not a round bullet`, (d.xml.match(/<w:numPr>/g) || []).length === 3 && glyphs.includes('☐') && !glyphs.includes('o') && /Segoe UI Symbol/.test(numbering) && !missingFrom(d.text, ['Employment', 'Study', 'Family reunion']).length, glyphs.join(' '));
    fs.rmSync(docx);
  }

  console.log('a font whose embedded subset has the metrics of another font');
  for (const [name, extra, line] of [['narrow', '', 'A line of narrow text for the foot of the page.'], ['narrow-other', 'other', 'A fictional form for software testing.']]) {
    [docx] = await convert.convertFile(draw(name, 'narrow', extra), 'docx');
    d = await read(docx);
    expect(`${name}: the line is set at the width the PDF has, with no letter spacing squeezed into it`, !missingFrom(d.text, [line]).length && !/<w:spacing w:val="-\d+"\/>/.test(d.xml), (d.xml.match(/<w:spacing w:val="-?\d+"\/>/g) || []).join(' '));
    fs.rmSync(docx);
  }

  console.log('answer choices and marks at the right edge');
  for (const [name, extra] of [['worksheet', ''], ['worksheet-other', 'other']]) {
    [docx] = await convert.convertFile(draw(name, 'worksheet', extra), 'docx');
    d = await read(docx);
    const where = ['1   Which', 'A  0', '[1 mark]', '2   Which', '[2 marks]', '3   Which', '[3 marks]', '4   Which', '[4 marks]', '5   Which', '[5 marks]'].map((t) => squash(d.text).indexOf(squash(t)));
    expect(`${name}: each mark comes after its question and its choices and before the next question, not all after the last one`, where.every((i, k) => i >= 0 && (!k || i > where[k - 1])), where.join(' '));
    fs.rmSync(docx);
  }

  console.log('the order check leaves a running title out');
  {
    const check = (a, b) => JSON.parse(execFileSync(engines.pdf, ['-I', '-W', 'ignore', path.join(__dirname, '../../fidelity/compare.py'), draw(a[0], 'running', a[1]), draw(b[0], 'running', b[1])], { encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 26 })).check;
    const same = check(['running-src', ''], ['running-top', 'top']);
    expect('a title that the source draws at the foot and the printout at the top is not a difference of order, and recall still counts it', same.order >= 0.99 && same.recall === 1, JSON.stringify(same));
    const swapped = check(['running-top2', 'top'], ['running-src2', '']);
    expect('nor is the other way round', swapped.order >= 0.99 && swapped.recall === 1, JSON.stringify(swapped));
  }

  console.log('a sheet stored sideways');
  for (const [name, what, angle, boxes] of [['sideways-drawing', 'drawing', '90', true], ['sideways-drawing-270', 'drawing', '270', true], ['sideways-text', 'text', '90', false], ['sideways-text-270', 'text', '270', false]]) {
    [docx] = await convert.convertFile(draw(name, 'sideways', what, angle), 'docx');
    d = await read(docx);
    const turned = (d.xml.match(/<wps:txbx>/g) || []).length;
    const sheet = /<w:pgSz w:w="(\d+)" w:h="(\d+)"/.exec(d.xml) || [];
    expect(`${name}: ${boxes ? 'a drawing with labels on a sideways sheet is a picture with a text box for each label' : 'running text on a sideways sheet stays flowing text in the one turned page'}, on one sheet the shape the PDF shows`,
      (d.xml.match(/<w:sectPr/g) || []).length === 1 && Number(sheet[1]) < Number(sheet[2]) && (boxes ? turned >= 5 && !missingFrom(d.text, ['North gate', 'Plant room']).length : turned === 1 && !missingFrom(d.text, ['line 1 of', 'line 14 of']).length), `${turned} text boxes, ${sheet[1]} x ${sheet[2]}`);
    fs.rmSync(docx);
  }

  console.log('a scan that carries its own text layer');
  for (const [name, extra] of [['layer', ''], ['layer-under', 'under'], ['layer-skew', 'skew']]) {
    [docx] = await convert.convertFile(draw(name, 'layer', extra), 'docx');
    d = await read(docx);
    const sheetPic = /<wp:anchor [^>]*behindDoc="1"[^>]*>.*?<wp:extent cx="(\d+)" cy="(\d+)"/s.exec(d.xml) || [];
    const media = Object.keys(d.zip.files).find((n) => n.startsWith('word/media/'));
    const { data: grey, info: gi } = await require('sharp')(await d.zip.file(media).async('nodebuffer')).greyscale().raw().toBuffer({ resolveWithObject: true });
    const mean = (x0, y0, x1, y1) => { const k = gi.width / 595; let sum = 0, n = 0; for (let y = Math.floor(y0 * k); y < y1 * k; y++) for (let x = Math.floor(x0 * k); x < x1 * k; x++) { sum += grey[y * gi.width + x]; n++; } return sum / n; };
    expect(`${name}: the layer is the text, as paragraphs, without the OCR component, and the picture stays behind it the size of the sheet`,
      !missingFrom(d.text, ['Quarterly Report of the Harbour', 'The first line of the letter', 'second line follows', 'third line closes']).length && Math.abs(sheetPic[1] / 12700 - 595) < 1 && Math.abs(sheetPic[2] / 12700 - 842) < 1, `${d.text.slice(0, 120)} | ${sheetPic[1]}`);
    expect(`${name}: the lines that are text are painted out of the picture, a title on plain paper included, and a signature stays in it, its word hidden text`,
      mean(55, 200, 330, 262) > 245 && mean(55, 70, 400, 108) > 245 && mean(55, 340, 250, 380) < 235 && !d.xml.replace(/<w:p[ >](?:(?!<\/w:p>).)*<w:vanish\/>(?:(?!<\/w:p>).)*<\/w:p>/gs, '').includes('Okafor') && d.xml.includes('Okafor'), `lines ${mean(55, 200, 330, 262).toFixed(0)}, title ${mean(55, 70, 400, 108).toFixed(0)}, signature ${mean(55, 340, 250, 380).toFixed(0)}`);
    if (name === 'layer-skew') expect('a slanted layer is written level, not as turned boxes', !/<wps:txbx>/.test(d.xml) && !/ rot="/.test(d.xml));
    fs.rmSync(docx);
  }

  console.log('short pieces of text with nothing drawn');
  [docx] = await convert.convertFile(draw('scatter', 'scatter'), 'docx');
  d = await read(docx);
  expect('an ordinary page: the text is paragraphs, not text boxes', !/<wps:wsp/.test(d.xml) && !missingFrom(d.text, ['Item 0', 'Item 19']).length, d.text.slice(0, 200));
  fs.rmSync(docx);

  console.log('a letter-spaced title that reaches the edge of its column');
  [docx] = await convert.convertFile(draw('tracked', 'tracked'), 'docx');
  d = await read(docx);
  const lastLetter = d.xml.match(/<w:r><w:rPr>((?:(?!<\/w:rPr>).)*)<\/w:rPr><w:t[^>]*>E<\/w:t>/s);
  expect('the last letter is its own run without the letter spacing, which Word would add after it and wrap the word', /INVOIC<\/w:t>/.test(d.xml) && lastLetter && !/w:spacing/.test(lastLetter[1]), (d.xml.match(/.{80}INVOIC.{120}/s) || [''])[0]);
  fs.rmSync(docx);

  console.log('two outlined boxes a few points apart');
  [docx] = await convert.convertFile(draw('outlined', 'outlined'), 'docx');
  d = await read(docx);
  expect('each box keeps its four sides', (d.xml.match(/<w:tbl>/g) || []).length === 2 && (d.xml.match(/<w:left w:val="single"/g) || []).length === 2 && (d.xml.match(/<w:right w:val="single"/g) || []).length === 2, (d.xml.match(/<w:tcBorders>.*?<\/w:tcBorders>/s) || [''])[0]);
  expect('"(1)" that opens a paragraph set flush is text, not a list item', !/<w:numPr>/.test(d.xml) && d.text.includes('(1) First line') && d.text.includes('(2) First line'), d.text);
  fs.rmSync(docx);

  console.log('a table drawn as nested rectangles');
  [docx] = await convert.convertFile(draw('nested', 'nested'), 'docx');
  d = await read(docx);
  expect('it is one table', (d.xml.match(/<w:tbl[ >]/g) || []).length === 1, (d.xml.match(/<w:tbl[ >]/g) || []).length + ' tables');
  expect('its figures are text, not a picture; what the table does not paint is behind it, not in a cell', !/<wp:inline/.test(d.xml) && !missingFrom(d.text, ['317', '334', '426', '443', '535', '644', '787', 'Gross profit']).length, d.text);
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

  console.log('a page with hundreds of pictures, then another page with pictures');
  [docx] = await convert.convertFile(draw('manypictures', 'manypictures'), 'docx');
  d = await read(docx);
  const ids = [...d.xml.matchAll(/<wp:docPr id="(\d+)"/g)].map((m) => m[1]);
  expect('the pictures are all there', ids.length >= 255, `${ids.length} drawings`);
  expect('every drawing id in the document is different, so Word has nothing to repair', new Set(ids).size === ids.length, `${ids.length - new Set(ids).size} repeated`);
  fs.rmSync(docx);

  console.log('a letter: a pull quote, a closing and signature, and rows that start with a flag');
  [docx] = await convert.convertFile(draw('limits', 'limits'), 'docx');
  d = await read(docx);
  const styled = (text) => ((d.xml.match(new RegExp(`<w:p>(?:(?!</w:p>).)*?${text}(?:(?!</w:p>).)*</w:p>`, 's')) || [''])[0].match(/<w:pStyle w:val="(\w+)"/) || [])[1];
  expect('a real heading is still a heading', styled('Section One') === 'Heading2', styled('Section One'));
  expect('a pull quote in quotation marks is not a heading', styled('Trust is built') === undefined, styled('Trust is built'));
  expect('a signature under a closing is not a heading', styled('A\\. Rahman') === undefined, styled('A\\. Rahman'));
  const flagParas = (d.xml.match(/<w:p>(?:(?!<\/w:p>).)*<\/w:p>/gs) || []).filter((p) => p.includes('-sU') || p.includes('scan type 3'));
  expect('a flag with a trailing space is not a list marker: it is not joined to the text beside it', !/<w:numPr>/.test(d.xml) && flagParas.length > 0 && !flagParas.some((p) => p.includes('-sU') && p.includes('scan type 3')), flagParas.join(' | ').slice(0, 300));
  const lastPara = (d.xml.match(/<w:p(?: [^>]*)?(?:\/>|>(?:(?!<\/w:p>).)*<\/w:p>)(?=<w:sectPr)/s) || ['none'])[0];
  expect('the last paragraph of the document is an ordinary one, so text typed at the end is visible', !/w:line="20"|<w:sz w:val="2"\/>/.test(lastPara), lastPara.slice(0, 300));
  fs.rmSync(docx);

  console.log('a paragraph that wraps by itself and ends in a line break');
  [docx] = await convert.convertFile(draw('abstract', 'abstract'), 'docx');
  d = await read(docx);
  const abstractPara = (d.xml.match(/<w:p>(?:(?!<\/w:p>).)*Keywords:(?:(?!<\/w:p>).)*<\/w:p>/s) || [''])[0];
  expect('it keeps the width of the PDF\'s lines as its right indent, so Word wraps it in the same places', /We measured/.test(abstractPara) && /<w:ind [^>]*w:right="\d+"/.test(abstractPara), abstractPara.slice(0, 300));
  fs.rmSync(docx);

  console.log('the same logo at the top of every page');
  [docx] = await convert.convertFile(draw('logo', 'logo'), 'docx');
  d = await read(docx);
  const headerPart = d.zip.file('word/header1.xml') ? await d.zip.file('word/header1.xml').async('string') : '';
  const headerRels = d.zip.file('word/_rels/header1.xml.rels') ? await d.zip.file('word/_rels/header1.xml.rels').async('string') : '';
  expect('the logo is one picture in the header part, related from it, and not on the pages', (headerPart.match(/<pic:pic>/g) || []).length === 1 && /relationships\/image"/.test(headerRels) && !/<pic:pic>/.test(d.xml), `${(headerPart.match(/<pic:pic>/g) || []).length} in the header`);
  expect('every page has the same header, so the logo is edited once', (d.xml.match(/<w:headerReference /g) || []).length === 1 && !d.zip.file('word/header2.xml') && !missingFrom(d.text, ['Body text of page 1', 'Body text of page 3']).length);
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
    expect('the text of the scan is recognised and is real, editable text, the large heading on plain paper too', found.length === 4, `${found.length} of 4: ${d.text.slice(0, 120)}`);
    expect('and the temporary OCR copy of the PDF is deleted', left.length === 0, left.join(', '));
    const sheet = /<wp:anchor [^>]*behindDoc="1"[^>]*>.*?<wp:extent cx="(\d+)" cy="(\d+)"/s.exec(d.xml) || [];
    expect('the scan stays as one picture the size of the sheet behind the text', Math.abs(sheet[1] / 12700 - 595) < 1 && Math.abs(sheet[2] / 12700 - 842) < 1, `${sheet[1]} x ${sheet[2]}`);
    const sharp = require('sharp');
    const name = Object.keys(d.zip.files).find((n) => n.startsWith('word/media/'));
    const { data, info } = await sharp(await d.zip.file(name).async('nodebuffer')).greyscale().raw().toBuffer({ resolveWithObject: true });
    const mean = (x0, y0, x1, y1) => {
      const k = info.width / 595;
      let sum = 0, count = 0;
      for (let y = Math.floor(y0 * k); y < y1 * k; y++) for (let x = Math.floor(x0 * k); x < x1 * k; x++) { sum += data[y * info.width + x]; count++; }
      return sum / count;
    };
    expect('the lines that are text are painted out of the picture, the large heading on plain paper with them', mean(55, 185, 330, 262) > 250 && mean(55, 70, 300, 105) > 250,
      `text ${mean(55, 185, 330, 262).toFixed(0)}, heading ${mean(55, 70, 300, 105).toFixed(0)}`);
    fs.rmSync(docx);
  }

  console.log('bullets written with a zero-width character after them');
  for (const [face, zw, size] of [['arial', '200b', '11'], ['segoeui', 'feff', '14'], ['arial', '200b', '9']]) {
    [docx] = await convert.convertFile(draw(`zwlist-${face}-${size}`, 'zwlist', `${face}:${zw}`, size), 'docx');
    d = await read(docx);
    const items = ['First item of the plan', 'Second item of the plan', 'Third item that runs a little longer than the others'];
    expect(`each of the three items is a list item (${face}, U+${zw.toUpperCase()}, ${size} pt)`, (d.xml.match(/<w:numPr>/g) || []).length === 3 && !missingFrom(d.text, items).length, `${(d.xml.match(/<w:numPr>/g) || []).length} list items`);
    expect('no zero-width character reaches the document', !/[\u200b\ufeff\u2060]/.test(d.xml));
    fs.rmSync(docx);
  }

  console.log('a text map that gives half of a surrogate pair');
  for (const [hex, size] of [['D835', '12'], ['DC450041', '16']]) {
    [docx] = await convert.convertFile(draw(`badmap-${hex}`, 'badmap', hex, size), 'docx');
    d = await read(docx);
    expect(`the page converts and keeps its words (U+${hex.slice(0, 4)}, ${size} pt)`, !missingFrom(d.text, ['line of plain words after the letter']).length && !/[\ud800-\udfff]/.test(d.xml), d.text.slice(0, 80));
    fs.rmSync(docx);
  }

  console.log('numbered clauses whose numbers stand left of their text');
  for (const [labels, at] of [['1.,2.,3.', '60:74'], ['(a),(b),(c)', '90:112']]) {
    [docx] = await convert.convertFile(draw(`clauses-${at.replace(':', '-')}`, 'clauses', labels, at), 'docx');
    d = await read(docx);
    const [nx, tx] = at.split(':').map(Number);
    const inds = [...d.xml.matchAll(/<w:numPr>.*?<w:ind w:left="(\d+)" w:hanging="(\d+)"/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(`the three clauses are numbered paragraphs whose number stands ${tx - nx} pt left of the text, at the margin (${labels})`,
      inds.length === 3 && inds.every(([left, hanging]) => Math.abs(left - (tx - nx) * 20) <= 20 && Math.abs(hanging - (tx - nx) * 20) <= 20), JSON.stringify(inds));
    fs.rmSync(docx);
  }

  console.log('numbered paragraphs in text boxes over a picture');
  for (const [labels, starts] of [['6.,7.,8.', [6, 7, 8]], ['(c),(d),(e)', [3, 4, 5]]]) {
    [docx] = await convert.convertFile(draw(`boxlist-${starts[0]}`, 'boxlist', labels), 'docx');
    d = await read(docx);
    const numbering = await d.zip.file('word/numbering.xml').async('string');
    const startOf = (id) => {
      const abstract = numbering.split(`<w:num w:numId="${id}"`)[1].match(/w:abstractNumId w:val="(\d+)"/)[1];
      return Number(numbering.split(`w:abstractNumId="${abstract}"`)[1].match(/<w:start w:val="(\d+)"/)[1]);
    };
    const got = [...d.xml.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map((m) => startOf(m[1]));
    expect(`each item counts from its own number, because a text box does not continue the list before it (${labels})`, JSON.stringify(got) === JSON.stringify(starts), JSON.stringify(got));
    fs.rmSync(docx);
  }

  console.log('contents pages: dot leaders, page numbers at the right edge, a table of contents field');
  for (const style of ['text', 'apart', 'stroke']) {
    [docx] = await convert.convertFile(draw(`contents-${style}`, 'contents', style), 'docx');
    d = await read(docx);
    const entries = d.xml.match(/<w:p>(?:(?!<\/w:p>).)*?(?:Executive summary|Key figures at a glance|Service performance)(?:(?!<\/w:p>).)*?<\/w:p>/gs) || [];
    const contents = entries.filter((p) => /<w:tab\/>/.test(p) && /<w:t[^>]*>\s*[34]\s*<\/w:t>/.test(p));
    expect(`each contents entry has a right tab with a dot leader to the page number (leader drawn as ${style})`,
      contents.length === 3 && contents.every((p) => /<w:tab w:val="right" w:leader="dot" w:pos="\d+"\/>/.test(p)), `${contents.length} entries`);
    expect('no contents title is squeezed with negative letter spacing', !contents.some((p) => /<w:spacing w:val="-\d+"\/>/.test(p)));
    const styles = await d.zip.file('word/styles.xml').async('string');
    expect('the entries are a Word table of contents that links to the headings it lists',
      / TOC \\o "1-3" \\h \\z \\u /.test(d.xml) && (d.xml.match(/w:anchor="_Toc\d+"/g) || []).length === 3 && (d.xml.match(/<w:bookmarkStart [^>]*w:name="_Toc\d+"/g) || []).length === 3
      && /w:styleId="TOC1"/.test(styles) && /w:styleId="TOC2"/.test(styles) && /<w:pStyle w:val="TOC2"\/>/.test(d.xml));
    fs.rmSync(docx);
  }
  [docx] = await convert.convertFile(draw('contents-missing', 'contents', 'text', 'none'), 'docx');
  d = await read(docx);
  expect('a contents list with an entry that no heading matches stays plain paragraphs', !/ TOC \\o /.test(d.xml) && !/w:anchor="_Toc/.test(d.xml) && /w:leader="dot"/.test(d.xml));
  fs.rmSync(docx);

  console.log('a PDF outline with no contents page');
  [docx] = await convert.convertFile(draw('outline', 'outline'), 'docx');
  d = await read(docx);
  expect('each outline entry bookmarks its heading, and no table of contents is made', (d.xml.match(/<w:bookmarkStart [^>]*w:name="section_\d+"/g) || []).length === 2 && !/ TOC \\o /.test(d.xml));
  fs.rmSync(docx);

  console.log('footnotes');
  for (const [name, mode] of [['numbers', 'numbers'], ['symbols', 'symbols'], ['orphan', 'orphan']]) {
    [docx] = await convert.convertFile(draw(`notes-${mode}`, 'notes', mode), 'docx');
    d = await read(docx);
    const notes = d.zip.file('word/footnotes.xml') ? await d.zip.file('word/footnotes.xml').async('string') : '';
    const wanted = mode === 'orphan' ? 1 : 2;
    expect(`${name}: each note with a raised mark in the text is a Word footnote, and the text holds a reference to it`,
      (notes.match(/<w:footnote w:id="\d+"/g) || []).length === wanted && (d.xml.match(/<w:footnoteReference /g) || []).length === wanted && /Note one: the method is set out/.test(notes), `${(notes.match(/<w:footnote w:id/g) || []).length} notes`);
    expect(`${name}: the notes are no longer paragraphs of the page`, !/Note one: the method/.test(d.text) && (mode === 'orphan' ? /Note two: the method/.test(d.text) : !/Note two: the method/.test(d.text)), d.text.slice(-200));
    if (mode === 'symbols') expect('a symbol is kept as the note\'s own mark', (d.xml.match(/w:customMarkFollows="1"/g) || []).length === 2 && /<w:t>\*<\/w:t>/.test(d.xml));
    else expect('a mark that is the number Word would give is Word\'s own', /<w:footnoteRef\/>/.test(notes) && !/customMarkFollows/.test(d.xml));
    fs.rmSync(docx);
  }

  console.log('a footnote under two columns');
  for (const [name, extra] of [['A4', ''], ['Letter', 'letter']]) {
    [docx] = await convert.convertFile(draw(`notecols-${name}`, 'notecols', extra), 'docx');
    d = await read(docx);
    expect(`${name}: the page keeps its Word columns and its note stays a paragraph, because Word lays footnotes out badly under columns`,
      /<w:cols w:num="2"/.test(d.xml) && !d.zip.file('word/footnotes.xml') && /Note one: the method is set out/.test(d.text));
    fs.rmSync(docx);
  }

  console.log('a heading of a section number and a title');
  for (const size of ['14', '18']) {
    [docx] = await convert.convertFile(draw(`numhead-${size}`, 'numhead', size), 'docx');
    d = await read(docx);
    const head = (d.xml.match(/<w:p>(?:(?!<\/w:p>).)*?Interruptions and outages(?:(?!<\/w:p>).)*?<\/w:p>/s) || [''])[0];
    expect(`the number and the title are one paragraph with a tab stop at the title (${size} pt)`, />2\.3\s*<\/w:t>/.test(head) && /<w:tab\/>/.test(head) && /<w:tab w:val="left" w:pos="\d+"\/>/.test(head), head.slice(0, 300));
    fs.rmSync(docx);
  }

  console.log('a paragraph that runs round a picture or a box at the edge of the column');
  const outer = (xml) => xml.replace(/<w:txbxContent>.*?<\/w:txbxContent>/gs, '');
  const textOf = (xml) => [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('');
  const paraWith = (xml, word) => (outer(xml).match(new RegExp(`<w:p[ >](?:(?!</w:p>).)*${word}(?:(?!</w:p>).)*</w:p>`, 's')) || [''])[0];
  for (const [name, kind, extra, more] of [['right', 'wrap', 'right', ''], ['left with a caption', 'wrap', 'left', 'caption'], ['box on the left', 'quote', 'left', ''], ['filled box on the right', 'quote', 'right', '']]) {
    [docx] = await convert.convertFile(draw(`${kind}-${extra}-${more}`, kind, extra, more), 'docx');
    d = await read(docx);
    const para = paraWith(d.xml, 'Pressure management');
    expect(`the text beside the ${name} is one paragraph with no line breaks`, textOf(para).length >= 1200 && (para.match(/<w:br\/>/g) || []).length <= 1, `${textOf(para).length} characters`);
    expect(`the ${name} is anchored in it, to the column and the paragraph, with square wrapping`,
      /<wp:wrapSquare wrapText="bothSides"\/>/.test(para) && /relativeFrom="column"/.test(para) && /relativeFrom="paragraph"/.test(para));
    expect(`the ${name} sets no layout table beside the text`, !/<w:tbl>/.test(outer(d.xml)));
    if (more) expect('the caption goes with the picture, in a box that wraps the same way', /<w:txbxContent>(?:(?!<\/w:txbxContent>).)*Figure 2/s.test(d.xml));
    if (kind === 'quote') expect('the words of the box are in the box', /<w:txbxContent>(?:(?!<\/w:txbxContent>).)*We used to get water/s.test(d.xml));
    fs.rmSync(docx);
  }

  console.log('a highlighted phrase');
  for (const across of ['', 'across']) {
    [docx] = await convert.convertFile(draw(`marked-${across}`, 'marked', across), 'docx');
    d = await read(docx);
    const shaded = textOf((d.xml.match(/<w:r>(?:(?!<\/w:r>).)*?w:fill="FFFF00"(?:(?!<\/w:r>).)*?<\/w:r>/gs) || []).join(''));
    expect(across ? 'a highlight over the end of a line and the start of the next is shading on those words' : 'a highlight over part of a line is shading on those words',
      across ? /before the report/.test(shaded) && /was sent to the board,/.test(shaded) : /highlighted phrase here/.test(shaded) && !/second reading/.test(shaded), shaded);
    expect('the highlight is no shape behind the text', !/<w:drawing>/.test(d.xml));
    fs.rmSync(docx);
  }

  console.log('a drop capital drawn after, or before, the lines beside it');
  for (const [size, before] of [['48', ''], ['36', 'first']]) {
    [docx] = await convert.convertFile(draw(`lastcap-${size}`, 'lastcap', size, before), 'docx');
    d = await read(docx);
    expect(`the large letter is a Word drop capital over the three lines it stands beside (${size} pt)`,
      /<w:framePr w:dropCap="drop" w:lines="3"[^>]*\/>(?:(?!<\/w:p>).)*<w:t[^>]*>T<\/w:t>/s.test(d.xml));
    expect('the lines beside it and the lines under it are one paragraph', textOf(paraWith(d.xml, 'ressure management')).length >= 300);
    fs.rmSync(docx);
  }

  console.log('a hyphen at the end of a line');
  for (const size of ['10', '12']) {
    [docx] = await convert.convertFile(draw(`hyphen-${size}`, 'hyphen', size), 'docx');
    d = await read(docx);
    const flat = squash(d.text);
    expect(`a line that stops short of the right edge keeps its hyphen (${size} pt)`, /three-month/.test(flat), d.text);
    expect('a line justified to both edges loses the hyphen it was broken at', /department/.test(flat) && !/depart-/.test(flat), d.text);
    expect('a number from twenty-one to ninety-nine keeps its hyphen in justified text', /forty-five/.test(flat), d.text);
    fs.rmSync(docx);
  }

  console.log('a built-up equation');
  const hiddenRuns = (xml) => xml.match(/<w:r>(?:(?!<\/w:r>).)*<w:vanish\/>(?:(?!<\/w:r>).)*<\/w:r>/gs) || [];
  const shown = (xml) => xml.replace(/<w:r>(?:(?!<\/w:r>).)*<w:vanish\/>(?:(?!<\/w:r>).)*<\/w:r>/gs, '');
  for (const [name, size, mode, words] of [['a fraction', '11', 'fraction', ['a+b', 'c+d']], ['a fraction at 16 pt', '16', 'fraction', ['a+b', 'c+d']], ['a sum with limits', '12', 'sum', ['i=1', 'n']], ['a sum at 18 pt', '18', 'sum', ['i=1', 'n']]]) {
    [docx] = await convert.convertFile(draw(`builtup-${mode}-${size}`, 'builtup', size, mode), 'docx');
    d = await read(docx);
    const para = paraWith(d.xml, 'name="Equation');
    expect(`${name} is one inline picture in a paragraph of its own`, (d.xml.match(/<wp:inline /g) || []).length === 1 && para !== '' && !/<w:framePr /.test(para) && (d.xml.match(/<w:pgSz /g) || []).length === 1);
    expect(`${name}: the text of its parts follows the picture as hidden text and none of it shows`,
      words.every((w) => squash(textOf(hiddenRuns(para).join(''))).includes(w)) && !words.some((w) => w.length > 1 && squash(textOf(shown(d.xml))).includes(w)), textOf(hiddenRuns(para).join('')));
    expect(`${name}: its number is text in the same paragraph, after a tab`, /\(1\)/.test(textOf(shown(para))) && /<w:tab\/>/.test(para));
    expect(`${name}: the paragraphs round it stay text`, /above the equation runs on over line 1/.test(textOf(shown(d.xml))) && /below the equation carries on from line 3/.test(textOf(shown(d.xml))));
    fs.rmSync(docx);
  }
  for (const size of ['11', '14']) {
    [docx] = await convert.convertFile(draw(`builtup-inline-${size}`, 'builtup', size, 'inline'), 'docx');
    d = await read(docx);
    const para = paraWith(d.xml, 'name="Equation');
    expect(`a fraction inside a line of text stays in that paragraph, as an inline picture (${size} pt)`,
      /The leak rate is/.test(textOf(shown(para))) && /input volume, as measured on site/.test(textOf(shown(para))) && (d.xml.match(/<wp:inline /g) || []).length === 1 && !/<w:br\/>/.test(para));
    expect(`its numerator and denominator are not paragraphs of their own (${size} pt)`, !/a\+b/.test(textOf(shown(d.xml))) && /a\+b/.test(textOf(hiddenRuns(para).join(''))));
    fs.rmSync(docx);
  }

  console.log('a colour scale against the panels of a figure');
  for (const side of ['right', 'left']) {
    [docx] = await convert.convertFile(draw(`scale-${side}`, 'scale', side), 'docx');
    d = await read(docx);
    expect(`the scale on the ${side} keeps its place on the sheet with the panels, so the caption stays under them`, !/<wp:inline /.test(d.xml) && /Figure 1\./.test(d.text), `${(d.xml.match(/<wp:inline /g) || []).length} in-line pictures`);
    fs.rmSync(docx);
  }

  console.log('a table whose first column has no rule at its side');
  for (const [name, scale] of [['a table set l|cc', '1'], ['a wider one', '1.2']]) {
    [docx] = await convert.convertFile(draw(`labelcol-${scale}`, 'labelcol', scale), 'docx');
    d = await read(docx);
    const cell = (word) => new RegExp(`<w:tc>(?:(?!</w:tc>).)*${word}`, 's').test(d.xml);
    expect(`${name}: the column of labels is a column of the table`, /<w:tblGrid>(?:<w:gridCol [^>]*\/>){3}<\/w:tblGrid>/.test(d.xml) && cell('VGG-16') && cell('Faster R-CNN') && cell('73.2'), (d.xml.match(/<w:tblGrid>.*?<\/w:tblGrid>/s) || [''])[0]);
    fs.rmSync(docx);
  }

  console.log('the frame and gridlines of a plot');
  for (const [name, scale] of [['a plot', '1'], ['a larger plot', '1.4']]) {
    [docx] = await convert.convertFile(draw(`plotframe-${scale}`, 'plotframe', scale), 'docx');
    d = await read(docx);
    expect(`${name}: its gridlines are not read as a table`, !/<w:tbl>/.test(d.xml) && /Text under the plot, line 1/.test(d.text), `${(d.xml.match(/<w:tbl>/g) || []).length} tables`);
    fs.rmSync(docx);
  }

  console.log('the closing paragraph of the last page');
  for (const [name, kind, small] of [['a page in two columns', 'flow', true], ['a page of text', 'text', false]]) {
    [docx] = await convert.convertFile(draw(`ending-${kind}`, kind, kind === 'text' ? '1' : ''), 'docx');
    d = await read(docx);
    const last = (d.xml.slice(0, d.xml.lastIndexOf('<w:sectPr')).match(/<w:p\/>$|<w:p>(?:(?!<w:p>).)*$/s) || [''])[0];
    expect(small ? `${name}: the paragraph that ends the document is one point high, so a full last column does not add a sheet` : `${name}: the paragraph that ends the document is an ordinary one, so text typed there has the body size`,
      /w:line="20" w:lineRule="exact"/.test(last) === small, last.slice(0, 200));
    fs.rmSync(docx);
  }

  console.log('justified lines that break words with a hyphen');
  for (const [name, size, mode] of [['A4 at 10 pt', '10', 'yes'], ['Letter at 11 pt', '11', 'yes-letter'], ['whole words at line ends', '10', 'no']]) {
    [docx] = await convert.convertFile(draw(`hyphens-${size}-${mode}`, 'hyphens', size, mode), 'docx');
    d = await read(docx);
    const settings = await d.zip.file('word/settings.xml').async('string');
    const body = paraWith(d.xml, 'council');
    const head = paraWith(d.xml, 'Report on');
    if (mode === 'no') expect(`${name}: Word is not asked to hyphenate`, !/<w:autoHyphenation/.test(settings) && !/suppressAutoHyphens/.test(d.xml));
    else {
      expect(`${name}: Word hyphenates, so its lines break where the original's did`, /<w:autoHyphenation\/>/.test(settings));
      expect(`${name}: the justified paragraph may hyphenate and the heading may not`, /<w:suppressAutoHyphens w:val="0"\/>/.test(body) && !/<w:suppressAutoHyphens w:val="0"\/>/.test(head), body.slice(0, 200));
      expect(`${name}: the broken words are whole in the text`, /important/.test(squash(d.text)) && /government/.test(squash(d.text)));
    }
    fs.rmSync(docx);
  }

  console.log('the labels around a plot drawn as curves');
  for (const [name, scale] of [['a small plot', '1'], ['a larger plot', '1.5']]) {
    [docx] = await convert.convertFile(draw(`axes-${scale}`, 'axes', scale), 'docx');
    d = await read(docx);
    expect(`${name}: the tick labels at its left and under it stand at their places, none is a paragraph of the text`,
      ['20', '10', 'iter.'].every((w) => isFramed(d, `>${w}`)) && /Text under the plot, line 1/.test(d.text), d.text.slice(0, 200));
    fs.rmSync(docx);
  }

  console.log('a scan stored sideways with a text layer');
  const hiddenOf = (xml) => squash(textOf(hiddenRuns(xml).join('')));
  const pixelsIn = async (d, [x0, y0, x1, y1]) => {
    const media = Object.keys(d.zip.files).find((n) => n.startsWith('word/media/'));
    const { data, info } = await require('sharp')(await d.zip.file(media).async('nodebuffer')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const k = info.width / 595;
    let n = 0, low = 255, coloured = 0;
    for (let y = Math.floor(y0 * k); y < y1 * k; y++) for (let x = Math.floor(x0 * k); x < x1 * k; x++) {
      const i = (y * info.width + x) * 3;
      n += data[i] > 150 && data[i + 1] < 90 && data[i + 2] < 100 ? 1 : 0;
      low = Math.min(low, data[i], data[i + 1], data[i + 2]);
      coloured += Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) > 60 ? 1 : 0;
    }
    return { red: n, low, coloured };
  };
  for (const size of ['11', '14']) {
    [docx] = await convert.convertFile(draw(`scan-sideways-${size}`, 'scan-sideways', size), 'docx');
    d = await read(docx);
    const said = ['Cost summary for the harbour depot', 'The first line of the report', 'A second line follows it'];
    expect(`the layer of a sideways scan is written once, as hidden text, and does not print over the text of the picture (${size} pt)`,
      said.every((t) => hiddenOf(d.xml).includes(squash(t)) && !squash(textOf(shown(d.xml))).includes(squash(t))), `${hiddenOf(d.xml).slice(0, 80)} | ${textOf(shown(d.xml)).slice(0, 80)}`);
    fs.rmSync(docx);
  }

  console.log('a scan that carries the show-through of its other side');
  if (!engines.ocr) console.log('  OCR component not installed: skipped');
  else {
    for (const [name, spec] of [['mirrored text at 14 pt', '0.9:mirror:14'], ['plain text at 11 pt', '0.9:plain:11']]) {
      [docx] = await convert.convertFile(draw(`scan-faint-${spec.replace(/[:.]/g, '')}`, 'scan-faint', spec), 'docx');
      d = await read(docx);
      expect(`${name}: the dark line is text, the faint ghost of the other side is not written at all`,
        /Delivery/.test(textOf(shown(d.xml))) && squash(textOf(shown(d.xml))).length < 60 && !hiddenRuns(d.xml).length && !/Back|ghost|daylight/i.test(d.text), d.text.slice(0, 160));
      fs.rmSync(docx);
    }
  }

  console.log('a stamp on a scan');
  const LETTER = ['The goods listed below', 'Questions about this delivery'];
  [docx] = await convert.convertFile(draw('scan-stamp-over', 'scan-stamp', 'over:0:11'), 'docx');
  d = await read(docx);
  expect('lines under a stamp stay in the picture with their words hidden, the others are text', !missingFrom(textOf(shown(d.xml)), LETTER).length && !/Any damage|A second copy|RECEIVED/.test(textOf(shown(d.xml)))
    && ['Anydamage', 'Asecondcopy', 'RECEIVED'].every((t) => hiddenOf(d.xml).includes(t)), textOf(shown(d.xml)).slice(0, 200));
  expect('and the stamp keeps its pixels', (await pixelsIn(d, [320, 195, 480, 245])).red > 400, JSON.stringify(await pixelsIn(d, [320, 195, 480, 245])));
  fs.rmSync(docx);
  if (engines.ocr) {
    for (const [name, spec] of [['a stamp turned by 8 degrees', 'tilt:8:11'], ['a stamp turned the other way', 'tilt:-6:13']]) {
      [docx] = await convert.convertFile(draw(`scan-stamp-${spec.replace(/[:-]/g, '')}`, 'scan-stamp', spec), 'docx');
      d = await read(docx);
      expect(`${name}: the lines of the letter are text, the words of the stamp are hidden text`,
        !missingFrom(textOf(shown(d.xml)), LETTER).length && !/RECEIVED/.test(textOf(shown(d.xml))) && hiddenOf(d.xml).includes('RECEIVED'), textOf(shown(d.xml)).slice(0, 200));
      expect(`${name}: it keeps its pixels, not cut by a line of text`, (await pixelsIn(d, [200, 380, 460, 450])).red > 500, JSON.stringify(await pixelsIn(d, [200, 380, 460, 450])));
      fs.rmSync(docx);
    }
  }

  console.log('writing by hand in a coloured pen on a scan');
  for (const [name, spec] of [['blue pen at 11 pt', 'blue:11'], ['green pen at 14 pt', 'green:14']]) {
    [docx] = await convert.convertFile(draw(`scan-pen-${spec.replace(':', '')}`, 'scan-pen', spec), 'docx');
    d = await read(docx);
    expect(`${name}: the printed lines are text, the lines in pen are not typed`,
      /The goods listed below/.test(textOf(shown(d.xml))) && /Questions about this delivery/.test(textOf(shown(d.xml))) && !/signed for|crates were damaged/.test(textOf(shown(d.xml))), textOf(shown(d.xml)).slice(0, 200));
    expect(`${name}: the pen keeps its pixels and its words are hidden text`, (await pixelsIn(d, [55, 195, 480, 240])).coloured > 300
      && ['signedforbythenightsupervisor', 'Twocrateswere'].every((t) => hiddenOf(d.xml).includes(t)), `${JSON.stringify(await pixelsIn(d, [55, 195, 480, 240]))} ${hiddenOf(d.xml).slice(0, 80)}`);
    fs.rmSync(docx);
  }

  console.log('a photographed page');
  for (const [name, spec] of [['unevenly lit', '0.6:0'], ['with curved lines', '1:1.2']]) {
    [docx] = await convert.convertFile(draw(`scan-photo-${spec.replace(/[:.]/g, '')}`, 'scan-photo', spec), 'docx');
    d = await read(docx);
    expect(`${name}: the photo is kept whole, no line of it is written over it`,
      !/Water supply|first line of the note|Contact the office/.test(textOf(shown(d.xml))) && (await pixelsIn(d, [55, 175, 330, 200])).low < 90, JSON.stringify(await pixelsIn(d, [55, 175, 330, 200])));
    expect(`${name}: all of its text layer is there as hidden text`, ['Watersupplyreview', 'Thefirstlineofthenote', 'Asecondlinefollows', 'Contacttheoffice'].every((t) => hiddenOf(d.xml).includes(t)), hiddenOf(d.xml).slice(0, 120));
    fs.rmSync(docx);
  }
  [docx] = await convert.convertFile(draw('scan-photo-flat', 'scan-photo', '0.97:0'), 'docx');
  d = await read(docx);
  expect('a flat scan whose light and lines are even stays text over its picture, the lines painted out of it', /The first line of the note/.test(textOf(shown(d.xml))) && (await pixelsIn(d, [55, 175, 330, 200])).low > 150, JSON.stringify(await pixelsIn(d, [55, 175, 330, 200])));
  fs.rmSync(docx);

  console.log('a slanted scan whose layer sets every word at its own height');
  for (const [name, spec] of [['slanted by 1.1 degrees, the last words 9 points high', '1.1:11:-9'], ['slanted by 0.6 degrees at 12 pt, the last words 8 points low', '0.6:12:8']]) {
    [docx] = await convert.convertFile(draw(`scan-mixed-${spec.replace(/[:.-]/g, '')}`, 'scan-mixed', spec), 'docx');
    d = await read(docx);
    const rows = ['Thank', 'closing', 'Interest'].map((w) => paraWith(d.xml, w));
    const sizes = new Set(rows.flatMap((p) => [...p.matchAll(/<w:sz w:val="(\d+)"/g)].map((m) => m[1])));
    expect(`${name}: the last words of a line are in its paragraph, not on a row of their own`, ['closed the account', 'bank in full', 'will follow soon'].every((t, i) => squash(textOf(rows[i])).includes(squash(t))), rows.map((p) => textOf(p).length).join(' '));
    expect(`${name}: and its words are all in one size`, sizes.size <= 1, [...sizes].join(' '));
    fs.rmSync(docx);
  }

  console.log('a picture drawn turned over');
  for (const [name, side, stored] of [['on an upright sheet', '300', ''], ['smaller, on a sheet stored turned by 180 degrees', '180', 'stored']]) {
    [docx] = await convert.convertFile(draw(`flipped-${side}${stored}`, 'flipped', side, stored), 'docx');
    d = await read(docx);
    const media = Object.keys(d.zip.files).find((n) => n.startsWith('word/media/'));
    const { data, info } = await require('sharp')(await d.zip.file(media).async('nodebuffer')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const at = (fy) => { const i = (Math.floor(info.height * fy) * info.width + Math.floor(info.width / 2)) * 3; return [data[i], data[i + 2]]; };
    expect(`${name}: the picture is cut as the page shows it, blue above red`, at(0.25)[1] > at(0.25)[0] + 100 && at(0.75)[0] > at(0.75)[1] + 100, JSON.stringify([at(0.25), at(0.75)]));
    fs.rmSync(docx);
  }

  console.log('an indented block of code with a long line');
  for (const [name, size, step] of [['10 pt with 2 blanks of indent', '10', '2'], ['9 pt with 4 blanks of indent', '9', '4']]) {
    [docx] = await convert.convertFile(draw(`code-${size}-${step}`, 'code', size, step), 'docx');
    d = await read(docx);
    const block = paraWith(d.xml, 'file_path');
    expect(`${name}: every line of the block ends where it did, so none loses its indent to the wrap`, (block.match(/<w:br\/>/g) || []).length === 7 && block.includes('"id"'), `${(block.match(/<w:br\/>/g) || []).length} breaks`);
    fs.rmSync(docx);
  }

  console.log('a line just under a table');
  for (const [name, size, left] of [['8 pt', '8', '60'], ['10 pt, further right', '10', '120']]) {
    [docx] = await convert.convertFile(draw(`undertable-${size}`, 'undertable', size, left), 'docx');
    d = await read(docx);
    expect(`${name}: the line of notes is a paragraph after the table, not text in a cell of its last row`, /<w:tbl>/.test(d.xml) && d.xml.indexOf('Notes: the figures') > d.xml.lastIndexOf('</w:tbl>'), (d.xml.match(/<w:tblGrid>.*?<\/w:tblGrid>/s) || [''])[0]);
    fs.rmSync(docx);
  }

  console.log('boxes in a row under connectors');
  for (const [name, w, gap] of [['190 pt boxes 20 apart', '190', '20'], ['130 pt boxes 40 apart', '130', '40']]) {
    [docx] = await convert.convertFile(draw(`orgrow-${w}`, 'orgrow', w, gap), 'docx');
    d = await read(docx);
    expect(`${name}: the three boxes are the cells of one row, not one under another`, /<w:tblGrid>(?:<w:gridCol [^>]*\/>){3}<\/w:tblGrid><w:tr>.*?Operations.*?Engineering.*?Commercial/s.test(d.xml), (d.xml.match(/<w:tblGrid>.*?<\/w:tblGrid>/gs) || []).join(' '));
    fs.rmSync(docx);
  }

  console.log('the number of a caption');
  for (const [name, numbers, word, label] of [['figures 1, 2, 3', '1,2,3', 'Figure', 'Figure'], ['tables 1, 2 with the short word', '1,2', 'Table', 'Table'], ['figures 1 and 2 in the short form', '1,2', 'Fig.', 'Figure']]) {
    [docx] = await convert.convertFile(draw(`captions-${word.replace('.', '')}-${numbers.replace(/,/g, '')}`, 'numbered', numbers, word), 'docx');
    d = await read(docx);
    const fields = [...d.xml.matchAll(/ SEQ (\w+) \\\* ARABIC\s*</g)].map((m) => m[1]);
    expect(`${name}: each number is a SEQ field, so a caption added later renumbers`, fields.length === numbers.split(',').length && fields.every((f) => f === label)
      && d.text.includes(`${word} 1. Water use in year 1`), `${fields.join(' ')} | ${d.text.slice(0, 120)}`);
    fs.rmSync(docx);
  }
  [docx] = await convert.convertFile(draw('captions-gap', 'numbered', '1,3', 'Figure'), 'docx');
  d = await read(docx);
  expect('numbers that do not run 1, 2, 3 stay text, because a field would renumber them', !/ SEQ /.test(d.xml) && /Figure 3\. Water use in year 2/.test(d.text), d.text.slice(0, 120));
  fs.rmSync(docx);

  console.log('ruled lines one under another');
  for (const [name, mode, pitch] of [['strokes 20 pt apart', 'stroke', '20'], ['thin rectangles 26 pt apart', 'rect', '26']]) {
    [docx] = await convert.convertFile(draw(`noterules-${mode}`, 'noterules', mode, pitch), 'docx');
    d = await read(docx);
    const rules = d.xml.match(/<w:p><w:pPr><w:pBdr>.*?<\/w:p>/gs) || [];
    const inds = rules.map((p) => (p.match(/<w:ind [^>]*>/) || [''])[0]);
    expect(`${name}: no two ruled lines in a row are alike, because Word draws such paragraphs as one block with one rule`, rules.length >= 6 && inds.every((v, i) => !i || v !== inds[i - 1]), inds.join(' '));
    fs.rmSync(docx);
  }

  console.log('a note that runs on past the last column of a ruled sheet');
  for (const [name, rows, cols] of [['five rows, three columns', '5', '3'], ['eight rows, four columns', '8', '4']]) {
    [docx] = await convert.convertFile(draw(`overflow-${rows}`, 'overflow', rows, cols), 'docx');
    d = await read(docx);
    expect(`${name}: the notes beyond the grid are each placed on the sheet at their row, not paragraphs after the table`, isFramed(d, 'Note that goes on') && (d.xml.match(/<w:framePr /g) || []).length === Number(rows) - 1 && /<w:tbl>/.test(d.xml) && d.xml.indexOf('closing paragraph') > d.xml.lastIndexOf('</w:tbl>'), (d.xml.match(/<w:framePr /g) || []).length + ' frames');
    fs.rmSync(docx);
  }

  console.log('a centred title that sets the margins of its sheet');
  for (const [name, size, width] of [['26 pt on a small sheet', '26', '396'], ['18 pt on A4', '18', '595']]) {
    const pdf = draw(`title-${size}`, 'title', size, width);
    [docx] = await convert.convertFile(pdf, 'docx');
    d = await read(docx);
    const widest = Number(execFileSync(engines.pdf, ['-W', 'ignore', '-c', 'import sys, pymupdf; p = pymupdf.open(sys.argv[1])[0]; print(max(l["bbox"][2] - l["bbox"][0] for b in p.get_text("dict")["blocks"] for l in b["lines"]))', pdf], { encoding: 'utf8', windowsHide: true }));
    const mar = (k) => Number(d.xml.match(new RegExp(`<w:pgMar [^>]*w:${k}="(\\d+)"`))[1]);
    const ind = (k) => Number((paraWith(d.xml, 'HARBOURMASTER').match(new RegExp(`<w:ind [^>]*w:${k}="(-?\\d+)"`)) || [0, 0])[1]);
    const room = (Number(d.xml.match(/<w:pgSz w:w="(\d+)"/)[1]) - mar('left') - mar('right') - ind('left') - ind('right')) / 20;
    expect(`${name}: the paragraph is wider than its widest line, so a wider font does not break a word`, room >= widest + 4, `${room} against ${widest}`);
    fs.rmSync(docx);
  }

  console.log('the text of a stamp annotation');
  for (const [name, size] of [['a stamp', '14'], ['a larger stamp', '20']]) {
    [docx] = await convert.convertFile(draw(`annots-stamp${size}`, 'annots', size, 'stamp'), 'docx');
    d = await read(docx);
    expect(`${name}: its word is hidden text, because the picture of the page already shows it, and the page's own text is text`,
      hiddenOf(d.xml).includes('DRAFT') && !/DRAFT/.test(textOf(shown(d.xml))) && /Body line 4 of the page text/.test(textOf(shown(d.xml))), `${hiddenOf(d.xml)} | ${textOf(shown(d.xml)).slice(0, 80)}`);
    fs.rmSync(docx);
  }
  for (const [name, kind] of [['a note drawn as free text', 'free'], ['a highlight', 'lit']]) {
    [docx] = await convert.convertFile(draw(`annots-${kind}`, 'annots', '12', kind), 'docx');
    d = await read(docx);
    expect(`${name} is not a stamp: the page text and the note stay text`, /Body line 1 of the page text/.test(textOf(shown(d.xml))) && !hiddenRuns(d.xml).length
      && (kind !== 'free' || /Reviewer note here/.test(textOf(shown(d.xml)))), hiddenOf(d.xml));
    fs.rmSync(docx);
  }

  console.log('light text has something darker under it in every PDF drawn above');
  const bare = [], lost = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.pdf') && fs.statSync(path.join(dir, n)).size < 150000)) {
    const r = spawnSync(engines.pdf, ['-W', 'ignore', path.join(__dirname, '..', '..', '..', 'python', 'pdf_to_docx.py'), path.join(dir, f), path.join(dir, 'ground.docx')],
      { encoding: 'utf8', env: { ...process.env, POMELO_DEBUG: '1' }, windowsHide: true });
    bare.push(...(String(r.stderr).match(/light text with no ground under it: .*/g) || []).map((m) => `${f}: ${m}`));
    lost.push(...(String(r.stderr).match(/\d+ lines never written: .*/g) || []).map((m) => `${f}: ${m}`));
  }
  expect('no light run is written on bare paper', !bare.length, bare.join(' | '));
  expect('every line that was read is written', !lost.length, lost.join(' | '));

  console.log(failed() ? `\n${failed()} failed` : '\nall good');
  finish();
})().catch((e) => { console.error(e); finish(1); });

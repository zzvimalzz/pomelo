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
  expect('the title, the headings, the list item and the caption have their styles', /<w:pStyle w:val="Title"\/>(?:(?!<\/w:p>).)*Annual Statement/s.test(d.xml) && /<w:pStyle w:val="Heading2"\/>(?:(?!<\/w:p>).)*Section 2/s.test(d.xml) && /<w:pStyle w:val="ListParagraph"\/>(?:(?!<\/w:p>).)*A list item/s.test(d.xml) && /<w:pStyle w:val="Caption"\/>(?:(?!<\/w:p>).)*Figure 1/s.test(d.xml));
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
    const placed = (word) => /<w:framePr /.test((new RegExp(`<w:p>(?:(?!</w:p>).)*${word}`, 's').exec(d.xml) || [''])[0].match(/<w:p>(?:(?!<w:p>).)*$/s)?.[0] || '');
    expect(`${name}: a title and a number in the last 30 pt of the sheet are placed on it, not set after the text, where Word's own foot margin would push them to a new sheet`,
      placed('Annual report') && placed('Page 7') && !missingFrom(d.text, ['Annual report', 'Page 7']).length, 'not placed');
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
    expect('the text of the scan is recognised and is real, editable text', found.length >= 3, `${found.length} of 4: ${d.text.slice(0, 120)}`);
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
    expect('the lines that are text are painted out of the picture, and the large heading stays in it', mean(55, 185, 330, 262) > 250 && mean(55, 70, 300, 105) < 245,
      `text ${mean(55, 185, 330, 262).toFixed(0)}, heading ${mean(55, 70, 300, 105).toFixed(0)}`);
    fs.rmSync(docx);
  }

  console.log('light text has something darker under it in every PDF drawn above');
  const bare = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.pdf') && fs.statSync(path.join(dir, n)).size < 150000)) {
    const r = spawnSync(engines.pdf, ['-W', 'ignore', path.join(__dirname, '..', '..', '..', 'python', 'pdf_to_docx.py'), path.join(dir, f), path.join(dir, 'ground.docx')],
      { encoding: 'utf8', env: { ...process.env, POMELO_DEBUG: '1' }, windowsHide: true });
    bare.push(...(String(r.stderr).match(/light text with no ground under it: .*/g) || []).map((m) => `${f}: ${m}`));
  }
  expect('no light run is written on bare paper', !bare.length, bare.join(' | '));

  console.log(failed() ? `\n${failed()} failed` : '\nall good');
  finish();
})().catch((e) => { console.error(e); finish(1); });

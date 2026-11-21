# SPDX-License-Identifier: AGPL-3.0-or-later
"""Scanned pages -> real text. A page that is only a picture (a scan, a photographed page) is read with RapidOCR (Apache-2.0,
ONNX models that are installed with the PDF engine, nothing goes online) and written to a copy of the PDF as text at the
places it was found, so every PDF conversion (Word, Markdown, HTML, text, EPUB, Excel, PowerPoint) can use it.

    path, made = prepare(src, progress)   # made: the path is a temporary copy that the caller deletes

Pages that already have text are copied unchanged. Raises OcrUnavailable when a scan needs the OCR component and it is not installed.
"""
import math
import os
import re
import tempfile

import pymupdf

DPI = 150
MIN_CHARS = 25
SCAN_COVER = 0.35
BOX_NOISE = 1.5               # degrees; the angle of an OCR box on a short line, measured on lines of a level scan
FAINT = 40                   # print is at least 60 grey levels darker than its paper; the show-through of the other side of a sheet is under 25
COPY_ID = "19869de063b97343198a3ff4d0a6116d352c5c375efc0fa08874bb6de8cb2169"
JOINED = re.compile(r"(?<=[a-z][.,;!?])(?=[A-Z][a-z])|(?<=[a-z]:)(?=[A-Z])")      # the recogniser often drops the space after a full stop or a colon


class OcrUnavailable(Exception):
    pass


def page_needs_ocr(page):
    """No text worth the name, and a picture over most of the page."""
    if len(re.sub(r"\s", "", page.get_text("text"))) >= MIN_CHARS:
        return False
    r = page.rect
    cover = 0.0
    for info in page.get_image_info():
        b = pymupdf.Rect(info["bbox"]) & r
        if not b.is_empty:
            cover += b.width * b.height
    return cover >= SCAN_COVER * r.width * r.height


_engine = None


def engine():
    global _engine
    if _engine is None:
        try:
            from rapidocr import RapidOCR
        except Exception:
            raise OcrUnavailable("This PDF is a scan and needs the OCR component. Install it in Pomelo: Settings, Advanced, Conversion engines, OCR")
        _engine = RapidOCR(params={"Global.log_level": "error"})              # the models the package ships: as good on English as its English model, in half the time
    return _engine


def text_font():
    path = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts", "arial.ttf")
    return path if os.path.exists(path) else None


def lean(angles, noise=0.0):
    """-> (the slant the lines of a scan share, in degrees, and whether the page is a photograph). A flat scan is slanted by a degree or so, all its lines alike; a page
    slanted by 2 degrees or more, or a quarter of whose lines are more than a degree off the rest (a curled page, a phone's perspective), is a photograph. `noise` is how
    far the angles may be off by themselves: the boxes of an OCR engine are off by up to 1.5 degrees on short lines."""
    a = sorted(angles)
    if not a:
        return 0.0, False
    mid = a[len(a) // 2]
    off = sum(abs(x - mid) > 1.0 + noise for x in a)                              # a stamp or a title may be set at a slant, but not a quarter of the lines
    return (mid if abs(mid) < 2 else 0.0), abs(mid) >= 2 or off >= max(3, len(a) / 4)


def contrast(gray, box):
    """How far the ink in a box of pixels lies from the paper round it, in grey levels: dark ink on light paper, or light letters on a dark ground."""
    x0, y0, x1, y1 = (int(v) for v in box)
    x0, y0, x1, y1 = max(0, x0), max(0, y0), min(gray.width, x1), min(gray.height, y1)
    step = max(2, int(math.sqrt(max(0, x1 - x0) * max(0, y1 - y0) / 10000)))
    grey = gray.samples                                     # a property that copies the whole picture each time it is read
    seen = sorted(grey[y * gray.width + x] for y in range(y0, y1, step) for x in range(x0, x1, step))
    return max(seen[int(len(seen) * 0.8)] - seen[int(len(seen) * 0.03)], seen[int(len(seen) * 0.97)] - seen[int(len(seen) * 0.2)]) if seen else 0


def read_page(page):
    """[(text, x0, y0, x1, y1, shown)] in points, for the text found on a scanned page. A line that is not shown is slanted against the others (a stamp), or the page
    is a photograph: its words are kept, but are not to be printed over the picture."""
    pix = page.get_pixmap(dpi=DPI, alpha=False)
    result = engine()(pix.tobytes("png"))
    if result is None or result.txts is None or result.boxes is None:
        return []
    gray = pymupdf.Pixmap(pymupdf.csGRAY, pix)
    k = 72.0 / DPI
    found = []
    for txt, box, score in zip(result.txts, result.boxes, result.scores):
        txt = JOINED.sub(" ", (txt or "").strip())
        if not txt or (score is not None and float(score) < 0.45):
            continue
        xs = [float(p[0]) for p in box]
        ys = [float(p[1]) for p in box]
        if contrast(gray, (min(xs), min(ys), max(xs), max(ys))) < FAINT:
            continue
        along, across = math.dist(box[0], box[1]), math.dist(box[1], box[2])
        angle = math.degrees(math.atan2(box[1][1] - box[0][1], box[1][0] - box[0][0])) if along >= 4 * across else None
        found.append((txt, min(xs) * k, min(ys) * k, max(xs) * k, max(ys) * k, angle))
    tilt, photo = lean([f[5] for f in found if f[5] is not None], BOX_NOISE)
    return [f[:5] + (not photo and (f[5] is None or abs(f[5] - tilt) <= 1.5 + BOX_NOISE),) for f in found]


def write_page(out, page, lines, font_file, font):
    new = out.new_page(width=page.rect.width, height=page.rect.height)
    if font_file:
        new.insert_font(fontname="Arial", fontfile=font_file)
    for txt, x0, y0, x1, y1, shown in lines:
        h = max(2.0, y1 - y0)
        size_h = h * 0.88
        size = size_h
        if font is not None:
            w1 = font.text_length(txt, fontsize=1)
            if w1 > 0:
                size = min(max((x1 - x0) / w1, 0.6 * size_h), 1.25 * size_h)
        size = max(4.0, size)
        mode = 0 if shown else 3
        try:
            new.insert_text((x0, y1 - 0.2 * size), txt, fontsize=size, fontname="Arial" if font_file else "helv", color=(0, 0, 0), render_mode=mode)
        except Exception:
            new.insert_text((x0, y1 - 0.2 * size), txt.encode("latin-1", "replace").decode("latin-1"), fontsize=size, fontname="helv", color=(0, 0, 0), render_mode=mode)


def prepare(src, progress=lambda f: None):
    doc = pymupdf.open(src)
    if doc.needs_pass:
        raise RuntimeError("This PDF is password-protected. Remove the password and try again")
    scans = [i for i in range(len(doc)) if page_needs_ocr(doc[i])]
    if not scans:
        return src, False
    engine()                                                  # fail early, before any page is read
    font_file = text_font()
    font = pymupdf.Font(fontfile=font_file) if font_file else None
    out = pymupdf.open()
    for i in range(len(doc)):
        progress(i / len(doc))
        if i in scans:
            write_page(out, doc[i], read_page(doc[i]), font_file, font)
        else:
            out.insert_pdf(doc, from_page=i, to_page=i)
    fd, path = tempfile.mkstemp(prefix="pomelo-ocr-" + COPY_ID[:8] + "-", suffix=".pdf")
    os.close(fd)
    out.save(path, garbage=3, deflate=True)
    return path, True

# SPDX-License-Identifier: AGPL-3.0-or-later
"""Scanned pages -> real text. A page that is only a picture (a scan, a photographed page) is read with RapidOCR (Apache-2.0,
ONNX models that are installed with the PDF engine, nothing goes online) and written to a copy of the PDF as text at the
places it was found, so every PDF conversion (Word, Markdown, HTML, text, EPUB, Excel, PowerPoint) can use it.

    path, made = prepare(src, progress)   # made: the path is a temporary copy that the caller deletes

Pages that already have text are copied unchanged. Raises OcrUnavailable when a scan needs the OCR component and it is not installed.
"""
import os
import re
import tempfile

import pymupdf

DPI = 150
MIN_CHARS = 25
SCAN_COVER = 0.35
COPY_ID = "19869de063b97343198a3ff4d0a6116d352c5c375efc0fa08874bb6de8cb2169"


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
            from rapidocr import RapidOCR, LangRec, ModelType, OCRVersion
        except Exception:
            raise OcrUnavailable("This PDF is a scan and needs the OCR component. Install it in Pomelo: Settings, Advanced, Conversion engines, OCR")
        _engine = RapidOCR(params={"Rec.lang_type": LangRec.EN, "Rec.ocr_version": OCRVersion.PPOCRV4, "Rec.model_type": ModelType.MOBILE, "Global.log_level": "error"})
    return _engine


def text_font():
    path = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts", "arial.ttf")
    return path if os.path.exists(path) else None


def read_page(page):
    """[(text, x0, y0, x1, y1)] in points, for the text found on a scanned page."""
    pix = page.get_pixmap(dpi=DPI, alpha=False)
    result = engine()(pix.tobytes("png"))
    if result is None or result.txts is None or result.boxes is None:
        return []
    k = 72.0 / DPI
    out = []
    for txt, box, score in zip(result.txts, result.boxes, result.scores):
        txt = (txt or "").strip()
        if not txt or (score is not None and float(score) < 0.45):
            continue
        xs = [float(p[0]) * k for p in box]
        ys = [float(p[1]) * k for p in box]
        out.append((txt, min(xs), min(ys), max(xs), max(ys)))
    return out


def write_page(out, page, lines, font_file, font):
    new = out.new_page(width=page.rect.width, height=page.rect.height)
    if font_file:
        new.insert_font(fontname="Arial", fontfile=font_file)
    for txt, x0, y0, x1, y1 in lines:
        h = max(2.0, y1 - y0)
        size_h = h * 0.88
        size = size_h
        if font is not None:
            w1 = font.text_length(txt, fontsize=1)
            if w1 > 0:
                size = min(max((x1 - x0) / w1, 0.6 * size_h), 1.25 * size_h)
        size = max(4.0, size)
        try:
            new.insert_text((x0, y1 - 0.2 * size), txt, fontsize=size, fontname="Arial" if font_file else "helv", color=(0, 0, 0))
        except Exception:
            new.insert_text((x0, y1 - 0.2 * size), txt.encode("latin-1", "replace").decode("latin-1"), fontsize=size, fontname="helv", color=(0, 0, 0))


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

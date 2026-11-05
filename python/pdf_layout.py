# SPDX-License-Identifier: AGPL-3.0-or-later
"""Exact-position page reading for the PowerPoint export (slides that look like the pages).

Each page is read as: a background picture (the page as it looks with its text taken out: pictures, shapes, gradients, rules,
backgrounds; none for a page of text alone) and the text as lines with their position, font, size, colour, bold, italic and link.
Text that cannot be reproduced faithfully (right-to-left, rotated, symbol fonts) is left in the picture instead of being re-typed wrongly.
"""
import os
import re

import pymupdf

from pdf_fonts import word_family
from pdf_spans import BAD_XML, TEXT_FLAGS, has_unmapped_symbols, hexcolor

PUA_OK = {chr(c) for c in (0xF0B7, 0xF0A7, 0xF0D8, 0xF076, 0xF0FC, 0xF06E, 0xF0A8, 0xF06F)}   # the bullets Word itself writes in Symbol/Wingdings
RTL = re.compile(r"[֐-ࣿיִ-﷿ﹰ-﻿]")
BG_DPI = 200


def span_ok(line, span):
    dx, dy = line["dir"]
    if abs(dy) > 0.02 or dx < 0.98:
        return False                      # rotated
    t = span["text"]
    if not t.strip() or span["size"] < 3:
        return False
    if RTL.search(t):
        return False                      # right-to-left stays in the picture, exactly as drawn
    if has_unmapped_symbols(t, PUA_OK):
        return False                      # symbol-font glyphs with no Unicode meaning
    return True


def collect(page):
    """Lines of spans, each line cut into segments wherever the gap or the baseline changes."""
    segments = []
    d = page.get_text("dict", flags=TEXT_FLAGS)
    for block in d["blocks"]:
        for line in block.get("lines", []):
            spans = [s for s in line["spans"] if span_ok(line, s)]
            if not spans:
                continue
            cur = [spans[0]]
            for s in spans[1:]:
                prev = cur[-1]
                gap = s["origin"][0] - prev["bbox"][2]
                same_base = abs(s["origin"][1] - prev["origin"][1]) <= max(0.35, prev["size"] * 0.04)
                spaced = prev["text"].endswith(" ") or s["text"].startswith(" ")
                # joined only when they touch, or a real space character sits between them; any other gap (letter-spaced
                # headings, tab-aligned columns, a label and its value) keeps the second piece at its own exact position
                if same_base and (gap <= prev["size"] * 0.12 or (spaced and gap < max(prev["size"] * 1.2, 9))):
                    cur.append(s)
                else:
                    segments.append(cur)
                    cur = [s]
            segments.append(cur)
    return segments


def links_of(page):
    out = []
    for lk in page.get_links():
        if lk.get("uri"):
            out.append((pymupdf.Rect(lk["from"]), lk["uri"]))
    return out


def background(work_page, dpi=BG_DPI):
    pix = work_page.get_pixmap(dpi=dpi, alpha=False)
    if pix.is_unicolor and pix.samples[:3] == b"\xff\xff\xff":
        return None
    png = pix.tobytes("png")
    jpg = pix.tobytes("jpeg", jpg_quality=88)
    return (png, "png") if len(png) <= len(jpg) * 1.3 else (jpg, "jpg")


def export_layout(src, outdir, progress=lambda f: None):
    """The same reading of each page as convert() makes, but handed back as data for another writer (PowerPoint):
    {"pages": [{"w", "h" (points), "background": file or None, "texts": [{"x", "y" (baseline), "size", "runs": [...]}]}]}.
    The background pictures are written into `outdir`."""
    doc = pymupdf.open(src)
    work = pymupdf.open(src)
    os.makedirs(outdir, exist_ok=True)
    pages = []
    for pno in range(len(doc)):
        progress(0.95 * pno / len(doc))
        page, wpage = doc[pno], work[pno]
        segments = collect(page)
        kept = [s for seg in segments for s in seg]
        for s in kept:
            r = pymupdf.Rect(s["bbox"])
            inset = r.height * 0.2
            wpage.add_redact_annot(pymupdf.Rect(r.x0, r.y0 + inset, r.x1, r.y1 - inset), fill=False)
        if kept:
            wpage.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE, graphics=pymupdf.PDF_REDACT_LINE_ART_NONE, text=pymupdf.PDF_REDACT_TEXT_REMOVE)
        links = links_of(page)
        texts = []
        for seg in segments:
            runs = []
            for s in seg:
                link = next((uri for rect, uri in links if (rect & pymupdf.Rect(s["bbox"])).get_area() >= 0.5 * pymupdf.Rect(s["bbox"]).get_area()), None)
                name = s["font"].lower()
                runs.append({"text": BAD_XML.sub("", s["text"]), "font": word_family(s["font"]) or "Arial", "size": s["size"],
                             "bold": bool(s["flags"] & 16) or "bold" in name or "black" in name, "italic": bool(s["flags"] & 2) or "italic" in name or "oblique" in name,
                             "color": hexcolor(s["color"]), "link": link})
            first, last = seg[0], seg[-1]
            texts.append({"x": first["origin"][0], "baseline": first["origin"][1], "width": last["bbox"][2] - first["origin"][0],
                          "size": max(s["size"] for s in seg), "ascender": first.get("ascender", 0.9) or 0.9, "runs": runs})
        native = max((i["width"] / max(i["bbox"][2] - i["bbox"][0], 1) * 72 for i in page.get_image_info() if i["width"] > 16), default=0)
        bg = background(wpage, int(min(300, max(BG_DPI, native))))
        bg_file = None
        if bg:
            bg_file = f"page{pno + 1}.{bg[1]}"
            with open(os.path.join(outdir, bg_file), "wb") as f:
                f.write(bg[0])
        pages.append({"w": page.rect.width, "h": page.rect.height, "background": bg_file, "texts": texts})
    return {"pages": pages, "title": (doc.metadata or {}).get("title") or ""}



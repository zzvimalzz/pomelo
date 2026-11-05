# SPDX-License-Identifier: AGPL-3.0-or-later
"""Measuring text in the fonts Word will use, so a line breaks where it did in the PDF."""

import re

import pymupdf


# ---- fonts ---------------------------------------------------------------------------------------------------------------
class FontMeter:
    """Natural width of a string in the PDF's own font: to carry the PDF's letter-spacing over."""

    def __init__(self, doc):
        self.doc = doc
        self.cache = {}
        self.xref = {}

    def register(self, page):
        try:
            for xref, ext, kind, name, *_ in page.get_fonts(full=False):
                self.xref.setdefault(re.sub(r"^[A-Z]{6}\+", "", name), xref)
        except Exception:
            pass

    def font(self, name):
        key = re.sub(r"^[A-Z]{6}\+", "", name)
        if key not in self.cache:
            f = None
            xref = self.xref.get(key)
            if xref:
                try:
                    buf = self.doc.extract_font(xref)[3]
                    if buf and len(buf) < 4_000_000:
                        f = pymupdf.Font(fontbuffer=buf)
                except Exception:
                    f = None
            self.cache[key] = f
        return self.cache[key]

    def width(self, name, text, size):
        f = self.font(name)
        if f is None:
            return None
        try:
            w = f.text_length(text, fontsize=size)
        except Exception:
            return None
        return w if w > 0 else None

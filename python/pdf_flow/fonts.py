# SPDX-License-Identifier: AGPL-3.0-or-later
"""Measuring text in the fonts Word will use, so a line breaks where it did in the PDF."""

import re

import pymupdf

from pdf_fonts import installed, installed_font, installed_name, latin, norm, stand_in, word_family

from .lines import is_bold, is_italic


class FontMeter:
    """Which family Word draws a span in, and the natural width of a string in it."""

    def __init__(self, doc):
        self.doc = doc
        self.cache = {}
        self.xref = {}
        self.families = {}

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

    def family(self, s):
        """The family Word draws the span in. Text outside the Latin scripts keeps the font's own name."""
        if not installed() or not latin(s["text"]):
            own = word_family(s["font"]) or "Arial"
            return installed_name(own) or own
        key = re.sub(r"^[A-Z]{6}\+", "", s["font"])
        if key not in self.families:
            self.families[key] = stand_in(s["font"], s["flags"], is_bold(s), is_italic(s), self.font(s["font"]))
        return self.families[key]

    def width(self, s, text, size):
        """Natural width in the font Word will use, or None when it cannot be measured."""
        family = self.family(s)
        theirs = norm(family) == norm(word_family(s["font"]) or "Arial") or not installed()
        f = self.font(s["font"]) if theirs else installed_font(family, is_bold(s), is_italic(s))
        if f is None:
            return None
        try:
            w = f.text_length(text, fontsize=size)
        except Exception:
            return None
        return w if w > 0 else None

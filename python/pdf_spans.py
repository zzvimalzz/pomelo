# SPDX-License-Identifier: AGPL-3.0-or-later
"""Small pieces of reading a PDF's text that the Word, PowerPoint and text/Markdown readers all need, written once.
Only what is really the same lives here; the readers keep their own line pipelines, which are tuned differently."""
import re
from collections import Counter

import pymupdf

BAD_XML = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]")          # characters an XML file cannot hold
TEXT_FLAGS = pymupdf.TEXT_PRESERVE_WHITESPACE | pymupdf.TEXT_PRESERVE_LIGATURES


def hexcolor(c):
    """A PyMuPDF colour integer as RRGGBB."""
    return "%02X%02X%02X" % ((c >> 16) & 255, (c >> 8) & 255, c & 255)


def has_unmapped_symbols(text, allowed):
    """True when the text holds a Private Use Area glyph (a symbol font's picture of a bullet or an arrow) that is not one of
    the `allowed` characters: it has no Unicode meaning, so re-typing it would show the wrong thing."""
    return any(0xE000 <= ord(c) <= 0xF8FF and c not in allowed for c in text)


def dominant_size(items, default=10.0):
    """items: (text, font size) pairs -> the size, in half points, that carries the most characters (the body text)."""
    sizes = Counter()
    for text, size in items:
        if text.strip():
            sizes[round(size * 2) / 2] += len(text)
    return sizes.most_common(1)[0][0] if sizes else default


def dedupe(lines, tolerance):
    """Text drawn twice at the same spot (a drop shadow, a fake bold) is one line. `lines` have .text, .x0 and .y0."""
    out = []
    for l in lines:
        if not any(o.text == l.text and abs(o.x0 - l.x0) < tolerance and abs(o.y0 - l.y0) < tolerance for o in out):
            out.append(l)
    return out

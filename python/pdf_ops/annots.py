# SPDX-License-Identifier: AGPL-3.0-or-later
"""Markup that sits on a page without changing its content: a highlight over text, ink and a free text box.

Points arrive as the page shows them: in points from the top left corner of the page as it is displayed, turned as the page is turned.
PyMuPDF draws in the page's own frame, which is not turned, so every point goes through the page's derotation matrix first. A colour is
three whole numbers from 0 to 255. A page is counted from 1, in the document as the earlier operations of the list left it.
"""
import pymupdf

from .pages import pick

KINDS = ("highlight", "ink", "freetext")


def rgb(color):
    if not isinstance(color, list) or len(color) != 3 or any(type(c) is not int or not 0 <= c <= 255 for c in color):
        raise ValueError("a colour is three numbers from 0 to 255")
    return tuple(c / 255 for c in color)


def points(page, flat):
    if not isinstance(flat, list) or len(flat) < 2 or len(flat) % 2 or any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in flat):
        raise ValueError("points come in pairs of numbers")
    return [pymupdf.Point(flat[i], flat[i + 1]) * page.derotation_matrix for i in range(0, len(flat), 2)]


def bounds(pts):
    return pymupdf.Rect(min(p.x for p in pts), min(p.y for p in pts), max(p.x for p in pts), max(p.y for p in pts))


def fade(annot, opacity):
    if opacity is not None and not 0 <= opacity <= 1:
        raise ValueError("opacity is a number from 0 to 1")
    if opacity is not None and opacity < 1:
        annot.set_opacity(opacity)


def highlight(page, color, opacity, quads):
    if not isinstance(quads, list) or not quads or any(not isinstance(q, list) or len(q) != 8 for q in quads):
        raise ValueError("a highlight needs the quads of the text it covers")
    made = page.add_highlight_annot(quads=[bounds(points(page, q)).quad for q in quads])
    made.set_colors(stroke=rgb(color))
    fade(made, opacity)
    made.update()


def ink(page, color, opacity, thickness, paths):
    if not isinstance(paths, list) or not paths:
        raise ValueError("ink needs at least one stroke")
    if isinstance(thickness, bool) or not isinstance(thickness, (int, float)) or not 0 < thickness <= 100:
        raise ValueError("ink is between 0 and 100 points thick")
    made = page.add_ink_annot([[(p.x, p.y) for p in points(page, stroke)] for stroke in paths])
    made.set_colors(stroke=rgb(color))
    made.set_border(width=thickness)
    fade(made, opacity)
    made.update()


def freetext(page, color, rect, text, size):
    if not isinstance(text, str) or not text.strip() or len(text) > 5000 or "\0" in text:
        raise ValueError("a text box holds 1 to 5000 characters")
    if isinstance(size, bool) or not isinstance(size, (int, float)) or not 4 <= size <= 200:
        raise ValueError("text is between 4 and 200 points high")
    box = bounds(points(page, rect))
    # The text is turned with the page so it reads upright in the displayed page.
    made = page.add_freetext_annot(box, text, fontsize=size, text_color=rgb(color), fill_color=None, border_width=0, rotate=page.rotation)
    if made is None:
        raise ValueError("the text does not fit in its box")


def add(doc, type, page, color, opacity=None, thickness=None, quads=None, paths=None, rect=None, text=None, size=None):
    if type not in KINDS:
        raise ValueError("unknown kind of markup")
    shown = doc[pick(doc, [page])[0]]
    if type == "highlight":
        highlight(shown, color, opacity, quads)
    elif type == "ink":
        ink(shown, color, opacity, thickness, paths)
    else:
        freetext(shown, color, rect, text, size)

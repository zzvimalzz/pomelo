# SPDX-License-Identifier: AGPL-3.0-or-later
"""Editable PDF -> DOCX. Every page is rebuilt as the Word document someone would have typed: real paragraphs with their
indents, alignment and spacing, real lists, real tables (ruled ones, and side-by-side blocks as borderless tables),
shaded boxes, hyperlinks, underline and highlight. Only what is a picture in the PDF stays a picture.

How a page is read (PyMuPDF, run as a separate process, never linked into the app):
  * lines of text come from the text layer; pieces on one row are joined, bullets and numbers are split off as list markers
  * ruled tables come from PyMuPDF's table finder; shaded or outlined boxes that hold text become one-cell tables
  * the rest is cut the way a typesetter would: columns where a vertical gap runs the whole height, bands where a
    horizontal gap separates differently built parts (a title above two columns); what cannot be cut is a stack of
    paragraphs, grouped from the spacing, the left edge and the line lengths
  * everything that is not text and not one of the above (pictures, charts, logos, shapes, gradients) is found by
    drawing the page without its text and looking for what is left: it is cut out as a picture, in line with the text
    or behind it when text sits on top
  * vertical positions are kept by computing the space before each paragraph, so a page comes out where it went in
"""
import io
import math
import os
import re
import sys
from collections import Counter

import pymupdf
from docx import Document
from docx.oxml import parse_xml
from docx.oxml.ns import nsdecls, qn
from docx.opc.constants import RELATIONSHIP_TYPE

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pdf_fonts import word_family  # noqa: E402

TW = 20                                   # twips per point
NS = nsdecls("w", "wp", "a", "pic", "r")
BAD_XML = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]")
RTL = re.compile("[֐-ࣿיִ-﷿ﹰ-﻿]")
BULLETS = set("•●▪◦·‣⁃■○✓✔❖➢–—-*►▸➤□◆◇▫") | {"", "", "", "", "", "", "", "", "o"}
NUMBER = re.compile(r"^(\(?\d{1,3}[.)]|\(?[a-z][.)]|\([ivx]{1,4}\))$")
FLAGS = pymupdf.TEXT_PRESERVE_WHITESPACE | pymupdf.TEXT_PRESERVE_LIGATURES
HI_DPI = 200


def tw(v):
    return int(round(v * TW))


def esc(s):
    return BAD_XML.sub("", s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def hexcolor(c):
    return "%02X%02X%02X" % ((c >> 16) & 255, (c >> 8) & 255, c & 255)


def rgb_hex(rgb):
    return "%02X%02X%02X" % tuple(max(0, min(255, round(v * 255))) for v in rgb[:3])


def is_white(rgb, tol=0.04):
    return rgb is None or all(v >= 1 - tol for v in rgb[:3])


def overlap(a, b):
    """Area of the overlap of two (x0, y0, x1, y1) boxes."""
    return max(0.0, min(a[2], b[2]) - max(a[0], b[0])) * max(0.0, min(a[3], b[3]) - max(a[1], b[1]))


def area(b):
    return max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])


def inside(b, outer, slack=1.0):
    cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
    return outer[0] - slack <= cx <= outer[2] + slack and outer[1] - slack <= cy <= outer[3] + slack


# ---- text lines -------------------------------------------------------------------------------------------------
class Line:
    """A line of text: spans on one baseline."""
    kind = "line"

    def __init__(self, spans, bbox, base, size, rot=False):
        self.spans, self.rot, self.base, self.size = spans, rot, base, size
        self.x0, self.y0, self.x1, self.y1 = bbox
        big = max(spans, key=lambda s: s["size"])
        self.asc = big.get("ascender") or 0.9
        self.desc = big.get("descender") or -0.2
        self.marker = None            # (kind, token, marker_x0, text_x0)
        self.marker_box = None
        self.absorbed = False

    @property
    def text(self):
        return "".join(s["text"] for s in self.spans)

    @property
    def bbox(self):
        return (self.x0, self.y0, self.x1, self.y1)

    @property
    def bold_all(self):
        real = [s for s in self.spans if s["text"].strip()]
        return bool(real) and all(is_bold(s) for s in real)


def is_bold(s):
    n = s["font"].lower()
    return bool(s["flags"] & 16) or "bold" in n or "black" in n or "heavy" in n or "semibold" in n


def is_italic(s):
    n = s["font"].lower()
    return bool(s["flags"] & 2) or "italic" in n or "oblique" in n


def span_ok(s):
    t = s["text"]
    if s["size"] < 2.5:
        return False
    if s.get("alpha", 255) == 0:
        return False
    return not any(0xE000 <= ord(c) <= 0xF8FF and c not in BULLETS for c in t)


TRACKED = re.compile(r"^(?:[^\s]{1,3} ){2,}[^\s]{1,3}$|(?:^|\s)[A-Z] [A-Z]{1,3} ")


def repair_tracked(page, blocks):
    """Letter-spaced capitals (a label with tracking) come out of the text layer with spaces inside the words. The gaps
    between the real characters say where the real spaces are."""
    suspects = [s for b in blocks if b["type"] == 0 for ln in b["lines"] for s in ln["spans"]
                if s["text"].count(" ") >= 2 and s["text"].strip().upper() == s["text"].strip() and TRACKED.search(s["text"].strip())]
    if not suspects:
        return
    raw = page.get_text("rawdict", flags=FLAGS)["blocks"]
    index = {}
    for b in raw:
        if b["type"] == 0:
            for ln in b["lines"]:
                for s in ln["spans"]:
                    index[(round(s["bbox"][0]), round(s["bbox"][1]))] = s
    for s in suspects:
        r = index.get((round(s["bbox"][0]), round(s["bbox"][1])))
        if not r or not r.get("chars"):
            continue
        out = ""
        last = None
        for ch in r["chars"]:
            if ch["c"].isspace():
                continue
            if last is not None and ch["bbox"][0] - last["bbox"][2] > 0.34 * s["size"] and out and not out.endswith(" "):
                out += " "
            out += ch["c"]
            last = ch
        s["text"] = out


def read_lines(page):
    out = []
    blocks = page.get_text("dict", flags=FLAGS)["blocks"]
    try:
        repair_tracked(page, blocks)
    except Exception:
        pass
    for block in blocks:
        if block["type"] != 0:
            continue
        for ln in block["lines"]:
            spans = [s for s in ln["spans"] if s["text"] != ""]
            if not any(s["text"].strip() for s in spans):
                continue
            dx, dy = ln["dir"]
            rot = abs(dy) > 0.02 or dx < 0.98
            real = [s for s in spans if s["text"].strip()]
            if not all(span_ok(s) for s in real):
                # a symbol-font glyph that has no Unicode meaning stays in the picture, whatever else the line holds
                spans = [s for s in spans if span_ok(s)]
                if not any(s["text"].strip() for s in spans):
                    continue
            size = max(s["size"] for s in spans if s["text"].strip())
            out.append(Line([dict(s) for s in spans], ln["bbox"], spans[0]["origin"][1], size, rot))
    return out


def dedupe(lines):
    """Text drawn twice at the same spot (a drop shadow, a fake bold) is one line."""
    out = []
    for l in lines:
        if not any(o.text == l.text and abs(o.x0 - l.x0) < 3 and abs(o.y0 - l.y0) < 3 for o in out):
            out.append(l)
    return out


def merge_rows(lines):
    """Pieces on one row that sit close together are one line; pieces far apart stay apart (columns, a title and its date)."""
    lines = sorted(lines, key=lambda l: (l.base, l.x0))
    rows = []
    for l in lines:
        for r in rows:
            if abs(r[-1].base - l.base) <= 0.3 * min(r[-1].size, l.size):
                r.append(l)
                break
        else:
            rows.append([l])
    out = []
    for r in rows:
        r.sort(key=lambda l: l.x0)
        cur = r[0]
        for nxt in r[1:]:
            gap = nxt.x0 - cur.x1
            if gap < 0.8 * min(cur.size, nxt.size):
                spans = cur.spans
                if gap > 0.12 * cur.size and not cur.text.endswith(" ") and not nxt.text.startswith(" "):
                    spans = spans + [dict(cur.spans[-1], text=" ", bbox=(cur.x1, cur.y0, nxt.x0, cur.y1))]
                merged = Line(spans + nxt.spans, (cur.x0, min(cur.y0, nxt.y0), nxt.x1, max(cur.y1, nxt.y1)), cur.base, max(cur.size, nxt.size))
                cur = merged
            else:
                out.append(cur)
                cur = nxt
        out.append(cur)
    return out


def attach_markers(lines):
    """A bullet or a number the PDF drew as a line of its own joins the text on its row."""
    def marker_only(l):
        t = l.text.strip()
        return 0 < len(t) <= 3 and (t[0] in BULLETS or bool(NUMBER.match(t)))
    out = list(lines)
    for m in [l for l in lines if marker_only(l)]:
        mates = [o for o in out if o is not m and not marker_only(o) and abs(o.base - m.base) <= 0.35 * m.size + 1.0 and 0 < o.x0 - m.x1 <= 4.5 * m.size]
        if not mates:
            continue
        o = min(mates, key=lambda o: o.x0 - m.x1)
        gap = dict(m.spans[-1], text=" ", bbox=(m.x1, m.y0, o.x0, m.y1))
        merged = Line(m.spans + [gap] + o.spans, (m.x0, min(m.y0, o.y0), o.x1, max(m.y1, o.y1)), o.base, max(m.size, o.size))
        out.remove(m)
        out[out.index(o)] = merged
    return out


def split_marker(line, body):
    """A leading bullet or number becomes a list marker of the line (headings never do)."""
    text = line.text
    stripped = text.lstrip()
    if not stripped or line.size >= body * 1.22 or line.bold_all and line.size > body * 1.05:
        return
    first = stripped.split(None, 1)[0]
    rest = stripped[len(first):]
    if not rest.strip():
        return
    kind = None
    if len(first) <= 2 and first[0] in BULLETS and (first not in ("-", "–", "—", "*", "o") or rest[:1].isspace()):
        kind = "bullet"
    elif NUMBER.match(first) and rest[:1].isspace() and len(rest.strip()) > 1:
        kind = "number"
    if not kind:
        return
    # take the token off the front of the spans
    spans, dropped = [], False
    marker_x0 = line.x0
    text_x0 = None
    for s in line.spans:
        if dropped:
            spans.append(s)
            continue
        t = s["text"]
        lead = len(t) - len(t.lstrip())
        if not t.strip():
            continue
        if t.lstrip().startswith(first):
            after = t[lead + len(first):]
            width = s["bbox"][2] - s["bbox"][0]
            n = max(1, len(t))
            keep = after.lstrip()
            dropped = True
            if keep:
                text_x0 = s["bbox"][0] + width * (n - len(keep)) / n
                spans.append(dict(s, text=keep))
            else:
                text_x0 = None
        else:
            return
    while spans and not spans[0]["text"].strip():
        spans.pop(0)
    if not spans:
        return
    if text_x0 is None:
        text_x0 = spans[0]["bbox"][0]
    line.marker_box = (marker_x0, line.y0, max(text_x0, marker_x0 + 1.0), line.y1)
    line.spans = spans
    line.marker = (kind, first, marker_x0, text_x0)
    line.x0 = text_x0


# ---- the other things on a page ---------------------------------------------------------------------------------------
class Img:
    kind = "img"

    def __init__(self, bbox, data, ext, floating=False):
        self.x0, self.y0, self.x1, self.y1 = bbox
        self.data, self.ext, self.floating = data, ext, floating

    @property
    def bbox(self):
        return (self.x0, self.y0, self.x1, self.y1)


class Rule:
    kind = "rule"

    def __init__(self, bbox, width, color):
        self.x0, self.y0, self.x1, self.y1 = bbox
        self.width, self.color = width, color

    @property
    def bbox(self):
        return (self.x0, self.y0, self.x1, self.y1)


class Box:
    """A shaded or outlined box that holds things: a one-cell table."""
    kind = "box"

    def __init__(self, bbox, fill, border, dashed=False):
        self.x0, self.y0, self.x1, self.y1 = bbox
        self.fill, self.border, self.dashed = fill, border, dashed      # border: (width, hex) or None
        self.children = []

    @property
    def bbox(self):
        return (self.x0, self.y0, self.x1, self.y1)


class Tbl:
    kind = "tbl"

    def __init__(self, bbox, xs, ys, cells):
        self.x0, self.y0, self.x1, self.y1 = bbox
        self.xs, self.ys, self.cells = xs, ys, cells     # cells: dicts with c0 c1 r0 r1 bbox fill borders items

    @property
    def bbox(self):
        return (self.x0, self.y0, self.x1, self.y1)


class Fig:
    kind = "img"

    def __init__(self, bbox, data, ext, floating=False):
        self.x0, self.y0, self.x1, self.y1 = bbox
        self.data, self.ext, self.floating = data, ext, floating

    @property
    def bbox(self):
        return (self.x0, self.y0, self.x1, self.y1)


def cluster(values, tol=1.6):
    values = sorted(values)
    out = []
    for v in values:
        if out and v - out[-1][-1] <= tol:
            out[-1].append(v)
        else:
            out.append([v])
    return [sum(c) / len(c) for c in out]


def nearest(xs, v):
    return min(range(len(xs)), key=lambda i: abs(xs[i] - v))


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


# ---- the page --------------------------------------------------------------------------------------------------------
def segments_of(drawings):
    """Horizontal and vertical strokes (lines, thin rectangles, rectangle edges) with their width and colour."""
    segs = []
    for d in drawings:
        color, fill, width = d.get("color"), d.get("fill"), d.get("width") or 1.0
        for it in d["items"]:
            op = it[0]
            if op == "l" and color:
                p, q = it[1], it[2]
                if abs(p.y - q.y) <= 0.8:
                    segs.append(("h", (p.y + q.y) / 2, min(p.x, q.x), max(p.x, q.x), width, rgb_hex(color), d))
                elif abs(p.x - q.x) <= 0.8:
                    segs.append(("v", (p.x + q.x) / 2, min(p.y, q.y), max(p.y, q.y), width, rgb_hex(color), d))
            elif op == "re":
                r = it[1]
                if fill and not is_white(fill) and (r.height <= 2.6 or r.width <= 2.6):
                    if r.width >= r.height:
                        segs.append(("h", (r.y0 + r.y1) / 2, r.x0, r.x1, max(r.height, 0.5), rgb_hex(fill), d))
                    else:
                        segs.append(("v", (r.x0 + r.x1) / 2, r.y0, r.y1, max(r.width, 0.5), rgb_hex(fill), d))
                elif color and not (fill and not is_white(fill) and False):
                    for o, pos, a, b in (("h", r.y0, r.x0, r.x1), ("h", r.y1, r.x0, r.x1), ("v", r.x0, r.y0, r.y1), ("v", r.x1, r.y0, r.y1)):
                        segs.append((o, pos, a, b, width, rgb_hex(color), d))
    return segs


def polygon_area(items):
    pts = []
    for it in items:
        if it[0] == "l":
            pts += [(it[1].x, it[1].y)]
        elif it[0] == "c":
            pts += [(it[1].x, it[1].y)]
        elif it[0] == "re":
            r = it[1]
            pts += [(r.x0, r.y0), (r.x1, r.y0), (r.x1, r.y1), (r.x0, r.y1)]
        elif it[0] == "qu":
            q = it[1]
            pts += [(q.ul.x, q.ul.y), (q.ur.x, q.ur.y), (q.lr.x, q.lr.y), (q.ll.x, q.ll.y)]
    if len(pts) < 3:
        return 0.0
    a = 0.0
    for (x1, y1), (x2, y2) in zip(pts, pts[1:] + pts[:1]):
        a += x1 * y2 - x2 * y1
    return abs(a) / 2


def rect_shapes(drawings):
    """Filled or outlined rectangle-like shapes: (rect, fill hex or None, border (width, hex) or None, dashed)."""
    shapes = []
    for d in drawings:
        items = d["items"]
        if not items or len(items) > 80:
            continue
        ops = {it[0] for it in items}
        if not ops <= {"re", "l", "c", "qu"}:
            continue
        if "l" in ops and any(it[0] == "l" and abs(it[1].x - it[2].x) > 0.8 and abs(it[1].y - it[2].y) > 0.8 for it in items):
            continue
        r = d["rect"]
        if r.width < 14 or r.height < 8:
            continue
        if "c" in ops and polygon_area(items) < 0.86 * r.width * r.height:
            continue                                                  # a circle or a blob, not a (rounded) rectangle
        fill = d.get("fill")
        color = d.get("color")
        fill = None if (fill is None or is_white(fill, 0.012)) else rgb_hex(fill)
        if (d.get("fill_opacity") if d.get("fill_opacity") is not None else 1) < 0.85:
            fill = None
        border = (d.get("width") or 1.0, rgb_hex(color)) if color else None
        if not fill and not border:
            continue
        if len(items) <= 2 and "l" in ops and not fill:
            continue                                              # an open line, not a box
        shapes.append((r, fill, border, bool(d.get("dashes")) and "[]" not in str(d.get("dashes"))))
    return shapes


class Page:
    def __init__(self, doc, work_all, work_keep, page, pno, meter, body):
        self.doc, self.page, self.pno, self.meter, self.body = doc, page, pno, meter, body
        self.w, self.h = page.rect.width, page.rect.height
        self.work_all, self.work_keep = work_all, work_keep
        self.floaters = []                # Img/Fig objects drawn behind the text, anchored to the page
        self.textboxes = []               # rotated lines
        self.used_segments = set()
        self.xml_id = 0

    # -- reading
    def read(self):
        page = self.page
        self.meter.register(page)
        links = [(pymupdf.Rect(l["from"]), l["uri"]) for l in page.get_links() if l.get("uri")]
        lines = dedupe(read_lines(page))
        self.upright = attach_markers(merge_rows([l for l in lines if not l.rot]))
        self.rotated = [l for l in lines if l.rot]
        for l in self.upright:
            split_marker(l, self.body)
        self.links = links
        try:
            self.drawings = page.get_drawings()
        except Exception:
            self.drawings = []
        self.segments = segments_of(self.drawings)
        self.shapes = rect_shapes(self.drawings)

    # -- spans: underline, strike, highlight, links
    def decorate(self):
        used_shapes = set()
        for l in self.upright:
            for s in l.spans:
                bb = s["bbox"]
                size = s["size"]
                base = s["origin"][1]
                w = bb[2] - bb[0]
                if w <= 0 or not s["text"].strip():
                    continue
                for i, (o, pos, a, b, width, color, d) in enumerate(self.segments):
                    if o != "h" or min(b, bb[2]) - max(a, bb[0]) < 0.6 * w:
                        continue
                    if base + 0.04 * size <= pos <= base + 0.32 * size and (b - a) < w * 1.6 + 6:
                        s["ul"] = color
                        self.used_segments.add(i)
                    elif base - 0.42 * size <= pos <= base - 0.2 * size and (b - a) < w * 1.6 + 6:
                        s["st"] = color
                        self.used_segments.add(i)
                for si, (r, fill, border, dashed) in enumerate(self.shapes):
                    if not fill or border or r.height > 1.9 * size or overlap(bb, tuple(r)) < 0.6 * area(bb):
                        continue
                    rr = tuple(r)
                    if len([m for m in self.upright if overlap(m.bbox, rr) > 0.5 * area(m.bbox)]) > 1:
                        continue                                      # a block of text on a colour: a box, not a highlight
                    s["hl"] = fill
                    used_shapes.add(si)
                for rect, uri in self.links:
                    if overlap(bb, tuple(rect)) >= 0.5 * area(bb):
                        s["link"] = uri
                        break
        self.highlight_shapes = [sh for i, sh in enumerate(self.shapes) if i in used_shapes]
        self.shapes = [sh for i, sh in enumerate(self.shapes) if i not in used_shapes]

    # -- tables
    def tables(self):
        self.tbls = []
        if len(self.drawings) < 4:
            return
        try:
            found = self.page.find_tables().tables
        except Exception:
            return
        for t in found:
            try:
                cells = [c for c in t.cells if c]
            except Exception:
                continue
            if len(cells) < 2:
                continue
            xs = cluster([c[0] for c in cells] + [c[2] for c in cells])
            ys = cluster([c[1] for c in cells] + [c[3] for c in cells])
            if len(xs) < 3 and len(ys) < 3 or len(xs) < 2 or len(ys) < 2:
                continue
            if len(xs) == 2 and len(ys) == 2:
                continue
            empty = sum(1 for c in cells if not self.page.get_text("text", clip=pymupdf.Rect(c)).strip())
            if len(ys) - 1 >= 6 and empty > 0.4 * len(cells):
                continue                                   # a grid read into unrelated parts of the page, not a table
            grid = []
            for c in cells:
                grid.append(dict(c0=nearest(xs, c[0]), c1=nearest(xs, c[2]), r0=nearest(ys, c[1]), r1=nearest(ys, c[3]), bbox=tuple(c), items=[], fill=None, borders={}))
            bbox = (min(xs), min(ys), max(xs), max(ys))
            if area(bbox) > 0.92 * self.w * self.h:
                continue
            cells_ok = [g for g in grid if g["c1"] > g["c0"] and g["r1"] > g["r0"]]
            # the finder sometimes reads a part of a grid: believe it only if no drawn box sticks out of it and every line of
            # text inside it belongs to one of its cells
            sticks = any(overlap(tuple(r), bbox) > 0 and (r.x0 < bbox[0] - 4 or r.x1 > bbox[2] + 4 or r.y0 < bbox[1] - 4 or r.y1 > bbox[3] + 4) and area(tuple(r)) < 0.5 * self.w * self.h
                         for r, fill, border, dashed in self.shapes)
            inside_lines = [l for l in self.upright if inside(l.bbox, bbox, 0.5)]
            stray = [l for l in inside_lines if not any(inside(l.bbox, g["bbox"], 1.0) for g in cells_ok)]
            if sticks or stray:
                continue
            self.tbls.append(Tbl(bbox, xs, ys, cells_ok))
        # nested or overlapping finds: keep the larger
        keep = []
        for t in sorted(self.tbls, key=lambda t: -area(t.bbox)):
            if not any(overlap(t.bbox, k.bbox) > 0.5 * area(t.bbox) for k in keep):
                keep.append(t)
        self.tbls = keep
        for t in self.tbls:
            for c in t.cells:
                b = c["bbox"]
                best = None
                for r, fill, border, dashed in self.shapes:
                    if fill and overlap(b, tuple(r)) >= 0.8 * area(b) and area(tuple(r)) <= 1.6 * area(b):
                        best = fill
                if best is None:
                    # a fill rectangle drawn as a thin-bordered one is already in shapes; also try the raw drawings
                    for d in self.drawings:
                        f = d.get("fill")
                        if f and not is_white(f) and overlap(b, tuple(d["rect"])) >= 0.85 * area(b) and area(tuple(d["rect"])) <= 1.6 * area(b):
                            best = rgb_hex(f)
                c["fill"] = best
                for side, (o, pos) in {"top": ("h", b[1]), "bottom": ("h", b[3]), "left": ("v", b[0]), "right": ("v", b[2])}.items():
                    lo, hi = (b[0], b[2]) if o == "h" else (b[1], b[3])
                    for i, (so, spos, a, bb2, width, color, d) in enumerate(self.segments):
                        if so == o and abs(spos - pos) <= 1.8 and min(bb2, hi) - max(a, lo) >= 0.6 * (hi - lo):
                            c["borders"][side] = (width, color)
                            self.used_segments.add(i)
                            break
            self.shapes = [sh for sh in self.shapes if not (overlap(tuple(sh[0]), t.bbox) >= 0.6 * area(tuple(sh[0])))]

    # -- boxes
    def boxes(self):
        self.box_items = []
        cands = []
        for r, fill, border, dashed in self.shapes:
            rr = tuple(r)
            if area(rr) > 0.9 * self.w * self.h and not fill:
                continue
            if any(overlap(rr, t.bbox) >= 0.5 * area(rr) for t in self.tbls):
                continue
            if any(overlap(rr, ib) >= 0.8 * area(rr) and area(ib) > area(rr) * 1.05 for ib in self.picture_boxes):
                continue                                              # a colour a picture lies on: the picture shows it
            n = sum(1 for l in self.upright if inside(l.bbox, rr))
            holds_image = any(inside(tuple(i["bbox"]), rr) for i in self.page.get_image_info())
            if n or holds_image:
                cands.append(Box(rr, fill, border, dashed))
        # a box drawn with its shadow, accent or outline (a few points apart) is one box: the innermost colour fills it, the
        # outermost colour shows as its border
        out = []
        for b in sorted(cands, key=lambda b: -area(b.bbox)):
            outer = next((o for o in out if all(abs(a - c) <= 6 for a, c in zip(o.bbox, b.bbox))), None)
            if outer is None:
                out.append(b)
                continue
            inner_fill = b.fill or outer.fill
            if outer.fill and inner_fill and outer.fill != inner_fill:
                gap = max(abs(a - c) for a, c in zip(outer.bbox, b.bbox))
                outer.border = outer.border or (max(1.0, gap), outer.fill)
            outer.fill = inner_fill
        self.box_items = out

    # -- pictures and what is left of the page when the text is taken away
    def pictures(self, ocr_scan=False):
        self.imgs = []
        page = self.page
        infos = page.get_image_info(xrefs=True)
        covered = []
        for info in infos:
            r = tuple(info["bbox"])
            if area(r) < 20 or (r[2] - r[0]) < 3 or (r[3] - r[1]) < 3:
                continue
            tf = info.get("transform")
            if tf and (abs(tf[1]) > 0.05 or abs(tf[2]) > 0.05):
                continue                                              # rotated picture: left to the leftovers pass
            if r[2] - r[0] > 0.92 * self.w and r[3] - r[1] > 0.92 * self.h and ocr_scan:
                covered.append(r)
                continue
            self.imgs.append((r, info))
            covered.append(r)
        self.picture_boxes = covered

    def encode_image(self, info, r, dpi_cap=300):
        xref = info.get("xref")
        if xref:
            try:
                raw = self.doc.extract_image(xref)
                if raw and raw.get("ext") in ("jpeg", "jpg") and not raw.get("smask") and raw.get("colorspace", 3) in (1, 3) and raw.get("cs-name", "") != "DeviceCMYK":
                    data = raw["image"]
                    if data[:4] not in (bytes.fromhex("ffd8ffe0"), bytes.fromhex("ffd8ffe1")):      # python-docx wants a JFIF or Exif marker first
                        data = data[:2] + bytes.fromhex("ffe000104a46494600010100000100010000") + data[2:]
                    return data, "jpg"
            except Exception:
                pass
        native = (info.get("width") or 0) / max(1.0, r[2] - r[0]) * 72
        return self.render_clip(r, dpi=int(min(dpi_cap, max(150, native))))

    def render_clip(self, r, dpi=HI_DPI, from_keep=True):
        work = self.work_keep if from_keep else self.work_all
        clip = pymupdf.Rect(r) & work.rect
        if clip.is_empty:
            return None
        pix = work.get_pixmap(dpi=dpi, clip=clip, alpha=False)
        png = pix.tobytes("png")
        jpg = pix.tobytes("jpeg", jpg_quality=88)
        return (png, "png") if len(png) <= len(jpg) * 1.3 else (jpg, "jpg")

    def leftovers(self):
        """Rectangles of everything visible that is not text, not a table, not a box's own fill and not a rule."""
        scale = 48 / 72.0
        pix = self.work_all.get_pixmap(dpi=48, alpha=False)
        w, h, n = pix.width, pix.height, pix.n
        s = pix.samples
        mask = bytearray(w * h)
        for i in range(w * h):
            j = i * n
            if s[j] < 238 or s[j + 1] < 238 or s[j + 2] < 238:
                mask[i] = 1

        def blank(b, pad=1.2, colors=None):
            x0, y0 = max(0, int((b[0] - pad) * scale)), max(0, int((b[1] - pad) * scale))
            x1, y1 = min(w, int(math.ceil((b[2] + pad) * scale))), min(h, int(math.ceil((b[3] + pad) * scale)))
            for y in range(y0, y1):
                row = y * w
                for x in range(x0, x1):
                    if mask[row + x]:
                        if colors is None:
                            mask[row + x] = 0
                        else:
                            j = (row + x) * n
                            if abs(s[j] - colors[0]) < 10 and abs(s[j + 1] - colors[1]) < 10 and abs(s[j + 2] - colors[2]) < 10:
                                mask[row + x] = 0

        for t in self.tbls:
            blank(t.bbox, 1.5)
        for bx in self.box_items:
            if bx.fill:
                col = tuple(int(bx.fill[i:i + 2], 16) for i in (0, 2, 4))
                blank(bx.bbox, 0.5, colors=col)
            if bx.border:
                bw = bx.border[0] + 1.5
                blank((bx.x0, bx.y0, bx.x1, bx.y0 + bw), 1.5)
                blank((bx.x0, bx.y1 - bw, bx.x1, bx.y1), 1.5)
                blank((bx.x0, bx.y0, bx.x0 + bw, bx.y1), 1.5)
                blank((bx.x1 - bw, bx.y0, bx.x1, bx.y1), 1.5)
        for r, fill, border, dashed in self.highlight_shapes:
            blank(tuple(r), 1.0)
        for (r, info) in self.imgs:
            blank(r, 1.0)
        for b in self.rot_boxes:
            blank(b, 2.0)
        for edge in ((0, 0, self.w, 1.5), (0, self.h - 1.5, self.w, self.h), (0, 0, 1.5, self.h), (self.w - 1.5, 0, self.w, self.h)):
            blank(edge, 0.5)                                          # the soft edge of the sheet itself
        for bb, fill in getattr(self, "page_fills", []):
            blank(bb, 0.0, colors=tuple(int(fill[i:i + 2], 16) for i in (0, 2, 4)))
        for i in self.used_segments:
            so, pos, a, b, width, color, d = self.segments[i]
            blank((a, pos - width, b, pos + width) if so == "h" else (pos - width, a, pos + width, b), 1.0)
        # what is left: cells of 3 x 3 pixels that hold anything, joined
        cw, ch = (w + 2) // 3, (h + 2) // 3
        cells = bytearray(cw * ch)
        for y in range(h):
            row = y * w
            cr = (y // 3) * cw
            for x in range(w):
                if mask[row + x]:
                    cells[cr + x // 3] = 1
        seen = bytearray(cw * ch)
        found = []
        for start in range(cw * ch):
            if not cells[start] or seen[start]:
                continue
            stack = [start]
            seen[start] = 1
            xs0, ys0, xs1, ys1 = cw, ch, 0, 0
            count = 0
            while stack:
                c = stack.pop()
                cy, cx = divmod(c, cw)
                count += 1
                xs0, ys0, xs1, ys1 = min(xs0, cx), min(ys0, cy), max(xs1, cx), max(ys1, cy)
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        nx, ny = cx + dx, cy + dy
                        if 0 <= nx < cw and 0 <= ny < ch:
                            k = ny * cw + nx
                            if cells[k] and not seen[k]:
                                seen[k] = 1
                                stack.append(k)
            # the component's true extent in pixels (the cells above are 3 x 3 pixels coarse)
            px0, py0, px1, py1 = w, h, 0, 0
            for y in range(ys0 * 3, min(h, (ys1 + 1) * 3)):
                row = y * w
                for x in range(xs0 * 3, min(w, (xs1 + 1) * 3)):
                    if mask[row + x]:
                        if x < px0: px0 = x
                        if x > px1: px1 = x
                        if y < py0: py0 = y
                        if y > py1: py1 = y
            if px1 < px0:
                continue
            found.append([px0 / scale, py0 / scale, (px1 + 1) / scale, (py1 + 1) / scale, count])
        outlines = [b.bbox for b in self.box_items] + [c["bbox"] for t in self.tbls for c in t.cells]
        kept = []
        for f in found:
            fw, fh = f[2] - f[0], f[3] - f[1]
            if fw < 3 or fh < 3 or f[4] < 1:
                continue
            if min(fw, fh) <= 4.2 and max(fw, fh) >= 10:
                continue                                              # a hairline: a rule or a border, already carried over
            if any(all(abs(f[i] - o[i]) <= 4.5 for i in range(4)) for o in outlines):
                continue                                              # the soft edge of a box that is a cell here
            kept.append(f)
        found = []
        for f in kept:
            fw, fh = f[2] - f[0], f[3] - f[1]
            mate = None
            if fw <= 1.4 * self.body and fh <= 1.4 * self.body:
                mate = next((l for l in self.upright if not l.marker and 0 < l.x0 - f[2] <= 3.2 * l.size and l.y0 - 2 <= (f[1] + f[3]) / 2 <= l.y1 + 2), None)
            if mate is None:
                found.append(f)
                continue
            glyph = "•"
            try:
                pix = self.work_all.get_pixmap(dpi=144, clip=pymupdf.Rect(f[0], f[1], f[2], f[3]), alpha=False)
                c = (pix.height // 2) * pix.width * pix.n + (pix.width // 2) * pix.n
                if min(pix.samples[c:c + 3]) > 200:
                    glyph = "o"                                           # hollow: a circle bullet
            except Exception:
                pass
            mate.marker = ("bullet", glyph, f[0], mate.x0)
        # components that touch or nearly touch are one figure
        changed = True
        while changed:
            changed = False
            for i in range(len(found)):
                for j in range(i + 1, len(found)):
                    a, b = found[i], found[j]
                    if a[0] - 13 <= b[2] and b[0] - 13 <= a[2] and a[1] - 10 <= b[3] and b[1] - 10 <= a[3]:
                        found[i] = [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]), a[4] + b[4]]
                        del found[j]
                        changed = True
                        break
                if changed:
                    break
        self.figs = [tuple(f[:4]) for f in found]


def span_run(page, s, justified, meter):
    """One <w:r>."""
    font = esc(word_family(s["font"]) or "Arial")
    size = s["size"]
    half = max(2, round(size * 2))
    rpr = f'<w:rFonts w:ascii="{font}" w:hAnsi="{font}" w:eastAsia="{font}" w:cs="{font}"/>'
    if is_bold(s):
        rpr += "<w:b/><w:bCs/>"
    if is_italic(s):
        rpr += "<w:i/><w:iCs/>"
    if s.get("st"):
        rpr += "<w:strike/>"
    rpr += f'<w:color w:val="{hexcolor(s["color"])}"/>'
    text = s["text"]
    if not justified and len(text) >= 3:
        nat = meter.width(s["font"], text, size)
        w = s["bbox"][2] - s["bbox"][0]
        if nat:
            extra = (w - nat) / max(1, len(text) - 1)
            if 0.35 < extra < 14 and text.count(" ") <= len(text) // 3:
                rpr += f'<w:spacing w:val="{tw(extra)}"/>'
    rpr += f'<w:sz w:val="{half}"/><w:szCs w:val="{half}"/>'
    if s.get("ul"):
        rpr += f'<w:u w:val="single" w:color="{s["ul"]}"/>'
    if s.get("hl"):
        rpr += f'<w:shd w:val="clear" w:color="auto" w:fill="{s["hl"]}"/>'
    if s["flags"] & 1 and size < 0.95 * (s.get("bsize") or size):
        rpr += '<w:vertAlign w:val="superscript"/>'
    if RTL.search(text):
        rpr += "<w:rtl/>"
    return f'<w:r><w:rPr>{rpr}</w:rPr><w:t xml:space="preserve">{esc(text)}</w:t></w:r>'


def runs_xml(page, spans, justified, doc_part, meter):
    xml = ""
    pending_link, buf = None, ""
    for s in spans:
        link = s.get("link")
        run = span_run(page, s, justified, meter)
        if link != pending_link:
            if pending_link:
                xml += f'<w:hyperlink r:id="{doc_part.relate_to(pending_link, RELATIONSHIP_TYPE.HYPERLINK, is_external=True)}" w:history="1">{buf}</w:hyperlink>'
                buf = ""
            pending_link = link
        if link:
            buf += run
        else:
            xml += run
    if pending_link:
        xml += f'<w:hyperlink r:id="{doc_part.relate_to(pending_link, RELATIONSHIP_TYPE.HYPERLINK, is_external=True)}" w:history="1">{buf}</w:hyperlink>'
    return xml


class Para:
    kind = "para"

    def __init__(self, lines):
        self.lines = lines

    @property
    def x0(self):
        return min(l.x0 for l in self.lines)

    @property
    def x1(self):
        return max(l.x1 for l in self.lines)


# ---- laying out a region ----------------------------------------------------------------------------------------------------
class Builder:
    """Writes one page's body XML."""

    def __init__(self, doc, page_obj, meter, lists):
        self.doc, self.P, self.meter, self.lists = doc, page_obj, meter, lists
        self.first_top = None
        self.page_x1 = None
        self.slack = 0.0
        self.emitted = set()
        self.nid = 1000 + page_obj.pno * 200

    # ---- cuts
    def v_cut(self, items, g=None):
        g = g or max(9.0, 0.85 * self.P.body)
        spans = [(it.x0, it.x1, it) for it in sorted(items, key=lambda i: (i.x0, i.x1))]
        cols = []
        for x0, x1, it in spans:
            gap_needed = -0.5 if (cols and it.kind == "box" and all(i.kind == "box" for i in cols[-1][2])) else g
            if cols and x0 < cols[-1][1] + gap_needed:
                cols[-1][1] = max(cols[-1][1], x1)
                cols[-1][2].append(it)
            else:
                cols.append([x0, x1, [it]])
        if len(cols) < 2:
            return None
        # a cut needs both sides to share rows (a lone right-aligned date under the text is a paragraph, not a column)
        good = [cols[0]]
        for c in cols[1:]:
            prev = good[-1]
            ya = (min(i.y0 for i in prev[2]), max(i.y1 for i in prev[2]))
            yb = (min(i.y0 for i in c[2]), max(i.y1 for i in c[2]))
            share = min(ya[1], yb[1]) - max(ya[0], yb[0])
            if share >= 0.3 * min(ya[1] - ya[0], yb[1] - yb[0]) and share > 2:
                good.append(c)
            else:
                prev[1] = max(prev[1], c[1])
                prev[2].extend(c[2])
        return good if len(good) >= 2 else None

    def h_bands(self, items):
        items = sorted(items, key=lambda i: (i.y0, i.x0))
        bands = []
        for it in items:
            if bands and it.y0 < bands[-1][1] - 0.5:
                bands[-1][1] = max(bands[-1][1], it.y1)
                bands[-1][2].append(it)
            else:
                bands.append([it.y0, it.y1, [it]])
        return bands

    # ---- paragraphs
    def group(self, lines, x0, x1):
        paras = []
        cur = None
        width = max(1.0, x1 - x0)
        for l in sorted(lines, key=lambda l: (l.base, l.x0)):
            if cur is not None and self.joins(cur, l, x0, width):
                cur.lines.append(l)
            else:
                cur = Para([l])
                paras.append(cur)
        return paras

    def joins(self, cur, l, rx0, width):
        prev = cur.lines[-1]
        if l.marker:
            return False
        s = max(prev.size, l.size)
        dy = l.base - prev.base
        if abs(l.size - prev.size) > 1.6 or (prev.bold_all != l.bold_all and (prev.bold_all or l.bold_all)):
            return False
        if not (0.7 * s <= dy <= 2.1 * s):
            return False
        if len(cur.lines) >= 2:
            pitch = (cur.lines[-1].base - cur.lines[0].base) / (len(cur.lines) - 1)
            if abs(dy - pitch) > 0.3 * pitch:
                return False
        cx_prev, cx = (prev.x0 + prev.x1) / 2, (l.x0 + l.x1) / 2
        if abs(cx - cx_prev) <= 2.5 and abs(l.x0 - prev.x0) > 3:
            return True                                              # centred lines
        ref = cur.lines[1].x0 if len(cur.lines) >= 2 else prev.x0
        if len(cur.lines) == 1:
            if prev.marker:
                return abs(l.x0 - prev.x0) <= 2 + 0.35 * s
            return abs(l.x0 - prev.x0) <= 4.2 * s
        return abs(l.x0 - ref) <= 2 + 0.3 * s

    def metrics(self, p):
        """(line pitch, where the first line box starts, where the last ends) for a paragraph."""
        lines = p.lines
        first = lines[0]
        size = max(l.size for l in lines)
        nat = (first.asc - first.desc) * first.size
        if len(lines) >= 2:
            ds = sorted(b.base - a.base for a, b in zip(lines, lines[1:]))
            pitch = ds[len(ds) // 2]
        else:
            pitch = max(nat, size)
        T = first.base - pitch + (-first.desc * first.size)
        return pitch, T, T + len(lines) * pitch

    def para_xml(self, p, x0, x1, cursor, before_extra=0.0, border_top=None, border_bottom=None, right_to=None):
        """-> (xml, T, B): the paragraph's XML, where its first line box starts and where its last ends."""
        P = self.P
        lines = p.lines
        self.emitted.update(id(l) for l in lines)
        n = len(lines)
        first = lines[0]
        size = max(l.size for l in lines)
        pitch, T, B = self.metrics(p)
        rule = "exact" if pitch < 1.32 * size else "atLeast"
        # alignment
        w = max(1.0, x1 - x0)
        L = x0
        xs0 = [l.x0 for l in lines]
        xs1 = [l.x1 for l in lines]
        cxs = [(l.x0 + l.x1) / 2 for l in lines]
        jc = "left"
        tol = 2.2
        marker = first.marker
        ref = lines[1].x0 if n >= 2 else lines[0].x0
        right_edge = max(xs1)
        spread = max(xs0) - min(xs0)
        if n >= 2:
            left_flush = all(abs(x - ref) <= tol for x in xs0[1:])
            right_all = all(abs(x - right_edge) <= tol for x in xs1)
            if all(abs(c - cxs[0]) <= tol for c in cxs) and spread > tol:
                jc = "center"
            elif right_all and spread > tol:
                jc = "right"
            elif left_flush and all(abs(x - right_edge) <= tol for x in xs1[:-1]) and abs(lines[0].x0 - ref) <= 4.5 * lines[0].size                     and xs1[0] >= x1 - 0.12 * w and (right_edge - ref) > 0.4 * w and n >= 3:
                jc = "both"
        else:
            if abs(cxs[0] - (L + w / 2)) <= max(2.5, 0.012 * w) and (lines[0].x0 - L) > 0.08 * w and (x1 - lines[0].x1) > 0.08 * w:
                jc = "center"
            elif x1 - lines[0].x1 <= max(2.5, 0.012 * w) and (lines[0].x0 - L) > 0.12 * w:
                jc = "right"
        # which line ends are the text wrapping (it may reflow) and which are the author's own line breaks
        word = lambda l: (l.text.split() or [""])[0]
        breaks = []
        for a_, b_ in zip(lines, lines[1:]):
            width_next = (b_.x1 - b_.x0) * len(word(b_)) / max(1, len(b_.text.strip()))
            room = right_edge - a_.x1
            natural = jc == "both" or ((right_edge - ref) >= 0.8 * w and room < width_next + 0.25 * b_.size)
            breaks.append(not natural)
        reflow = n >= 2 and not any(breaks)
        ind_left = ind_right = 0.0
        first_line = (marker[3] if marker else lines[0].x0) - ref if n >= 2 else 0.0
        if jc == "right":
            ind_left = 0.0
            ind_right = x1 - right_edge
        elif jc == "center":
            slack = 0.04 * (right_edge - min(xs0)) + 3.0                 # a wider substitute font must not wrap the line
            ind_left = max(0.0, min(xs0) - L - slack)
            ind_right = max(0.0, x1 - right_edge - slack)
        else:
            ind_left = ((marker[3] if marker else ref) if n == 1 else ref) - L
            if reflow or jc == "both":
                ind_right = max(0.0, x1 - right_edge - (2.5 + 0.01 * (right_edge - ref)) if jc != "both" else x1 - right_edge)
        if right_to is not None and n == 1:
            ind_right = max(0.0, x1 - right_to)
        ind_left = max(0.0, ind_left)
        ind_right = max(0.0, ind_right)
        if self.page_x1 is not None and abs(x1 - self.page_x1) < 0.01 and (ind_right > 0 or jc != "left" or reflow):
            ind_right += self.slack                                   # the page's right margin leaves a little room: see convert_page
        # first line / hanging indent, or a list
        num_pr = ""
        if marker:
            num_id = self.lists.item(self.doc, marker, lines[0])
            hang = max(0.0, marker[3] - marker[2])
            ind_attr = f'<w:ind w:left="{tw(ind_left)}" w:hanging="{tw(hang)}"' + (f' w:right="{tw(ind_right)}"' if ind_right else "") + "/>"
            num_pr = f'<w:numPr><w:ilvl w:val="0"/><w:numId w:val="{num_id}"/></w:numPr>'
        else:
            if first_line >= 0.5 and n >= 2:
                ind_attr = f'<w:ind w:left="{tw(ind_left)}" w:firstLine="{tw(first_line)}"'
            elif first_line <= -0.5 and n >= 2:
                ind_attr = f'<w:ind w:left="{tw(ind_left)}" w:hanging="{tw(-first_line)}"'
            else:
                ind_attr = f'<w:ind w:left="{tw(ind_left)}"'
            ind_attr += (f' w:right="{tw(ind_right)}"' if ind_right else "") + "/>"
        if os.environ.get("POMELO_DEBUG"):
            sys.stderr.write("para %s n=%d jc=%s breaks=%s ind=%s | %s\n" % (self.P.pno + 1, n, jc, breaks, ind_attr, " / ".join(l.text for l in lines)[:90]))
        # space before: the gap between where the previous block ended and where this one starts
        if cursor is None:
            before = 0.0
            if self.first_top is None:
                self.first_top = T
        else:
            before = max(0.0, T - cursor)
        bt = bb = ""
        if border_top:
            bw, col, sp = border_top
            before = max(0.0, before - bw - sp)
            bt = f'<w:top w:val="single" w:sz="{max(2, int(round(bw * 8)))}" w:space="{int(max(0, min(31, round(sp))))}" w:color="{col}"/>'
            B += 0
        if border_bottom:
            bw, col, sp = border_bottom
            bb = f'<w:bottom w:val="single" w:sz="{max(2, int(round(bw * 8)))}" w:space="{int(max(0, min(31, round(sp))))}" w:color="{col}"/>'
            B += bw + sp
        borders = f"<w:pBdr>{bt}{bb}</w:pBdr>" if (bt or bb) else ""
        # tabs for rows of cells joined into one paragraph
        tabs = ""
        spacing = f'<w:spacing w:before="{tw(before)}" w:after="0" w:line="{tw(pitch)}" w:lineRule="{rule}"/>'
        heading = ""
        if size >= self.P.body * 1.25 and n <= 3 and len(" ".join(l.text for l in lines)) <= 140 and not marker:
            lvl = 0 if size >= self.P.body * 1.7 else 1 if size >= self.P.body * 1.4 else 2
            heading = f'<w:outlineLvl w:val="{lvl}"/>'
        ppr = f'<w:pPr>{num_pr}{borders}{tabs}{spacing}{ind_attr}<w:jc w:val="{jc}"/>{heading}</w:pPr>'
        # runs
        justified = jc == "both"
        body = ""
        for i, l in enumerate(lines):
            spans = [dict(s) for s in l.spans]
            last_line = i == n - 1
            if not last_line and not breaks[i] and spans:
                last = spans[-1]
                t = last["text"]
                nxt = lines[i + 1].text.lstrip()
                if t.rstrip().endswith("-") and len(t.rstrip()) > 2 and t.rstrip()[-2].isalpha() and nxt[:1].islower():
                    last["text"] = t.rstrip()[:-1]
                elif not t.endswith(" "):
                    last["text"] = t + " "
            for s_ in spans:
                s_["bsize"] = l.size
            body += runs_xml(self.P, spans, justified, self.doc.part, self.meter)
            if not last_line and breaks[i]:
                body += "<w:r><w:br/></w:r>"
        return f"<w:p>{ppr}{body}</w:p>", T, B

    def frames(self, lines):
        """Text that sits on a picture: positioned paragraphs (frames), each one still real text that reflows inside its frame."""
        xml = ""
        for p in self.group(lines, min(l.x0 for l in lines), max(l.x1 for l in lines)):
            pitch, T, B = self.metrics(p)
            fx0, fx1 = p.x0 - (p.lines[0].x0 - (p.lines[0].marker[2] if p.lines[0].marker else p.lines[0].x0)), p.x1 + 3.0
            part, T, B = self.para_xml(p, fx0, fx1, T)
            frame = (f'<w:framePr w:w="{tw(fx1 - fx0)}" w:h="{tw(B - T)}" w:hRule="atLeast" w:hSpace="0" w:vSpace="0" w:wrap="none" '
                     f'w:vAnchor="page" w:hAnchor="page" w:x="{tw(fx0)}" w:y="{tw(T)}"/>')
            xml += part.replace("<w:pPr>", "<w:pPr>" + frame, 1)
        return xml

    def tabbed_para(self, lines, x0, x1, cursor):
        """Several single pieces on one row, as one paragraph with tab stops."""
        P = self.P
        lines = sorted(lines, key=lambda l: l.x0)
        self.emitted.update(id(l) for l in lines)
        first = lines[0]
        size = max(l.size for l in lines)
        nat = (first.asc - first.desc) * first.size
        pitch = max(nat, size)
        d = -first.desc * first.size
        T = first.base - pitch + d
        before = 0.0 if cursor is None else max(0.0, T - cursor)
        if cursor is None and self.first_top is None:
            self.first_top = T
        stops = ""
        body = ""
        for i, l in enumerate(lines):
            if i:
                if l.x1 >= x1 - 3 and l.x0 > first.x1 + 20:
                    stops += f'<w:tab w:val="right" w:pos="{tw(l.x1 - x0)}"/>'
                else:
                    stops += f'<w:tab w:val="left" w:pos="{tw(l.x0 - x0)}"/>'
                body += "<w:r><w:tab/></w:r>"
            body += runs_xml(P, l.spans, False, self.doc.part, self.meter)
        ppr = (f'<w:pPr><w:tabs>{stops}</w:tabs><w:spacing w:before="{tw(before)}" w:after="0" w:line="{tw(pitch)}" w:lineRule="exact"/>'
               f'<w:ind w:left="{tw(first.x0 - x0)}"/></w:pPr>')
        return f"<w:p>{ppr}{body}</w:p>", T, T + pitch

    # ---- stacks of blocks
    def spacer(self, h):
        if h < 1.0:
            return ""
        return f'<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="{tw(h)}" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/></w:rPr></w:pPr></w:p>'

    def next_id(self):
        self.nid += 1
        return self.nid

    def picture_xml(self, it, floating=False, name="Picture"):
        rid, _ = self.doc.part.get_or_add_image(io.BytesIO(it.data))
        cx, cy = int((it.x1 - it.x0) * 12700), int((it.y1 - it.y0) * 12700)
        pid = self.next_id()
        pic = (f'<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="{pid}" name="{name} {pid}"/>'
               f'<pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
               f'<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>')
        if not floating:
            return (f'<w:r><w:rPr><w:sz w:val="2"/></w:rPr><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="{cx}" cy="{cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>'
                    f'<wp:docPr id="{pid}" name="{name} {pid}"/><wp:cNvGraphicFramePr/>{pic}</wp:inline></w:drawing></w:r>')
        return (f'<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="{pid}" behindDoc="1" locked="1" layoutInCell="1" allowOverlap="1">'
                f'<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>{int(it.x0 * 12700)}</wp:posOffset></wp:positionH>'
                f'<wp:positionV relativeFrom="page"><wp:posOffset>{int(it.y0 * 12700)}</wp:posOffset></wp:positionV><wp:extent cx="{cx}" cy="{cy}"/>'
                f'<wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="{pid}" name="{name} {pid}"/><wp:cNvGraphicFramePr/>{pic}</wp:anchor></w:drawing></w:r>')

    def image_para(self, it, x0, x1, cursor):
        before = 0.0 if cursor is None else max(0.0, it.y0 - cursor)
        if cursor is None and self.first_top is None:
            self.first_top = it.y0
        w = it.x1 - it.x0
        left = max(0.0, it.x0 - x0)
        ppr = (f'<w:pPr><w:spacing w:before="{tw(before)}" w:after="0" w:line="240" w:lineRule="auto"/><w:ind w:left="{tw(left)}"/>'
               f'<w:rPr><w:sz w:val="2"/></w:rPr></w:pPr>')
        return f"<w:p>{ppr}{self.picture_xml(it)}</w:p>", it.y0, it.y1

    def stripes(self, items):
        """Boxes of the same width stacked one above another (the shaded rows of a table drawn without grid lines) are one
        table; so are the rows between them that have no shading."""
        boxes = sorted([i for i in items if i.kind == "box" and (i.fill or i.border)], key=lambda b: (b.y0, b.x0))
        if len(boxes) < 2:
            return items
        items = list(items)
        # boxes of one height standing side by side (the shaded cells of a header row) are one row of cells
        rowsets = []
        for b in boxes:
            for r in rowsets:
                if abs(r[0].y0 - b.y0) <= 1.5 and abs(r[0].y1 - b.y1) <= 1.5 and -1 <= b.x0 - r[-1].x1 <= 3:
                    r.append(b)
                    break
            else:
                rowsets.append([b])
        boxes = []
        composites = {}
        for r in rowsets:
            if len(r) == 1:
                boxes.append(r[0])
                continue
            comp = Box((min(b.x0 for b in r), min(b.y0 for b in r), max(b.x1 for b in r), max(b.y1 for b in r)), None, None)
            comp.children = [c for b in r for c in b.children]
            comp.parts = [(b.x0, b.x1, b.fill) for b in r]
            composites[id(comp)] = r
            boxes.append(comp)
            for b in r:
                items.remove(b)
            items.append(comp)
        boxes.sort(key=lambda b: (b.y0, b.x0))
        groups = []
        for b in boxes:
            for g in groups:
                last = g[-1]
                if abs(last.x0 - b.x0) <= 2.5 and abs(last.x1 - b.x1) <= 2.5 and -2 <= b.y0 - last.y1 <= 2.2 * max(self.P.body, 10):
                    g.append(b)
                    break
            else:
                groups.append([b])
        out = list(items)
        for g in groups:
            if len(g) < 2:
                if g and id(g[0]) in composites:
                    out.remove(g[0])
                    out.extend(composites[id(g[0])])
                continue
            x0, x1 = g[0].x0, g[0].x1
            rows = []
            taken = []
            for k, b in enumerate(g):
                if k:
                    prev = g[k - 1]
                    gap = b.y0 - prev.y1
                    if gap > 2:
                        between = [i for i in out if i.kind in ("line", "img", "rule") and i not in taken and x0 - 1 <= (i.x0 + i.x1) / 2 <= x1 + 1 and prev.y1 - 1 <= (i.y0 + i.y1) / 2 <= b.y0 + 1]
                        taken += between
                        rows.append({"y0": prev.y1, "y1": b.y0, "fill": None, "border": None, "items": between})
                rows.append({"y0": b.y0, "y1": b.y1, "fill": b.fill, "border": b.border, "items": list(b.children), "parts": getattr(b, "parts", None)})
            content = [i for r in rows for i in r["items"] if i.kind in ("line", "img")]
            cols = self.v_cut(content) if content else None
            inner = []
            if cols:
                for a, c in zip(cols, cols[1:]):
                    inner.append((a[1] + c[0]) / 2)
            for r in rows:
                for px0, px1, pf in r.get("parts") or []:
                    inner += [px0, px1]
            edges = [x0] + [v for v in cluster([v for v in inner if x0 + 1 < v < x1 - 1], 3.0)] + [x1]
            ys = [rows[0]["y0"]] + [r["y1"] for r in rows]
            cells = []
            for ri, r in enumerate(rows):
                borders = {}
                keep = []
                for it in r["items"]:
                    if it.kind == "rule" and abs(it.y0 + (it.y1 - it.y0) / 2 - r["y1"]) <= 2.5:
                        borders["bottom"] = (max(0.5, it.width), it.color)
                    elif it.kind == "rule" and abs(it.y0 + (it.y1 - it.y0) / 2 - r["y0"]) <= 2.5:
                        borders["top"] = (max(0.5, it.width), it.color)
                    else:
                        keep.append(it)
                if r["border"]:
                    borders.setdefault("bottom", r["border"])
                    borders.setdefault("top", r["border"])
                for k in range(len(edges) - 1):
                    mine = [i for i in keep if edges[k] - 0.5 <= (i.x0 + i.x1) / 2 < edges[k + 1] + 0.5]
                    mid = (edges[k] + edges[k + 1]) / 2
                    fill = next((pf for px0, px1, pf in (r.get("parts") or []) if px0 - 0.5 <= mid <= px1 + 0.5), r["fill"])
                    cells.append(dict(c0=k, c1=k + 1, r0=ri, r1=ri + 1, bbox=(edges[k], ys[ri], edges[k + 1], ys[ri + 1]), items=mine, fill=fill, borders=dict(borders)))
            for b in g:
                out.remove(b)
            for i in taken:
                if i in out:
                    out.remove(i)
            out.append(Tbl((x0, ys[0], x1, ys[-1]), edges, ys, cells))
        return out

    def emit(self, items, x0, x1, cursor):
        """XML for `items` laid out between x0 and x1; cursor is where the previous block ended (None: top of the page)."""
        items = [i for i in items if i is not None]
        if not items:
            return "", cursor
        items = self.stripes(items)
        cols = self.v_cut(items)
        if cols:
            return self.row(cols, x0, x1, cursor)
        bands = self.h_bands(items)
        if len(bands) > 1:
            grouped = []
            for y0, y1, its in bands:
                sig = self.v_cut(its)
                key = None if not sig else [(round(c[0]), round(c[1])) for c in sig]
                if grouped and grouped[-1]["key"] == key and (key is None or all(abs(a[0] - b[0]) < 8 and abs(a[1] - b[1]) < 8 for a, b in zip(grouped[-1]["key"], key))):
                    grouped[-1]["items"].extend(its)
                else:
                    grouped.append({"key": key, "items": list(its)})
            if len(grouped) > 1:
                xml = ""
                for g in grouped:
                    part, cursor = self.leaf_or_row(g["items"], x0, x1, cursor)
                    xml += part
                return xml, cursor
        return self.leaf(items, x0, x1, cursor)

    def leaf_or_row(self, items, x0, x1, cursor):
        cols = self.v_cut(items)
        if cols:
            return self.row(cols, x0, x1, cursor)
        return self.leaf(items, x0, x1, cursor)

    def row(self, cols, x0, x1, cursor):
        cells = [(c[0], c[1], c[2]) for c in cols]
        # one line per cell, all on one baseline: a paragraph with tab stops
        if all(len(c[2]) == 1 and c[2][0].kind == "line" and not c[2][0].marker for c in cells):
            ls = [c[2][0] for c in cells]
            if max(l.base for l in ls) - min(l.base for l in ls) <= 0.3 * min(l.size for l in ls):
                xml, T, B = self.tabbed_para(ls, x0, x1, cursor)
                return xml, B
        top = min(i.y0 for c in cells for i in c[2])
        bottom = max(i.y1 for c in cells for i in c[2])
        edges = [x0]
        for a, b in zip(cells, cells[1:]):
            edges.append((a[1] + b[0]) / 2)
        edges.append(x1)
        tcs = ""
        for k, (cx0, cx1, its) in enumerate(cells):
            lo, hi = edges[k], edges[k + 1]
            inner, _ = self.emit(its, lo, hi, top)
            if not inner:
                inner = self.spacer(1)
            if not inner.rstrip().endswith("</w:p>"):
                inner += self.spacer(1)
            tcs += (f'<w:tc><w:tcPr><w:tcW w:w="{tw(hi - lo)}" w:type="dxa"/><w:tcMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/>'
                    f'<w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tcMar></w:tcPr>{inner}</w:tc>')
        grid = "".join(f'<w:gridCol w:w="{tw(edges[k + 1] - edges[k])}"/>' for k in range(len(cells)))
        before = 0.0 if cursor is None else max(0.0, top - cursor)
        if cursor is None and self.first_top is None:
            self.first_top = top
        xml = self.spacer(before)
        xml += (f'<w:tbl><w:tblPr><w:tblW w:w="{tw(x1 - x0)}" w:type="dxa"/><w:tblInd w:w="0" w:type="dxa"/><w:tblLayout w:type="fixed"/>'
                f'<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPr>'
                f'<w:tblGrid>{grid}</w:tblGrid><w:tr><w:trPr><w:trHeight w:val="{tw(bottom - top)}" w:hRule="atLeast"/></w:trPr>{tcs}</w:tr></w:tbl>')
        xml += self.spacer(1)
        return xml, bottom + 1

    def leaf(self, items, x0, x1, cursor):
        xml = ""
        items = sorted(items, key=lambda i: (i.y0, i.x0))
        blocks = []
        run = []
        for it in items:
            if it.kind == "line":
                run.append(it)
                continue
            if run:
                blocks += self.group(run, x0, x1)
                run = []
            blocks.append(it)
        if run:
            blocks += self.group(run, x0, x1)
        for bi, blk in enumerate(blocks):
            if blk.kind == "rule":
                cy = (blk.y0 + blk.y1) / 2
                bw = max(0.5, blk.width)
                before = 0.0 if cursor is None else max(0.0, cy - bw / 2 - 1.0 - cursor)
                if cursor is None and self.first_top is None:
                    self.first_top = cy - bw / 2 - 1.0
                xml += (f'<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="{max(2, int(round(bw * 8)))}" w:space="0" w:color="{blk.color}"/></w:pBdr>'
                        f'<w:spacing w:before="{tw(before)}" w:after="0" w:line="20" w:lineRule="exact"/>'
                        f'<w:ind w:left="{tw(max(0.0, blk.x0 - x0))}" w:right="{tw(max(0.0, x1 - blk.x1) + (self.slack if self.page_x1 is not None and abs(x1 - self.page_x1) < 0.01 else 0.0))}"/><w:rPr><w:sz w:val="2"/></w:rPr></w:pPr></w:p>')
                cursor = cy + bw / 2
            elif blk.kind == "para":
                top_b = bot_b = right_to = None
                part, T, B = self.para_xml(blk, x0, x1, cursor)
                xml += part
                cursor = B
            elif blk.kind == "img":
                if blk.floating:
                    self.P.floaters.append(blk)
                    continue
                part, T, B = self.image_para(blk, x0, x1, cursor)
                xml += part
                cursor = B
            elif blk.kind == "tbl":
                part, cursor = self.table(blk, x0, x1, cursor)
                xml += part
            elif blk.kind == "box":
                part, cursor = self.box(blk, x0, x1, cursor)
                xml += part
        return xml, cursor

    # ---- tables and boxes
    def border_xml(self, borders, dashed=False):
        out = ""
        for side in ("top", "left", "bottom", "right"):
            b = borders.get(side)
            if b:
                w, color = b
                out += f'<w:{side} w:val="{"dashed" if dashed else "single"}" w:sz="{max(2, min(96, int(round(w * 8))))}" w:space="0" w:color="{color}"/>'
            else:
                out += f'<w:{side} w:val="nil"/>'
        return f"<w:tcBorders>{out}</w:tcBorders>"

    def box(self, bx, x0, x1, cursor):
        before = 0.0 if cursor is None else max(0.0, bx.y0 - cursor)
        if cursor is None and self.first_top is None:
            self.first_top = bx.y0
        inner, _ = self.emit(bx.children, bx.x0, bx.x1, bx.y0)
        if not inner or not inner.rstrip().endswith("</w:p>"):
            inner += self.spacer(1)
        sides = {s: bx.border for s in ("top", "left", "bottom", "right")} if bx.border else {}
        shd = f'<w:shd w:val="clear" w:color="auto" w:fill="{bx.fill}"/>' if bx.fill else ""
        xml = self.spacer(before)
        xml += (f'<w:tbl><w:tblPr><w:tblW w:w="{tw(bx.x1 - bx.x0)}" w:type="dxa"/><w:tblInd w:w="{tw(max(0.0, bx.x0 - x0))}" w:type="dxa"/><w:tblLayout w:type="fixed"/>'
                f'<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPr>'
                f'<w:tblGrid><w:gridCol w:w="{tw(bx.x1 - bx.x0)}"/></w:tblGrid><w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="{tw(bx.y1 - bx.y0)}" w:hRule="atLeast"/></w:trPr>'
                f'<w:tc><w:tcPr><w:tcW w:w="{tw(bx.x1 - bx.x0)}" w:type="dxa"/>{self.border_xml(sides, bx.dashed)}{shd}</w:tcPr>{inner}</w:tc></w:tr></w:tbl>')
        xml += self.spacer(1)
        return xml, bx.y1 + 1

    def table(self, t, x0, x1, cursor):
        before = 0.0 if cursor is None else max(0.0, t.y0 - cursor)
        if cursor is None and self.first_top is None:
            self.first_top = t.y0
        xs, ys = t.xs, t.ys
        ncol, nrow = len(xs) - 1, len(ys) - 1
        grid = [[None] * ncol for _ in range(nrow)]
        for c in t.cells:
            for r in range(c["r0"], c["r1"]):
                for k in range(c["c0"], c["c1"]):
                    if 0 <= r < nrow and 0 <= k < ncol:
                        grid[r][k] = c
        rows = ""
        for r in range(nrow):
            tcs = ""
            k = 0
            while k < ncol:
                c = grid[r][k]
                if c is None:
                    span = 1
                    while k + span < ncol and grid[r][k + span] is None:
                        span += 1
                    width = xs[k + span] - xs[k]
                    tcs += (f'<w:tc><w:tcPr><w:tcW w:w="{tw(width)}" w:type="dxa"/>' + (f'<w:gridSpan w:val="{span}"/>' if span > 1 else "")
                            + f'<w:tcBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/></w:tcBorders></w:tcPr>{self.spacer(1)}</w:tc>')
                    k += span
                    continue
                span = c["c1"] - c["c0"]
                width = xs[c["c1"]] - xs[c["c0"]]
                vm = ""
                if c["r1"] - c["r0"] > 1:
                    vm = '<w:vMerge w:val="restart"/>' if r == c["r0"] else "<w:vMerge/>"
                if r == c["r0"]:
                    cx0, cy0, cx1, cy1 = c["bbox"]
                    inner, _ = self.emit(c["items"], cx0, cx1, cy0)
                    if not inner or not inner.rstrip().endswith("</w:p>"):
                        inner += self.spacer(1)
                else:
                    inner = self.spacer(1)
                shd = f'<w:shd w:val="clear" w:color="auto" w:fill="{c["fill"]}"/>' if c["fill"] else ""
                tcs += (f'<w:tc><w:tcPr><w:tcW w:w="{tw(width)}" w:type="dxa"/>' + (f'<w:gridSpan w:val="{span}"/>' if span > 1 else "") + vm
                        + self.border_xml(c["borders"]) + shd
                        + '<w:tcMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tcMar>'
                        + f'</w:tcPr>{inner}</w:tc>')
                k += span
            rows += f'<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="{tw(ys[r + 1] - ys[r])}" w:hRule="atLeast"/></w:trPr>{tcs}</w:tr>'
        tgrid = "".join(f'<w:gridCol w:w="{tw(xs[k + 1] - xs[k])}"/>' for k in range(ncol))
        xml = self.spacer(before)
        xml += (f'<w:tbl><w:tblPr><w:tblW w:w="{tw(xs[-1] - xs[0])}" w:type="dxa"/><w:tblInd w:w="{tw(max(0.0, xs[0] - x0))}" w:type="dxa"/><w:tblLayout w:type="fixed"/>'
                f'<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPr>'
                f'<w:tblGrid>{tgrid}</w:tblGrid>{rows}</w:tbl>')
        xml += self.spacer(1)
        return xml, t.y1 + 1


class Lists:
    """Bullet and numbering definitions, made once per look and per run of numbers."""

    def __init__(self):
        self.made = {}
        self.next_a = 1
        self.next_n = 1
        self.last = {}                 # (indent key) -> (last number, numId)

    def setup(self, doc):
        part = doc.part.numbering_part.element
        ids_a = [int(a.get(qn("w:abstractNumId"))) for a in part.findall(qn("w:abstractNum"))]
        ids_n = [int(n.get(qn("w:numId"))) for n in part.findall(qn("w:num"))]
        self.next_a = (max(ids_a) + 1) if ids_a else 1
        self.next_n = (max(ids_n) + 1) if ids_n else 1
        self.part = part

    def item(self, doc, marker, line):
        kind, token, mx0, tx0 = marker
        span = next((s for s in line.spans if s["text"].strip()), line.spans[0])
        font = esc(word_family(span["font"]) or "Arial")
        sz = max(2, round(span["size"] * 2))
        color = hexcolor(span["color"])
        hang = max(0, tx0 - mx0)
        if kind == "bullet":
            glyph = {"o": "o", "": "•", "": "▪", "": "➢", "": "❖", "": "■", "": "✓", "": "□", "": "o"}.get(token, token)
            key = ("b", glyph, sz, color, round(hang))
            if key not in self.made:
                font_bullet = "Courier New" if glyph == "o" else "Arial"
                self.made[key] = self.define(f'<w:numFmt w:val="bullet"/><w:suff w:val="tab"/><w:lvlText w:val="{esc(glyph)}"/>', f'<w:rFonts w:ascii="{font_bullet}" w:hAnsi="{font_bullet}" w:cs="{font_bullet}" w:hint="default"/><w:color w:val="{color}"/><w:sz w:val="{sz}"/>', 1)
            return self.made[key]
        digits = re.sub(r"[^0-9a-z]", "", token)
        paren = token.startswith("(")
        suffix = token[-1]
        if digits.isdigit():
            fmt, start = "decimal", int(digits)
        else:
            fmt, start = "lowerLetter", ord(digits[0]) - 96 if digits else 1
        key = ("n", fmt, suffix, paren, sz, color, round(hang))
        last = self.last.get(key)
        if last and last[0] + 1 == start:
            self.last[key] = (start, last[1])
            return last[1]
        text = ("(" if paren else "") + "%1" + suffix
        num_id = self.define(f'<w:numFmt w:val="{fmt}"/><w:suff w:val="tab"/><w:lvlText w:val="{text}"/>', f'<w:rFonts w:ascii="{font}" w:hAnsi="{font}" w:cs="{font}"/><w:color w:val="{color}"/><w:sz w:val="{sz}"/>', start)
        self.last[key] = (start, num_id)
        return num_id

    def define(self, fmt, rpr, start):
        a, n = self.next_a, self.next_n
        self.next_a += 1
        self.next_n += 1
        abstract = parse_xml(f'<w:abstractNum {nsdecls("w")} w:abstractNumId="{a}"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="{start}"/>{fmt}<w:lvlJc w:val="left"/><w:rPr>{rpr}</w:rPr></w:lvl></w:abstractNum>')
        first_num = self.part.find(qn("w:num"))
        if first_num is not None:
            first_num.addprevious(abstract)
        else:
            self.part.append(abstract)
        self.part.append(parse_xml(f'<w:num {nsdecls("w")} w:numId="{n}"><w:abstractNumId w:val="{a}"/></w:num>'))
        return n


def body_size(all_lines):
    sizes = Counter()
    for l in all_lines:
        for s in l.spans:
            if s["text"].strip():
                sizes[round(s["size"] * 2) / 2] += len(s["text"])
    return sizes.most_common(1)[0][0] if sizes else 10.0


def convert(src, dst, progress=lambda f: None, log=lambda m: None):
    doc = pymupdf.open(src)
    if doc.needs_pass:
        raise RuntimeError("This PDF is password-protected")
    work_all = pymupdf.open(src)
    work_keep = pymupdf.open(src)
    meter = FontMeter(doc)
    out = Document()
    body = out.element.body
    for el in list(body):
        if el.tag != qn("w:sectPr"):
            body.remove(el)
    lists = Lists()
    lists.setup(out)

    # the size of ordinary text, for the whole document: headings and list detection key off it
    sample = []
    for page in list(doc)[:60]:
        sample += [l for l in read_lines(page) if not l.rot]
    body_pt = body_size(sample)

    n = len(doc)
    totals = {"words": 0}
    for pno in range(n):
        progress(0.97 * pno / max(1, n))
        page = doc[pno]
        try:
            xml, sect = convert_page(doc, work_all, work_keep, out, page, pno, meter, lists, body_pt, n, log)
        except Exception as e:                                         # one odd page must not lose the document: its text is kept
            log("page %d could not be rebuilt in full (%s); kept as text" % (pno + 1, e))
            xml, sect = convert_page(doc, work_all, work_keep, out, page, pno, meter, lists, body_pt, n, log, safe=True)
        for el in list(parse_xml(f'<w:body {NS}>{xml}</w:body>')):
            body.insert(len(body) - 1, el)
        if pno == n - 1:
            final = body.find(qn("w:sectPr"))
            body.replace(final, parse_xml(sect))
    meta = doc.metadata or {}
    props = out.core_properties
    props.title = meta.get("title") or ""
    props.author = meta.get("author") or ""
    props.subject = meta.get("subject") or ""
    props.keywords = meta.get("keywords") or ""
    out.save(dst)


def convert_page(doc, work_all, work_keep, out, page, pno, meter, lists, body_pt, n_pages, log, safe=False):
    """safe: only the text, as paragraphs (what a page falls back to when something exotic in it cannot be rebuilt)."""
    P = Page(doc, work_all[pno], work_keep[pno], page, pno, meter, body_pt)
    P.read()
    P.tbls = []
    if not safe:
        P.tables()
    P.decorate()
    # a page that is one big picture with an invisible text layer is a scan: the picture is dropped, the text is kept
    big = [i for i in page.get_image_info() if area(tuple(i["bbox"])) > 0.85 * P.w * P.h]
    scan = False
    if big and P.upright:
        try:
            trace = page.get_texttrace()
            hidden = sum(len(t.get("chars", [])) for t in trace if t.get("type") == 3)
            total = sum(len(t.get("chars", [])) for t in trace) or 1
            scan = hidden / total > 0.8
        except Exception:
            scan = False
    P.pictures(ocr_scan=scan)
    P.boxes()
    if safe:
        P.imgs, P.box_items = [], []
    # a colour that covers the whole page is the page's background: a one-pixel picture stretched behind everything
    P.page_fills = []
    background = []
    for b in list(P.box_items):
        if area(b.bbox) >= 0.9 * P.w * P.h and b.fill:
            P.box_items.remove(b)
            P.page_fills.append((b.bbox, b.fill))
            rgb = tuple(int(b.fill[i:i + 2], 16) for i in (0, 2, 4))
            px = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 2, 2), False)
            px.clear_with(0)
            for xx in range(2):
                for yy in range(2):
                    px.set_pixel(xx, yy, rgb)
            background.append(Fig((0.0, 0.0, P.w, P.h), px.tobytes("png"), "png", floating=True))
            background[-1].overlay = True

    # redact the text we recreate from two copies of the page: one with all of it gone (to find leftovers), one that
    # keeps the text that belongs to a chart or a logo (to cut pictures from)
    rot_boxes = []
    for l in P.rotated:
        b = list(l.bbox)
        for o in rot_boxes:
            if overlap(tuple(b), tuple(o)) > 0 or (abs(o[0] - b[0]) < 30 and abs(o[1] - b[1]) < 30):
                o[:] = [min(o[0], b[0]), min(o[1], b[1]), max(o[2], b[2]), max(o[3], b[3])]
                break
        else:
            rot_boxes.append(b)
    P.rot_boxes = [tuple(b) for b in rot_boxes]
    rot_boxes = P.rot_boxes
    all_lines = [l for l in P.upright if not any(overlap(l.bbox, r) > 0.05 * area(l.bbox) for r in rot_boxes)]
    def boxes_of(l):
        out = [s["bbox"] for s in l.spans]
        if l.marker_box:
            out.append(l.marker_box)
        return out
    for l in all_lines:
        for bb in boxes_of(l):
            r = pymupdf.Rect(bb)
            inset = r.height * 0.18
            P.work_all.add_redact_annot(pymupdf.Rect(r.x0, r.y0 + inset, r.x1, r.y1 - inset), fill=False)
    if all_lines:
        P.work_all.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE, graphics=pymupdf.PDF_REDACT_LINE_ART_NONE, text=pymupdf.PDF_REDACT_TEXT_REMOVE)
    if safe:
        P.figs = []
    else:
        P.leftovers()
    merged = []
    for b in P.rot_boxes:
        box = list(b)
        for f in list(P.figs):
            if f[0] - 8 <= box[2] and box[0] - 8 <= f[2] and f[1] - 8 <= box[3] and box[1] - 8 <= f[3]:
                box = [min(box[0], f[0]), min(box[1], f[1]), max(box[2], f[2]), max(box[3], f[3])]
                P.figs.remove(f)
        merged.append(tuple(box))
    P.rot_boxes = merged

    # text that belongs to a picture (chart labels): stays in the picture
    absorbed = set()
    for f in P.figs:
        inside_lines = [l for l in P.upright if inside(l.bbox, f, 1.0)]
        if len(inside_lines) >= 5 and sum(len(l.text) for l in inside_lines) / len(inside_lines) <= 16 and 8000 < area(f) <= 0.35 * P.w * P.h:
            for l in inside_lines:
                absorbed.add(id(l))
    for l in P.upright:
        if id(l) in absorbed:
            l.absorbed = True
    keep_lines = [l for l in all_lines if not l.absorbed]
    for l in keep_lines:
        for bb in boxes_of(l):
            r = pymupdf.Rect(bb)
            inset = r.height * 0.18
            P.work_keep.add_redact_annot(pymupdf.Rect(r.x0, r.y0 + inset, r.x1, r.y1 - inset), fill=False)
    if keep_lines:
        P.work_keep.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE, graphics=pymupdf.PDF_REDACT_LINE_ART_NONE, text=pymupdf.PDF_REDACT_TEXT_REMOVE)

    text_lines = [l for l in P.upright if not l.absorbed]
    # elements
    elements = []
    tbls = P.tbls
    boxes = P.box_items
    # pictures: in line with the text, or behind it when text sits on top
    def sits_on(bb):
        return any(overlap(l.bbox, bb) >= 0.5 * area(l.bbox) for l in text_lines)
    for r, info in P.imgs:
        data = P.encode_image(info, r)
        if not data:
            continue
        elements.append(Img(r, data[0], data[1], floating=sits_on(r)))
    for f in P.figs:
        data = P.render_clip(f)
        if not data:
            continue
        elements.append(Fig(f, data[0], data[1], floating=sits_on(f) and area(f) > 600))
    elements += background
    for b in P.rot_boxes:                                           # rotated text (a stamp, a margin label) stays a picture
        data = P.render_clip(pymupdf.Rect(b) + (-2, -2, 2, 2))
        if data:
            fig = Fig(b, data[0], data[1], floating=True)
            fig.overlay = True
            elements.append(fig)
    # rules
    rules = []
    for i, (o, pos, a, b, width, color, d) in enumerate(P.segments):
        if o == "h" and i not in P.used_segments and (b - a) >= 0.28 * P.w and width <= 4:
            rules.append(Rule((a, pos - width / 2, b, pos + width / 2), width, color))
    # assign lines, pictures, boxes to the smallest container that holds them
    containers = tbls + boxes
    def owner(bb):
        best = None
        for c in containers:
            if c.kind == "tbl":
                for cell in c.cells:
                    if inside(bb, cell["bbox"], 1.0):
                        return ("cell", c, cell)
            elif inside(bb, c.bbox, 1.0) and (best is None or area(c.bbox) < area(best[1].bbox)):
                best = ("box", c, None)
        return best
    top_items = []
    behind = [e.bbox for e in elements if e.kind == "img" and e.floating and not getattr(e, "overlay", False)]
    framed = [l for l in text_lines if any(overlap(l.bbox, b) >= 0.5 * area(l.bbox) for b in behind)]
    text_lines = [l for l in text_lines if l not in framed]
    pool = text_lines + elements + rules
    for it in pool:
        o = owner(it.bbox)
        if o is None:
            top_items.append(it)
        elif o[0] == "cell":
            o[2]["items"].append(it)
        else:
            o[1].children.append(it)
    # a box inside a box goes inside; a box inside a table cell goes in the cell
    for b in sorted(boxes + tbls, key=lambda b: area(b.bbox)):
        placed = False
        for c in containers:
            if c is b:
                continue
            if c.kind == "tbl":
                for cell in c.cells:
                    if inside(b.bbox, cell["bbox"], 1.0):
                        cell["items"].append(b)
                        placed = True
                        break
            elif c.kind == "box" and inside(b.bbox, c.bbox, 1.0) and area(c.bbox) > area(b.bbox) * 1.02:
                c.children.append(b)
                placed = True
            if placed:
                break
        if not placed:
            top_items.append(b)
    for c in boxes:
        c.children = [i for i in c.children if i is not c]

    flow = [i for i in top_items if not (i.kind == "img" and i.floating)]
    for i in top_items:
        if i.kind == "img" and i.floating:
            P.floaters.append(i)
    # rotated text: a text box, rotated
    B = Builder(out, P, meter, lists)
    if flow:
        x0 = min(i.x0 for i in flow)
        x1 = max(i.x1 for i in flow)
    else:
        x0, x1 = 0.0, P.w
    B.page_x1 = x1
    B.slack = max(0.0, min(10.0, P.w - x1 - 0.5))
    xml, cursor = B.emit(flow, x0, x1, None)
    if framed:
        xml += B.frames(framed)
    if os.environ.get("POMELO_DEBUG"):
        lost = [l for l in P.upright if not l.absorbed and id(l) not in B.emitted]
        if lost:
            sys.stderr.write("page %d: %d lines never written: %s\n" % (pno + 1, len(lost), " | ".join(l.text for l in lost)[:300]))
    top_margin = max(0.0, B.first_top if B.first_top is not None else 0.0)
    room = P.h - (cursor if cursor is not None else top_margin)
    bottom_margin = 0.0 if room < 70 else min(room - 14, 30.0)
    # the closing paragraph carries the floating pictures and ends the section
    floats = ""
    for it in sorted(P.floaters, key=lambda i: -area(i.bbox)):
        floats += B.picture_xml(it, floating=True, name="Picture")
    inner = (f'<w:type w:val="nextPage"/><w:pgSz w:w="{tw(P.w)}" w:h="{tw(P.h)}"/>'
             f'<w:pgMar w:top="{tw(top_margin)}" w:right="{tw(max(0.0, P.w - x1 - B.slack))}" w:bottom="{tw(bottom_margin)}" w:left="{tw(x0)}" w:header="0" w:footer="0" w:gutter="0"/>')
    sect = f'<w:sectPr {nsdecls("w")}>{inner}</w:sectPr>'
    mark = '<w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/></w:rPr>'
    if pno < n_pages - 1:
        closing = f'<w:p><w:pPr>{mark}<w:sectPr>{inner}</w:sectPr></w:pPr>{floats}</w:p>'
    else:
        closing = f'<w:p><w:pPr>{mark}</w:pPr>{floats}</w:p>'
    return xml + closing, sect



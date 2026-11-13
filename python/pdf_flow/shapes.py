# SPDX-License-Identifier: AGPL-3.0-or-later
"""The things on a page that are not text: pictures, rules, shaded boxes, tables and figures, and the drawings they come from."""

from collections import Counter

from pdf_spans import hexcolor

from .common import is_white, rgb_hex, tw
from .lines import is_bold

SIDES = ("top", "left", "bottom", "right")


class Img:
    kind = "img"

    def __init__(self, bbox, data, ext, floating=False, crop=None, ellipse=False, order=0):
        self.x0, self.y0, self.x1, self.y1 = bbox
        self.data, self.ext, self.floating = data, ext, floating
        self.crop, self.ellipse = crop, ellipse       # crop: fractions of the picture cut off at the left, top, right and bottom
        self.order = order                            # the picture's place in the PDF's painting order

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
        self.edges = {}               # a side that is a bar drawn along it, as a border: {side: (width, hex)}
        self.radius = 0

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

    @property
    def seq(self):
        return min((l.seq for c in self.cells for l in c["items"] if l.kind == "line"), default=0)


def rule_key(b):
    return (round(b[0] * 8), b[1]) if b else None


def traits(c):
    spans = [s for i in c["items"] if i.kind == "line" for s in i.spans if s["text"].strip()]
    colors = {hexcolor(s["color"]) for s in spans}
    return c["fill"], colors.pop() if len(colors) == 1 else None, bool(spans) and all(is_bold(s) for s in spans), bool(spans)


def region(cells, rest):
    """(fill, colour, bold) that all of the cells share and the rest of the table does not usually have; None when there is no such look."""
    out = []
    for i in range(3):
        mine = Counter(traits(c)[i] for c in cells if i == 0 or traits(c)[3])
        usual = Counter(traits(c)[i] for c in rest if i == 0 or traits(c)[3]).most_common(1)
        v = next(iter(mine)) if len(mine) == 1 else None
        out.append(v if v and (not usual or v != usual[0][0]) else None)
    return tuple(out) if any(out) else None


def table_look(t):
    """What the cells of a table share, so that a Word table style can give it and the cells need not repeat it: (rule as `rule_key`, cell padding in twips, header row,
    stripes, first column), each None where the table has none; a header and a first column are (fill, colour, bold)."""
    cells = t.cells
    nrow = max(c["r1"] for c in cells)
    count = Counter(rule_key(c["borders"].get(s)) for c in cells for s in SIDES)
    top = [(k, n) for k, n in count.most_common() if k]
    rule = top[0][0] if top and top[0][1] >= 0.6 * 4 * len(cells) else None
    gaps = [min(i.x0 for i in lines) - c["bbox"][0] for c in cells for lines in [[i for i in c["items"] if i.kind == "line"]] if lines]
    pad = tw(round(min(14.0, max(0.0, min(gaps))) * 2) / 2) if gaps else 0
    head = region([c for c in cells if c["r0"] == 0], [c for c in cells if c["r0"] > 0]) if nrow >= 2 else None
    body = [c for c in cells if c["r0"] >= (1 if head else 0)]
    first = region([c for c in body if c["c0"] == 0], [c for c in body if c["c0"] > 0])
    rows = sorted({c["r0"] for c in body})
    fills = []
    for r in rows:
        seen = {c["fill"] for c in body if c["r0"] == r}
        fills.append(next(iter(seen)) if len(seen) == 1 else "?")
    full = rows == list(range(1 if head else 0, nrow)) and "?" not in fills
    stripes = (fills[0], fills[1]) if full and len(fills) >= 3 and len(set(fills[0::2])) == 1 and len(set(fills[1::2])) == 1 and fills[0] != fills[1] else None
    return rule, pad, head, stripes, first


class Fig:
    kind = "img"

    def __init__(self, bbox, data, ext, floating=False):
        self.x0, self.y0, self.x1, self.y1 = bbox
        self.data, self.ext, self.floating = data, ext, floating

    @property
    def bbox(self):
        return (self.x0, self.y0, self.x1, self.y1)


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


def corner_radius(items):
    """The corner radius of a rounded rectangle path in points, 0 for anything else: four curves, one at each corner, each a quarter of a circle."""
    curves = [it for it in items if it[0] == "c"]
    if len(curves) != 4:
        return 0.0
    return min(max(abs(c[4].x - c[1].x), abs(c[4].y - c[1].y)) for c in curves)


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

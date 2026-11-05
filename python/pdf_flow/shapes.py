# SPDX-License-Identifier: AGPL-3.0-or-later
"""The things on a page that are not text: pictures, rules, shaded boxes, tables and figures, and the drawings they come from."""

from .common import is_white, rgb_hex


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

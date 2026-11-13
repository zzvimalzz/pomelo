# SPDX-License-Identifier: AGPL-3.0-or-later
"""One page: its lines, shapes and pictures, and the runs and paragraphs written from them."""

import math
from collections import Counter

from docx.opc.constants import RELATIONSHIP_TYPE
import pymupdf

from pdf_fonts import latin
from pdf_spans import RTL, dedupe, hexcolor

from .common import HI_DPI, area, cluster, esc, inside, is_white, nearest, overlap, rgb_hex, tw
from .lines import attach_markers, hangs, is_bold, is_italic, merge_rows, read_lines, split_marker
from .shapes import Box, Tbl, corner_radius, polygon_area, rect_shapes, segments_of


class Page:
    def __init__(self, doc, work_all, work_keep, page, pno, meter, body):
        self.doc, self.page, self.pno, self.meter, self.body = doc, page, pno, meter, body
        self.w, self.h = page.rect.width, page.rect.height
        self.work_all, self.work_keep = work_all, work_keep
        self.floaters = []                # Img/Fig objects drawn behind the text, anchored to the page
        self.textboxes = []               # rotated lines
        self.used_segments = set()
        self.xml_id = 0
        self.ground_pix = None

    # -- reading
    def read(self):
        page = self.page
        self.meter.register(page)
        links = [(pymupdf.Rect(l["from"]), l["uri"]) for l in page.get_links() if l.get("uri")]
        try:
            self.drawings = page.get_drawings()
        except Exception:
            self.drawings = []
        self.segments = segments_of(self.drawings)
        faint = []
        self.shapes = rect_shapes(self.drawings, faint)
        self.blend(faint, page)
        self.radii = {tuple(round(v) for v in d["rect"]): corner_radius(d["items"]) for d in self.drawings if "c" in {it[0] for it in d["items"]}}
        scan = any(area(tuple(i["bbox"])) > 0.85 * self.w * self.h for i in page.get_image_info())     # the invisible text layer of a scan is not hidden text
        lines = read_lines(page, hidden_ok=not scan)
        if not scan:
            self.hide(lines)
            lines = [l for l in lines if any(s["text"].strip() for s in l.spans)]
        self.hidden_lines = [l for l in lines if not any(s["text"].strip() and not s.get("hidden") for s in l.spans)]
        gone = {id(l) for l in self.hidden_lines}
        lines = dedupe([l for l in lines if id(l) not in gone], 3)
        self.upright = attach_markers(merge_rows([l for l in lines if not l.rot], self.shapes))
        self.rotated = [l for l in lines if l.rot]
        for l in self.upright:
            if hangs(l, self.upright):
                split_marker(l, self.body)
        self.links = links

    def blend(self, faint, page):
        """A translucent fill is the colour it makes with what is under it when that is flat (paper or a flat colour round the shape), because Word's shading has no
        transparency. Under a picture or a gradient it stays in the picture. Below a quarter it is a shadow or a glow, which stays in the picture too."""
        images = [tuple(i["bbox"]) for i in page.get_image_info()]
        for index, fill, opacity in faint:
            r, _, border, dashed = self.shapes[index]
            if opacity < 0.25 or any(overlap(tuple(r), ib) >= 0.5 * area(tuple(r)) for ib in images):
                continue
            ground = ground_colour(self.render72(), pymupdf.Rect(r))
            if ground:
                rgb = [int(fill[i:i + 2], 16) for i in (0, 2, 4)]
                self.shapes[index] = (r, "%02X%02X%02X" % tuple(round(opacity * c + (1 - opacity) * g) for c, g in zip(rgb, ground)), border, dashed)
        self.shapes = [sh for sh in self.shapes if sh[1] or sh[2]]

    def render72(self):
        if self.ground_pix is None:
            self.ground_pix = self.page.get_pixmap(dpi=72, alpha=False)
        return self.ground_pix

    def hide(self, lines):
        """Marks `hidden` on the spans the PDF does not show, which Word then keeps as hidden text: drawn in the invisible render mode, under an opaque rectangle drawn
        after them, or in the colour of the flat ground under them."""
        try:
            trace = self.page.get_texttrace()
        except Exception:
            trace = []
        starts = {}
        for t in trace:
            if t.get("chars"):
                o = t["chars"][0][2]
                starts.setdefault(round(o[1]), []).append((o[0], t["seqno"], t["type"], pymupdf.Rect(t["bbox"])))
        covers = {}
        for d in self.drawings:
            f, r = d.get("fill"), d["rect"]
            opacity = d.get("fill_opacity") if d.get("fill_opacity") is not None else 1
            if f and "f" in d["type"] and opacity >= 0.85 and "seqno" in d and r.width * r.height >= 16 and {it[0] for it in d["items"]} <= {"re", "qu"}:
                for cy in range(int(r.y0 // 32), int(r.y1 // 32) + 1):
                    for cx in range(int(r.x0 // 32), int(r.x1 // 32) + 1):
                        covers.setdefault((cx, cy), []).append((d["seqno"], tuple(r)))
        maybe = []
        for l in lines:
            for s in l.spans:
                if not s["text"].strip():
                    continue
                oy = round(s["origin"][1])
                near = [e for k in (oy - 1, oy, oy + 1) for e in starts.get(k, ()) if s["bbox"][0] - 1 <= e[0] <= s["bbox"][2] + 1]
                box = pymupdf.Rect(s["bbox"])
                for e in near:
                    box = pymupdf.Rect(e[3]) if e is near[0] else box | e[3]
                if s.get("alpha", 255) == 0:
                    if near:
                        s["hidden"] = True
                    else:
                        s["clip"] = True                                  # clip render modes are not in the text trace and paint nothing: the picture shows through the letters, so they stay in the picture
                elif near and area(tuple(box)) > 0 and any(sq > max(e[1] for e in near) and overlap(tuple(box), r) >= 0.9 * area(tuple(box))
                                  for sq, r in covers.get((int((box.x0 + box.x1) // 64), int((box.y0 + box.y1) // 64)), ())):
                    s["hidden"] = True
                elif not l.rot and not any(e[2] != 0 for e in near):          # outlined letters show whatever their fill is
                    if same_colour(ground_colour(self.render72(), box), s["color"]):
                        maybe.append((s, box))
        for l in lines:
            l.spans = [s for s in l.spans if not s.get("clip")]
        if maybe:
            # the same colour all round is only a hint (white text on a snug dark label has white paper round it): what counts is the ground under the text
            for s, box in maybe:
                self.work_all.add_redact_annot(pymupdf.Rect(box.x0, box.y0 + 0.18 * box.height, box.x1, box.y1 - 0.18 * box.height), fill=False)
            self.work_all.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE, graphics=pymupdf.PDF_REDACT_LINE_ART_NONE, text=pymupdf.PDF_REDACT_TEXT_REMOVE)
            for s, box in maybe:
                under = self.work_all.get_pixmap(dpi=72, clip=box, alpha=False)
                seen = [under.pixel(x, y) for x in range(under.width) for y in range(under.height)]
                s["hidden"] = same_colour(flat_colour(seen), s["color"])

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
                cells = [c for c in t.cells if c and c[2] - c[0] >= 8 and c[3] - c[1] >= 8]   # a cell drawn as an outer colour with an inset tint leaves thin strips between the two: they are no cells
            except Exception:
                continue
            if len(cells) < 2:
                continue
            xs = cluster([c[0] for c in cells] + [c[2] for c in cells])
            ys = cluster([c[1] for c in cells] + [c[3] for c in cells])
            if len(xs) >= 2 and len(ys) >= 2:
                xs, ys = self.rule_edges(xs, "v", (xs[0], ys[0], xs[-1], ys[-1])), self.rule_edges(ys, "h", (xs[0], ys[0], xs[-1], ys[-1]))
            if len(xs) < 3 and len(ys) < 3 or len(xs) < 2 or len(ys) < 2:
                continue
            if len(xs) == 2 and len(ys) == 2:
                continue
            empty = sum(1 for c in cells if not self.page.get_text("text", clip=pymupdf.Rect(c)).strip())
            if len(ys) - 1 >= 6 and empty > 0.4 * len(cells):
                continue                                   # a grid read into unrelated parts of the page, not a table
            grid = []
            for c in cells:
                c0, c1, r0, r1 = nearest(xs, c[0]), nearest(xs, c[2]), nearest(ys, c[1]), nearest(ys, c[3])
                grid.append(dict(c0=c0, c1=c1, r0=r0, r1=r1, bbox=(xs[c0], ys[r0], xs[c1], ys[r1]), raw=tuple(c), items=[], fill=None, borders={}))
            bbox = (min(xs), min(ys), max(xs), max(ys))
            if area(bbox) > 0.92 * self.w * self.h:
                continue
            cells_ok = [g for g in grid if g["c1"] > g["c0"] and g["r1"] > g["r0"]]
            span = lambda g: (g["c0"], g["c1"], g["r0"], g["r1"])
            cells_ok = [g for g in cells_ok if not any(span(o) != span(g) and g["c0"] <= o["c0"] and o["c1"] <= g["c1"] and g["r0"] <= o["r0"] and o["r1"] <= g["r1"] for o in cells_ok)]    # a cell drawn twice, as one tall cell and as the shorter cells inside it, is the shorter ones
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
            in_table = lambda r: r[0] >= t.x0 - 2 and r[1] >= t.y0 - 2 and r[2] <= t.x1 + 2 and r[3] <= t.y1 + 2
            for c in t.cells:
                b = c["bbox"]
                best, f0 = None, c["raw"]                       # the fill is looked for under the cell as the finder drew it: the edges moved onto the rules can lie further out than the fill
                for r, fill, border, dashed in self.shapes:     # drawn in order, so the last one that covers the cell is the one on top; one rectangle may span a row, a column or the table
                    if fill and overlap(f0, tuple(r)) >= 0.8 * area(f0) and in_table(r):
                        best = fill
                if best is None:
                    # a fill rectangle drawn as a thin-bordered one is already in shapes; also try the raw drawings
                    for d in self.drawings:
                        f = d.get("fill")
                        if f and not is_white(f) and (d.get("fill_opacity") if d.get("fill_opacity") is not None else 1) >= 0.85 and overlap(f0, tuple(d["rect"])) >= 0.85 * area(f0) and in_table(tuple(d["rect"])):
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

    def rule_edges(self, edges, o, box):
        """Cell edges moved onto the rules drawn within 8 pt of them. Word draws a shaded cell as a fill the size of the cell and another inset by the cell's padding, so the
        fills alone give a column on each side of every rule; edges that end up closer than 3 pt are one, and a column narrower than 12 pt with no text in it is not a column."""
        x0, y0, x1, y1 = box
        lo, hi, a0, a1 = (x0, x1, y0, y1) if o == "v" else (y0, y1, x0, x1)
        rules = cluster([pos for so, pos, a, b, w, color, d in self.segments if so == o and lo - 2 <= pos <= hi + 2 and b - a >= 8 and min(b, a1) - max(a, a0) >= 8], 1.0)
        out = cluster([min((r for r in rules if abs(r - e) <= 8), key=lambda r: abs(r - e), default=e) for e in edges], 3.0)
        if o == "h":
            return out
        texts = [(l.x0 + l.x1) / 2 for l in self.upright if y0 <= l.y0 and l.y1 <= y1]
        kept = out[:1]
        for e in out[1:]:
            if e - kept[-1] >= 12 or any(kept[-1] <= t <= e for t in texts):
                kept.append(e)
            elif e is out[-1]:
                kept[-1] = e
        return kept

    def aligned_tables(self):
        """Tables drawn with no grid: three or more rows of text that stand at the same left edges and that the PDF wrote as one block."""
        grid = [t.bbox for t in self.tbls]
        blocks = {}
        for l in self.upright:
            if l.block is not None and not l.marker and not any(inside(l.bbox, g, 1.0) for g in grid):
                blocks.setdefault(l.block, []).append(l)
        return [t for lines in blocks.values() for t in self.table_runs(sorted(lines, key=lambda l: (l.base, l.x0)))]

    def table_runs(self, lines):
        columns = [x for x in cluster([l.x0 for l in lines], 2.0) if sum(abs(l.x0 - x) <= 2.0 for l in lines) >= 3]
        col = lambda l: next((i for i, x in enumerate(columns) if abs(l.x0 - x) <= 2.0), None)
        others = [o for o in self.upright if o not in lines]
        rows = []
        for l in lines:
            if rows and abs(rows[-1][0].base - l.base) <= 0.3 * min(rows[-1][0].size, l.size):
                rows[-1].append(l)
            else:
                rows.append([l])
        runs, run = [], []
        for r in rows:
            r.sort(key=lambda l: l.x0)
            if len(r) >= 2 and all(col(l) is not None for l in r) and all(b.x0 - a.x1 > 2 for a, b in zip(r, r[1:])):
                if run and r[0].y0 - max(l.y1 for l in run[-1]) > 0.7 * r[0].size:
                    runs.append(run)
                    run = []
                run.append(r)
            elif (run and len(r) == 1 and col(r[0]) and r[0].y0 - max(l.y1 for l in run[-1]) <= 0.4 * r[0].size
                  and not any(o.x1 < r[0].x0 and abs(o.base - r[0].base) <= 0.3 * r[0].size for o in others)):
                run[-1].append(r[0])                              # the second line of a cell
            else:
                runs.append(run)
                run = []
        runs.append(run)
        tables = []
        while runs:
            run = runs.pop()
            used = sorted({col(l) for r in run for l in r})
            if len(run) < 3 or len(used) < 2:
                continue
            xs = [columns[i] for i in used]
            over = next((i for i, r in enumerate(run) if any(k + 1 < len(used) and l.x1 > xs[k + 1] + 1 for l in r for k in [used.index(col(l))])), None)
            if over is not None:                                  # a line that runs into the next column cannot be a cell of this table
                runs += [run[:over], run[over + 1:]]
                continue
            end = max(l.x1 for r in run for l in r if col(l) == used[-1])
            edges = xs + [min(self.w - 2, end + 0.1 * (end - xs[-1]) + 4.0)]               # a stand-in font wider than the PDF's must not wrap the last column
            bases = [r[0].base for r in run]
            pitch = [b - a for a, b in zip(bases, bases[1:])]
            pitch.append(pitch[-1])
            line = min(pitch)
            ys = [min(l.base - line - l.desc * l.size for l in r if abs(l.base - r[0].base) <= 0.3 * l.size) for r in run]
            ys.append(ys[-1] + pitch[-1])
            cells = [dict(c0=k, c1=k + 1, r0=i, r1=i + 1, bbox=(edges[k], ys[i], edges[k + 1], ys[i + 1]), items=[l for l in r if col(l) == c], fill=None, borders={})
                     for i, r in enumerate(run) for k, c in enumerate(used)]
            tables.append(Tbl((edges[0], ys[0], edges[-1], ys[-1]), edges, ys, cells))
        return tables

    def table_art(self, t):
        """The drawings that a Word table paints for itself (its rules and cell colours), or None when they cannot be taken out of the page picture: a picture or
        figure under the table, a shape that runs out of it, or a colour the table does not paint. A shape that holds the whole table, such as a panel or the colour of
        the page, is not part of the table and stays."""
        if any(overlap(r, t.bbox) > 0 for r in [r for r, _ in self.imgs] + self.figs):
            return None
        painted = {c["fill"] for c in t.cells} | {color for c in t.cells for _, color in c["borders"].values()}
        art = []
        for d in self.drawings:
            r = tuple(d["rect"])
            if overlap(r, t.bbox) <= 0 or (r[0] <= t.x0 + 2 and r[1] <= t.y0 + 2 and r[2] >= t.x1 - 2 and r[3] >= t.y1 - 2):
                continue
            shown = {rgb_hex(d[k]) for k, kind in (("fill", "f"), ("color", "s")) if kind in d["type"] and d.get(k)}
            if not (r[0] >= t.x0 - 2 and r[1] >= t.y0 - 2 and r[2] <= t.x1 + 2 and r[3] <= t.y1 + 2) or not shown <= painted or not {it[0] for it in d["items"]} <= {"re", "l", "qu"}:
                return None
            art.append(r)
        return art

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
                cands[-1].radius = self.radii.get(tuple(round(v) for v in rr), 0.0)
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
        self.edge_bars()

    def edge_bars(self):
        """A filled bar at most 6 pt thick along the whole of one edge of a box, such as the coloured side of a callout, is that side's border."""
        self.bar_rects = []
        for d in self.drawings:
            f, r = d.get("fill"), d["rect"]
            opacity = d.get("fill_opacity") if d.get("fill_opacity") is not None else 1
            if not f or is_white(f) or "f" not in d["type"] or opacity < 0.85 or [it[0] for it in d["items"]] != ["re"]:
                continue
            thick = min(r.width, r.height)
            if not 0.5 <= thick <= 6 or max(r.width, r.height) < 14:
                continue
            for bx in self.box_items:
                sides = (("left", r.width <= 6 and abs(r.x0 - bx.x0) <= 1, (r.y0 - bx.y0, r.y1 - bx.y1)), ("right", r.width <= 6 and abs(r.x1 - bx.x1) <= 1, (r.y0 - bx.y0, r.y1 - bx.y1)),
                         ("top", r.height <= 6 and abs(r.y0 - bx.y0) <= 1, (r.x0 - bx.x0, r.x1 - bx.x1)), ("bottom", r.height <= 6 and abs(r.y1 - bx.y1) <= 1, (r.x0 - bx.x0, r.x1 - bx.x1)))
                side = next((s for s, flush, ends in sides if flush and max(abs(v) for v in ends) <= 1.5 and s not in bx.edges), None)
                if side:
                    bx.edges[side] = (thick, rgb_hex(f))
                    self.bar_rects.append(tuple(r))
                    break

    # -- pictures and what is left of the page when the text is taken away
    def ellipse_clips(self):
        out = []
        for d in self.page.get_drawings(extended=True):
            items = d.get("items") or []
            if d["type"] != "clip" or not d.get("scissor") or sum(it[0] == "c" for it in items) < 4:
                continue
            r = pymupdf.Rect(d["scissor"])
            if r.width >= 8 and r.height >= 8 and polygon_area(items) <= 0.83 * r.width * r.height:
                out.append(tuple(r))
        return out

    def pictures(self, ocr_scan=False):
        self.imgs = []
        page = self.page
        infos = page.get_image_info(xrefs=True)
        ellipses = self.ellipse_clips() if infos else []
        uses = Counter(i.get("xref") for i in infos)
        # a picture clipped by the page (a photo cropped to a panel or a circle) shows less than its own rectangle: the text layer reports the shown part
        visible = {b["number"]: tuple(b["bbox"]) for b in page.get_text("dict")["blocks"] if b["type"] == 1} if infos else {}
        over = self.overdrawn()
        covered = []
        for info in infos:
            r = tuple(info["bbox"])
            if area(r) < 20 or (r[2] - r[0]) < 3 or (r[3] - r[1]) < 3:
                continue
            if tuple(round(v) for v in r) in over:
                info = dict(info, overdrawn=True)
            tf = info.get("transform")
            if tf and (abs(tf[1]) > 0.05 or abs(tf[2]) > 0.05):
                continue                                              # rotated picture: left to the leftovers pass
            if r[2] - r[0] > 0.92 * self.w and r[3] - r[1] > 0.92 * self.h and ocr_scan:
                covered.append(r)
                continue
            shown = visible.get(info.get("number"))
            if shown and area(shown) >= 0.15 * area(r) and (shown[0] - r[0] > 1.5 or shown[1] - r[1] > 1.5 or r[2] - shown[2] > 1.5 or r[3] - shown[3] > 1.5):
                round_ = any(all(abs(a - b) <= 1.5 for a, b in zip(c, shown)) for c in ellipses)
                info = dict(info, full=r, ellipse=round_, unique=uses[info.get("xref")] == 1)
                r = shown
            self.imgs.append((r, info))
            covered.append(info.get("full", r))
        self.picture_boxes = covered

    def overdrawn(self):
        """The pictures (by their rounded box) that a filled shape is drawn over later, such as a caption band. Such a picture is cut from the page, because the file's own copy has no band."""
        try:
            log = self.page.get_bboxlog()
        except Exception:
            return set()
        out = set()
        for k, (kind, bb) in enumerate(log):
            if kind != "fill-image":
                continue
            if any(t == "fill-path" and area(tuple(b)) >= 100 and area(tuple(b)) < 0.9 * area(tuple(bb)) and overlap(tuple(b), tuple(bb)) >= 0.8 * area(tuple(b)) for t, b in log[k + 1:]):
                out.add(tuple(round(v) for v in bb))
        return out

    def encode_image(self, info, r, dpi_cap=300):
        xref = info.get("xref")
        if xref and not info.get("overdrawn"):
            try:
                raw = self.doc.extract_image(xref)
                if raw and raw.get("ext") in ("jpeg", "jpg") and not raw.get("smask") and raw.get("colorspace", 3) in (1, 3) and raw.get("cs-name", "") != "DeviceCMYK":
                    data = raw["image"]
                    if data[:4] not in (bytes.fromhex("ffd8ffe0"), bytes.fromhex("ffd8ffe1")):      # python-docx wants a JFIF or Exif marker first
                        data = data[:2] + bytes.fromhex("ffe000104a46494600010100000100010000") + data[2:]
                    if info.get("full"):
                        f = info["full"]
                        info["crop"] = tuple(max(0.0, v) for v in ((r[0] - f[0]) / (f[2] - f[0]), (r[1] - f[1]) / (f[3] - f[1]), (f[2] - r[2]) / (f[2] - f[0]), (f[3] - r[3]) / (f[3] - f[1])))
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

        def blended(p, a, b):
            d = [y - x for x, y in zip(a, b)]
            k = max(range(3), key=lambda i: abs(d[i]))
            if abs(d[k]) < 24:
                return False
            t = (p[k] - a[k]) / d[k]
            return -0.05 <= t <= 1.05 and all(abs(p[i] - (a[i] + t * d[i])) < 12 for i in range(3))

        def blank(b, pad=1.2, colors=None, edges=()):
            """Clears the pixels of colour `colors` in the box, and those that blend it into one of `edges` (the soft edge where it meets paper or another colour)."""
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
                            if abs(s[j] - colors[0]) < 10 and abs(s[j + 1] - colors[1]) < 10 and abs(s[j + 2] - colors[2]) < 10 or any(blended(s[j:j + 3], colors, e) for e in edges):
                                mask[row + x] = 0

        for t in self.tbls:
            fills = {c["fill"] for c in t.cells if c["fill"]}
            rgbs = lambda f: tuple(int(f[i:i + 2], 16) for i in (0, 2, 4))
            for c in t.cells:
                if c["fill"]:
                    blank(c["bbox"], 0.5, colors=rgbs(c["fill"]), edges=[(255, 255, 255)] + [rgbs(f) for f in fills if f != c["fill"]])
        for bx in self.box_items:
            if bx.fill:
                col = tuple(int(bx.fill[i:i + 2], 16) for i in (0, 2, 4))
                blank(bx.bbox, 0.5, colors=col, edges=[(255, 255, 255)])
            if bx.border:
                bw = bx.border[0] + 1.5
                blank((bx.x0, bx.y0, bx.x1, bx.y0 + bw), 1.5)
                blank((bx.x0, bx.y1 - bw, bx.x1, bx.y1), 1.5)
                blank((bx.x0, bx.y0, bx.x0 + bw, bx.y1), 1.5)
                blank((bx.x1 - bw, bx.y0, bx.x1, bx.y1), 1.5)
        for r, fill, border, dashed in self.highlight_shapes:
            blank(tuple(r), 1.0)
        for r in self.bar_rects:
            blank(r, 1.0)
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


def page_kind(P):
    """("design" or "document", why). A design page (a slide, a menu, a brochure, a cheat sheet) has pictures or colour over
    much of the sheet, a coloured background, a colour panel or several sections of text of its own, or many short pieces
    of text scattered among pictures or boxes outside a table; everything else is a document page."""
    if not P.upright:
        return "document", "no text to place"
    cell = 8.0
    cols, rows = int(P.w // cell) + 1, int(P.h // cell) + 1
    covered = bytearray(cols * rows)
    rects = [r for r, _ in P.imgs] + [f for f in P.figs if not any(inside(f, t.bbox, 0) for t in P.tbls)] + [b.bbox for b in P.box_items if b.fill] + [bb for bb, _ in P.page_fills]
    for r in rects:
        for y in range(max(0, int(r[1] // cell)), min(rows, int(r[3] // cell) + 1)):
            for x in range(max(0, int(r[0] // cell)), min(cols, int(r[2] // cell) + 1)):
                covered[y * cols + x] = 1
    share = sum(covered) / len(covered)
    if P.page_fills:
        return "design", "a coloured background"
    if share > 0.4:
        return "design", "pictures and colour cover %d%% of the sheet" % round(share * 100)
    held = [(b, sum(1 for l in P.upright if inside(l.bbox, b.bbox))) for b in P.box_items]
    for b, n in held:
        if b.fill and n >= 8 and area(b.bbox) >= 0.15 * P.w * P.h:
            return "design", "a colour panel holding %d lines" % n
    sections = [n for b, n in held if n >= 8]
    if len(sections) >= 2:
        return "design", "%d boxes holding text of their own" % len(sections)
    loose = [l for l in P.upright if not any(inside(l.bbox, t.bbox, 0.5) for t in P.tbls)]
    short = [l for l in loose if len(l.text.strip()) <= 25]
    drawn = P.imgs or P.figs or P.box_items
    if drawn and not P.tbls and len(loose) >= 15 and len(short) >= 0.6 * len(loose) and len(cluster([l.x0 for l in loose], 6)) >= 6:
        return "design", "%d short pieces of text at %d left edges" % (len(short), len(cluster([l.x0 for l in loose], 6)))
    return "document", "pictures and colour cover %d%% of the sheet" % round(share * 100)


def flat_colour(seen):
    """The median of the colours when most of them are within a small distance of it; None when the ground is not flat."""
    if len(seen) < 8:
        return None
    mid = tuple(sorted(c[i] for c in seen)[len(seen) // 2] for i in range(3))
    flat = sum(abs(c[0] - mid[0]) + abs(c[1] - mid[1]) + abs(c[2] - mid[2]) <= 30 for c in seen)
    return mid if flat >= 0.7 * len(seen) else None


def ground_colour(pix, box):
    """The flat colour of the ring 2.5 pt outside `box` in a 72 dpi render, or None."""
    x0, y0, x1, y1 = box.x0 - 2.5, box.y0 - 2.5, box.x1 + 2.5, box.y1 + 2.5
    xs = [x0 + 4 * i for i in range(int((x1 - x0) / 4) + 1)]
    ys = [y0 + 4 * i for i in range(int((y1 - y0) / 4) + 1)]
    ring = [(x, y) for x in xs for y in (y0, y1)] + [(x, y) for y in ys for x in (x0, x1)]
    return flat_colour([pix.pixel(int(x), int(y)) for x, y in ring if 0 <= x < pix.width and 0 <= y < pix.height])


def same_colour(ground, color):
    """True when the colour integer of a span is the colour of the ground (r, g, b) to within a few levels a channel: text a little darker than its ground is faint, not hidden."""
    return bool(ground) and abs(ground[0] - (color >> 16 & 255)) + abs(ground[1] - (color >> 8 & 255)) + abs(ground[2] - (color & 255)) <= 15


def span_run(page, s, justified, meter, gap=None, last=False):
    """One <w:r>, or two when the line ends here against the cell's edge and the last letter must leave the letter spacing. `gap`: room between the line and the right edge of its cell, None outside a cell."""
    font = esc(meter.family(s))
    size = s["size"]
    half = max(2, round(size * 2))
    rpr = f'<w:rFonts w:ascii="{font}" w:hAnsi="{font}" w:eastAsia="{font}" w:cs="{font}"/>' if font != meter.base[0] else ""
    by_color, by_bold = s.get("by_style", (False, False))             # what the table's style gives a header or first column cell, so the run does not state it
    if is_bold(s) and not by_bold:
        rpr += "<w:b/><w:bCs/>"
    if is_italic(s):
        rpr += "<w:i/><w:iCs/>"
    if s.get("st"):
        rpr += "<w:strike/>"
    if s.get("hidden"):
        rpr += "<w:vanish/>"
    if not by_color:
        rpr += f'<w:color w:val="{hexcolor(s["color"])}"/>'
    text = s["text"]
    spacing = 0
    whole = s.get("whole") or s                                    # a span cut at its page numbers keeps the spacing of the whole
    src = whole["text"]
    if len(src) >= 3:
        nat = meter.width(whole, src, size)
        w = whole["bbox"][2] - whole["bbox"][0]
        if nat:
            extra = (w - nat) / max(1, len(src) - 1)
            if not justified and 0.35 < extra < 14 and src.count(" ") <= len(src) // 3:
                spacing = tw(extra)
            elif latin(src):
                shown = src.rstrip()
                tight = ((w - (meter.width(whole, shown, size) or w)) / max(1, len(shown) - 1))
                if tight <= -0.05:
                    spacing = tw(max(tight, -0.8))
    if gap is not None and gap < 1.5 and latin(text):
        spacing -= 1
    tracking = f'<w:spacing w:val="{spacing}"/>' if spacing else ""
    rpr += tracking + (f'<w:sz w:val="{half}"/><w:szCs w:val="{half}"/>' if half != meter.base[1] else "")
    if s.get("ul"):
        rpr += f'<w:u w:val="single" w:color="{s["ul"]}"/>'
    if s.get("hl"):
        rpr += f'<w:shd w:val="clear" w:color="auto" w:fill="{s["hl"]}"/>'
    if s["flags"] & 1 and size < 0.95 * (s.get("bsize") or size):
        rpr += '<w:vertAlign w:val="superscript"/>'
    if RTL.search(text):
        rpr += "<w:rtl/>"
    if 0 < s.get("alpha", 255) < 250:
        rpr += f'<w14:textFill><w14:solidFill><w14:srgbClr w14:val="{hexcolor(s["color"])}"><w14:alpha w14:val="{round((1 - s["alpha"] / 255) * 100000)}"/></w14:srgbClr></w14:solidFill></w14:textFill>'
    run = lambda props, t: f'<w:r><w:rPr>{props}</w:rPr><w:t xml:space="preserve">{esc(t)}</w:t></w:r>'
    if s.get("field"):                                             # a complex field: Word sets a simple field's result in the paragraph's size, not the run's
        mark = lambda kind: f'<w:r><w:rPr>{rpr}</w:rPr><w:fldChar w:fldCharType="{kind}"/></w:r>'
        return (mark("begin") + f'<w:r><w:rPr>{rpr}</w:rPr><w:instrText xml:space="preserve"> {s["field"]} </w:instrText></w:r>'
                + mark("separate") + run(rpr, text) + mark("end"))
    if last and gap is not None and spacing > 0 and gap < 1.5 + spacing / 20 and len(text) > 1 and text[-1] != " ":
        return run(rpr, text[:-1]) + run(rpr.replace(tracking, ""), text[-1])   # Word adds the letter spacing after the last letter too, which wraps a line that fills its cell
    return run(rpr, text)


def runs_xml(page, spans, justified, doc_part, meter, gap=None):
    xml = ""
    pending_link, buf = None, ""
    for s in spans:
        link = s.get("link")
        run = span_run(page, s, justified, meter, gap, s is spans[-1])
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
    def cap(self):
        return self.lines[0].cap

    @property
    def seq(self):
        return min(l.seq for l in self.lines)

    @property
    def x0(self):
        return min(l.x0 for l in self.lines)

    @property
    def x1(self):
        return max(l.x1 for l in self.lines)

    @property
    def y0(self):
        return min(l.y0 for l in self.lines)

    @property
    def y1(self):
        return max(l.y1 for l in self.lines)

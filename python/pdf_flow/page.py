# SPDX-License-Identifier: AGPL-3.0-or-later
"""One page: its lines, shapes and pictures, and the runs and paragraphs written from them."""

import math
from collections import Counter

from docx.opc.constants import RELATIONSHIP_TYPE
import pymupdf

from pdf_fonts import latin
from pdf_spans import RTL, dedupe, hexcolor

from .common import HI_DPI, area, cluster, esc, inside, is_white, nearest, overlap, rgb_hex, tw
from .lines import attach_markers, is_bold, is_italic, merge_rows, read_lines, split_marker
from .shapes import Box, Tbl, polygon_area, rect_shapes, segments_of


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
        try:
            self.drawings = page.get_drawings()
        except Exception:
            self.drawings = []
        self.segments = segments_of(self.drawings)
        self.shapes = rect_shapes(self.drawings)
        lines = dedupe(read_lines(page), 3)
        self.upright = attach_markers(merge_rows([l for l in lines if not l.rot], self.shapes))
        self.rotated = [l for l in lines if l.rot]
        for l in self.upright:
            split_marker(l, self.body)
        self.links = links

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
                        if f and not is_white(f) and (d.get("fill_opacity") if d.get("fill_opacity") is not None else 1) >= 0.85 and overlap(b, tuple(d["rect"])) >= 0.85 * area(b) and area(tuple(d["rect"])) <= 1.6 * area(b):
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
            shown = visible.get(info.get("number"))
            if shown and area(shown) >= 0.15 * area(r) and (shown[0] - r[0] > 1.5 or shown[1] - r[1] > 1.5 or r[2] - shown[2] > 1.5 or r[3] - shown[3] > 1.5):
                round_ = any(all(abs(a - b) <= 1.5 for a, b in zip(c, shown)) for c in ellipses)
                info = dict(info, full=r, ellipse=round_, unique=uses[info.get("xref")] == 1)
                r = shown
            self.imgs.append((r, info))
            covered.append(info.get("full", r))
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


def page_kind(P):
    """("design" or "document", why). A design page (a slide, a menu, a brochure) has pictures or colour over much of the
    sheet, a coloured background, or many short pieces of text scattered about; everything else is a document page."""
    cell = 8.0
    cols, rows = int(P.w // cell) + 1, int(P.h // cell) + 1
    covered = bytearray(cols * rows)
    rects = [r for r, _ in P.imgs] + list(P.figs) + [b.bbox for b in P.box_items if b.fill] + [bb for bb, _ in P.page_fills]
    for r in rects:
        for y in range(max(0, int(r[1] // cell)), min(rows, int(r[3] // cell) + 1)):
            for x in range(max(0, int(r[0] // cell)), min(cols, int(r[2] // cell) + 1)):
                covered[y * cols + x] = 1
    share = sum(covered) / len(covered)
    if P.page_fills:
        return "design", "a coloured background"
    if share > 0.4:
        return "design", "pictures and colour cover %d%% of the sheet" % round(share * 100)
    loose = [l for l in P.upright if not any(inside(l.bbox, t.bbox, 0.5) for t in P.tbls)]
    short = [l for l in loose if len(l.text.strip()) <= 25]
    if len(loose) >= 15 and len(short) >= 0.6 * len(loose) and len(cluster([l.x0 for l in loose], 6)) >= 6:
        return "design", "%d short pieces of text at %d left edges" % (len(short), len(cluster([l.x0 for l in loose], 6)))
    return "document", "pictures and colour cover %d%% of the sheet" % round(share * 100)


def span_run(page, s, justified, meter, edge=False):
    """One <w:r>."""
    font = esc(meter.family(s))
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
    spacing = 0
    if len(text) >= 3:
        nat = meter.width(s, text, size)
        w = s["bbox"][2] - s["bbox"][0]
        if nat:
            extra = (w - nat) / max(1, len(text) - 1)
            if not justified and 0.35 < extra < 14 and text.count(" ") <= len(text) // 3:
                spacing = tw(extra)
            elif latin(text):
                shown = text.rstrip()
                tight = ((w - (meter.width(s, shown, size) or w)) / max(1, len(shown) - 1))
                if tight <= -0.05:
                    spacing = tw(max(tight, -0.8))
    if edge and latin(text):
        spacing -= 1
    if spacing:
        rpr += f'<w:spacing w:val="{spacing}"/>'
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


def runs_xml(page, spans, justified, doc_part, meter, edge=False):
    xml = ""
    pending_link, buf = None, ""
    for s in spans:
        link = s.get("link")
        run = span_run(page, s, justified, meter, edge)
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

# SPDX-License-Identifier: AGPL-3.0-or-later
"""Laying out a region of a page as Word content: columns, bands, paragraphs, tables and pictures."""

import io
import os
import sys

from .common import cluster, tw
from .page import Para, runs_xml
from .shapes import Box, Tbl


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

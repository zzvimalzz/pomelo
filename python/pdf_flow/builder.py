# SPDX-License-Identifier: AGPL-3.0-or-later
"""Laying out a region of a page as Word content: columns, bands, paragraphs, tables and pictures."""

import io
import os
import re
import sys
from types import SimpleNamespace

from pdf_fonts import latin

from .common import cluster, inside, tw
from .lines import is_letter
from .page import Para, runs_xml
from .shapes import Box, Tbl

CAPTION = re.compile(r"(?:Figure|Fig\.?|Table|Chart|Exhibit|Diagram)\s+[A-Z]?\d+(?:\.\d+)*[a-z]?\s*[.:–—-]\s*\S")
NUMBERED = re.compile(r"\(\d{1,3}\)")
BREAK = '<w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/></w:rPr>'


class Builder:
    """Writes one page's body XML."""

    def __init__(self, doc, page_obj, meter, lists):
        self.doc, self.P, self.meter, self.lists = doc, page_obj, meter, lists
        self.first_top = None
        self.page_x1 = None
        self.slack = 0.0
        self.turn = 0
        self.placed = False               # text boxes at fixed places: a line ends where the PDF's does, unless the paragraph is justified
        self.depth = 0
        self.titled = False
        self.columns_ok = False           # running text in columns may be written as Word columns (the page is flowed, not placed or turned)
        self.cap = None                   # the height of the shortest row of the placed table being written: the font's own line height may be taller than the PDF's rows
        self.emitted = set()

    def room(self, x1):
        """The slack the page's right margin leaves to a paragraph that reaches the right edge; a table is only as wide as its columns, so a cell gets none."""
        return self.slack if not self.depth and self.page_x1 is not None and abs(x1 - self.page_x1) < 0.01 else 0.0

    def keep(self, height):
        """A row stays whole on a sheet unless it is tall: Word clips a row that cannot split and is taller than what is left of the sheet."""
        return "<w:cantSplit/>" if height < 0.5 * self.P.h else ""

    def in_cell(self, items, x0, x1, cursor):
        self.depth += 1
        try:
            return self.emit(items, x0, x1, cursor)
        finally:
            self.depth -= 1

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

    def column_runs(self, bands, x0, x1):
        """Runs of consecutive bands that are running text in two or three columns: [(first band, last band + 1, [(left, right) of each gutter])]. A line that is alone in
        its band belongs to the column it stands in."""
        info = []
        for _, _, its in bands:
            if not all(i.kind in ("line", "img", "tbl", "box") for i in its):
                info.append("x")
                continue
            cols = self.v_cut(self.numbered(its))
            info.append("s" if not cols else [(a[1], b[0]) for a, b in zip(cols, cols[1:])] if len(cols) <= 3 else "x")
        runs, k = [], 0
        while k < len(bands):
            if info[k] == "x":
                k += 1
                continue
            j, gaps = k, None
            while j < len(bands) and info[j] != "x":
                if isinstance(info[j], list):
                    gaps = info[j] if gaps is None else self.shared(gaps, info[j])
                    if gaps is None:
                        break
                j += 1
            runs += self.settle(bands, info, k, j, x0, x1)
            k = max(j, k + 1)
        return runs

    def numbered(self, its):
        """The items of a band with an equation number counted as part of the line it stands beside, so that the gap between them is not taken for a gutter."""
        for n in [l for l in its if l.kind == "line" and NUMBERED.fullmatch(l.text.strip())]:
            beside = [o for o in its if o.kind == "line" and o is not n and o.x1 <= n.x0 and abs(o.base - n.base) <= 0.3 * n.size]
            if beside:
                o = max(beside, key=lambda o: o.x1)
                joined = SimpleNamespace(kind="line", text=o.text, base=o.base, size=o.size, x0=o.x0, x1=n.x1, y0=min(o.y0, n.y0), y1=max(o.y1, n.y1))
                its = [joined if i is o else i for i in its if i is not n]
        return its

    def shared(self, a, b):
        """The gutters two bands have in common, or None when they do not line up."""
        if len(a) != len(b):
            return None
        out = [(max(p[0], q[0]), min(p[1], q[1])) for p, q in zip(a, b)]
        return out if all(r - l >= 3.0 for l, r in out) else None

    def settle(self, bands, info, k, j, x0, x1):
        """The runs inside bands k to j. A band that does not belong (a line across a gutter, a contents line with its page number) splits the run, and what is left must
        be columns of text: several lines in each, about as wide as each other, close together and filled by their lines."""
        gaps = None
        for m in range(k, j):
            if isinstance(info[m], list):
                gaps = info[m] if gaps is None else self.shared(gaps, info[m])
                if gaps is None:
                    return []
        if gaps is None:
            return []
        mids = [(a + b) / 2 for a, b in gaps]
        while k < j and not isinstance(info[k], list) and all((i.x0 + i.x1) / 2 < mids[0] for i in bands[k][2]):
            k += 1                                                   # a short line over the first column is the end of the paragraph above, not a column
        edges = [x0] + mids + [x1]
        wide = [b - a for a, b in zip(edges, edges[1:])]
        for m in range(k, j):
            if not self.belongs(bands[m][2], gaps, mids, edges, wide):
                return self.settle(bands, info, k, m, x0, x1) + self.settle(bands, info, m + 1, j, x0, x1)
        items = [i for b in bands[k:j] for i in b[2]]
        per = [[i for i in items if sum(1 for m in mids if (i.x0 + i.x1) / 2 > m) == n] for n in range(len(wide))]
        text = [[i for i in p if i.kind == "line"] for p in per]
        if not all(len(t) >= 5 for t in text):
            return []
        gaps = [(max(i.x1 for i in per[n]), min(i.x0 for i in per[n + 1])) for n in range(len(mids))]
        ok = (all(r - l >= 3.0 for l, r in gaps) and max(wide) <= 1.7 * min(wide) and max(r - l for l, r in gaps) <= 0.35 * min(wide)
              and all(max(l.x1 for l in t) - min(l.x0 for l in t) >= 0.7 * w for t, w in zip(text, wide)))
        return [(k, j, gaps)] if ok else []

    def belongs(self, its, gaps, mids, edges, wide):
        if any(l.x0 < m < l.x1 for l in its for m in mids):
            return False
        per = [[l for l in its if l.kind == "line" and sum(1 for m in mids if (l.x0 + l.x1) / 2 > m) == n] for n in range(len(wide))]
        if sum(1 for p in per if p) < 2:
            return True
        return all(min(l.x0 for l in p) - (gaps[n - 1][1] if n else edges[0]) <= 0.3 * wide[n]
                   or all(abs((l.x0 + l.x1) / 2 - (edges[n] + edges[n + 1]) / 2) <= 0.06 * wide[n] for l in p) for n, p in enumerate(per) if p)

    def with_columns(self, bands, runs, x0, x1, cursor):
        xml, at = "", 0
        for first, last, gaps in runs:
            before = [i for b in bands[at:first] for i in b[2]]
            if before:
                part, cursor = self.laid(before, x0, x1, cursor, False)
                xml += part
            part, cursor = self.columns([i for b in bands[first:last] for i in b[2]], gaps, x0, x1, cursor, bool(xml))
            xml += part
            at = last
        rest = [i for b in bands[at:] for i in b[2]]
        if rest:
            part, cursor = self.laid(rest, x0, x1, cursor, False)
            xml += part
        return xml, cursor

    def columns(self, items, gaps, x0, x1, cursor, lead):
        """Running text in columns as a continuous section with Word columns: the text of each column in turn, a column break where a column ends. The section's own
        properties are filled in once the page's margins are known, where the marks made of the control character \x01 stand (text can never hold one)."""
        P = self.P
        mids = [(a + b) / 2 for a, b in gaps]
        n = len(mids) + 1
        space = max(1.0, min(r - l for l, r in gaps))
        total = P.w - x0 - max(0.0, P.w - x1 - self.slack)
        lo = [x0] + [m + space / 2 for m in mids]
        hi = [m - space / 2 for m in mids] + [x0 + total]
        top = min(i.y0 for i in items)
        if cursor is None and self.first_top is None:
            self.first_top = top
        start = top if cursor is None else cursor + 1
        xml = f'<w:p><w:pPr>{BREAK}\x01SECT:\x01</w:pPr></w:p>' if lead else ""
        ends, parts = [], []
        for k in range(n):
            inner, end = self.in_cell([i for i in items if sum(1 for m in mids if (i.x0 + i.x1) / 2 > m) == k], lo[k], hi[k], start)
            if not inner.rstrip().endswith("</w:p>"):
                inner += self.spacer(1)
            parts.append(inner)
            ends.append(end)
        # Word balances a section that ends in a continuous break, so text typed into one column runs on into the next. Columns that end more than
        # 1.5 lines (a line is about 1.2 times the body size) apart would come out different, so they keep a column break. The break is a paragraph
        # of its own: inside the last paragraph of a column it stretches that paragraph's last line and takes a full line at the top of the next column.
        if max(ends) - min(ends) > 1.5 * 1.2 * P.body:
            parts = [p + f'<w:p><w:pPr>{BREAK}</w:pPr><w:r><w:br w:type="column"/></w:r></w:p>' for p in parts[:-1]] + parts[-1:]
        xml += "".join(parts)
        widths = [tw(hi[k] - lo[k]) for k in range(n)]
        widths[-1] = tw(total) - sum(widths[:-1]) - (n - 1) * tw(space)
        cols = (f'<w:cols w:num="{n}" w:space="{tw(space)}" w:equalWidth="0">'
                + "".join(f'<w:col w:w="{w}"{f' w:space="{tw(space)}"' if k < n - 1 else ""}/>' for k, w in enumerate(widths)) + "</w:cols>")
        return xml + f'<w:p><w:pPr>{BREAK}\x01SECT:{cols}\x01</w:pPr></w:p>', max(ends) + 1

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
        if not (0.7 * s <= dy <= 2.1 * s) or (prev.bold_all and l.bold_all and dy > 1.5 * s):
            return False
        if len(cur.lines) >= 2:
            pitch = (cur.lines[-1].base - cur.lines[0].base) / (len(cur.lines) - 1)
            if abs(dy - pitch) > 0.3 * pitch:
                return False
        cx_prev, cx = (prev.x0 + prev.x1) / 2, (l.x0 + l.x1) / 2
        wide, narrow = max(prev.x1 - prev.x0, l.x1 - l.x0), min(prev.x1 - prev.x0, l.x1 - l.x0)
        if abs(cx - cx_prev) <= 2.5 and abs(l.x0 - prev.x0) > 3 and not (wide >= 0.92 * width and narrow <= 0.8 * width):
            return True                                              # centred lines, not a centred formula over a line that fills the width
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
            if self.cap:
                pitch = max(size, min(pitch, self.cap))
        T = first.base - pitch + (-first.desc * first.size)
        return pitch, T, T + len(lines) * pitch

    def para_xml(self, p, x0, x1, cursor, before_extra=0.0, border_top=None, border_bottom=None, right_to=None):
        """-> (xml, T, B): the paragraph's XML, where its first line box starts and where its last ends."""
        lines = p.lines
        self.emitted.update(id(l) for l in lines)
        n = len(lines)
        first = lines[0]
        size = max(l.size for l in lines)
        pitch, T, B = self.metrics(p)
        rule, line = self.line_rule(lines, pitch, size)
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
            elif right_all and spread > tol and not (left_flush and (n >= 3 or any(l.justified for l in lines))):
                jc = "right"
            elif left_flush and all(abs(x - right_edge) <= tol for x in xs1[:-1]) and abs(lines[0].x0 - ref) <= 4.5 * lines[0].size                     and xs1[0] >= x1 - 0.12 * w and (right_edge - ref) > 0.4 * w and n >= 3:
                jc = "both"
            elif left_flush and any(l.justified for l in lines[:-1]) and all(abs(x - right_edge) <= tol for x in xs1[:-1]):
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
        if self.placed and jc != "both":
            breaks = [True] * len(breaks)
        reflow = n >= 2 and not any(breaks)
        ind_left = ind_right = 0.0
        first_line = (marker[3] if marker else lines[0].x0) - ref if n >= 2 and jc != "center" else 0.0
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
        if ind_right > 0 or jc != "left" or reflow:
            ind_right += self.room(x1)
        gap = x1 - right_edge if self.depth else None                 # a line that fills its cell wraps on any rounding in Word, and a cell clips what overhangs it, so it is set 1 twip a character narrower
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
        spacing = f'<w:spacing w:before="{tw(before)}" w:after="0" w:line="{line}" w:lineRule="{rule}"/>'
        style = heading = ""
        text = " ".join(l.text for l in lines).strip()
        if marker:
            style = "ListParagraph"
        elif size >= self.P.body * 1.25 and n <= 3 and len(text) <= 140:
            lvl = 0 if size >= self.P.body * 1.7 else 1 if size >= self.P.body * 1.4 else 2
            style = f"Heading{lvl + 1}"
            if lvl == 0 and not self.titled and self.P.pno == 0 and size >= 2 * self.P.body and size >= max(l.size for l in self.P.upright):
                style, heading, self.titled = "Title", '<w:outlineLvl w:val="0"/>', True
        elif n <= 2 and len(text) <= 140 and CAPTION.match(text):
            style = "Caption"
        elif n == 1 and not self.placed and self.labels(lines[0], text):
            style = "Heading3"
        ppr = f'<w:pPr>{f'<w:pStyle w:val="{style}"/>' if style else ""}{num_pr}{borders}{tabs}{spacing}{ind_attr}<w:jc w:val="{jc}"/>{heading}</w:pPr>'
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
                    last["text"] = t.rstrip() if self.compound(t, nxt) else t.rstrip()[:-1]
                elif not t.endswith(" "):
                    last["text"] = t + " "
            for s_ in spans:
                s_["bsize"] = l.size
            body += runs_xml(self.P, spans, justified, self.doc.part, self.meter, gap)
            if not last_line and breaks[i]:
                body += "<w:r><w:br/></w:r>"
        return f"{self.drop_cap(p, pitch) if p.cap else ''}<w:p>{ppr}{body}</w:p>", T, B

    def capped(self, items):
        """A large single letter standing at the left of the first two to four lines of a paragraph is that paragraph's drop capital: it leaves the lines, and the lines it
        stands beside start at the paragraph's left edge, where Word wraps them round it."""
        lines = [i for i in items if i.kind == "line"]
        for d in lines:
            if not is_letter(d) or d.size < 2 * self.P.body:
                continue
            beside = sorted((l for l in lines if l is not d and not l.marker and l.size < d.size / 2 and d.x1 - 2 <= l.x0 <= d.x1 + 0.4 * d.size
                             and d.y0 - 2 <= (l.y0 + l.y1) / 2 <= d.y1 + 2), key=lambda l: l.base)
            if 2 <= len(beside) <= 4:
                for l in beside:
                    l.x0 = d.x0
                beside[0].cap = d
                items = [i for i in items if i is not d]
        return items

    def drop_cap(self, p, pitch):
        d = p.cap
        self.emitted.add(id(d))
        spans = [dict(s, bsize=d.size) for s in d.spans]
        lines = min(4, max(2, round((d.y1 - d.y0) / pitch)))
        return (f'<w:p><w:pPr><w:framePr w:dropCap="drop" w:lines="{lines}" w:wrap="around" w:vAnchor="text" w:hAnchor="text"/>'
                f'<w:spacing w:before="0" w:after="0" w:line="{tw(lines * pitch)}" w:lineRule="exact"/><w:textAlignment w:val="baseline"/></w:pPr>'
                f'{runs_xml(self.P, spans, False, self.doc.part, self.meter)}</w:p>')

    def line_rule(self, lines, pitch, size):
        """(rule, line) for a paragraph. Lines are "at least" the PDF's pitch where the font's own height in Word is no taller, so they grow with the text when it is edited
        and Word still sets them at the PDF's pitch; they are exact where the PDF sets them tighter than the font (a title, a drop cap), where sizes are mixed, where the font
        is not known and where the text is not Latin, which Word sets in a fallback font of its own height."""
        if pitch >= 1.32 * size:
            return "atLeast", tw(pitch)
        spans = [s for l in lines for s in l.spans if s["text"].strip()]
        heights = [self.meter.height(s) for s in spans]
        sizes = [s["size"] for s in spans]
        if not spans or None in heights or max(sizes) > 1.08 * min(sizes) or not all(latin(s["text"]) for s in spans):
            return "exact", tw(pitch)
        return ("atLeast" if pitch >= 1.003 * max(h * z for h, z in zip(heights, sizes)) else "exact"), tw(pitch)

    def labels(self, l, text):
        """A short bold line of body size standing alone above text that is not bold, and not a cell of a table: a heading Word should list."""
        if any(inside(l.bbox, t.bbox, 0.5) for t in self.P.tbls) or not (l.bold_all and self.P.body * 0.95 <= l.size < self.P.body * 1.25 and len(text) <= 60 and re.search(r"[^\W\d_]", text) and text[-1] not in ":.,;"):
            return False
        below = [m for m in self.P.upright if m is not l and 0 <= m.y0 - l.y1 <= 2.0 * l.size and m.x0 < l.x1 and m.x1 > l.x0]
        return bool(below) and not any(m.bold_all for m in below)

    def compound(self, t, nxt):
        """A line that ends at the hyphen of a word the text spells with a hyphen elsewhere (three-year) keeps it; a word the typesetter broke is joined."""
        a, b = re.search(r"([^\W\d_]+)-$", t.rstrip()), re.match(r"[^\W\d_]+", nxt)
        return bool(a and b and f"{a.group(1)}-{b.group()}".lower() in self.meter.hyphenated)

    def frames(self, lines, extra=0.0):
        """Text that sits on a picture: positioned paragraphs (frames), each one still real text that reflows inside its frame."""
        xml = ""
        for p in self.group(lines, min(l.x0 for l in lines), max(l.x1 for l in lines)):
            pitch, T, B = self.metrics(p)
            fx0, fx1 = p.x0 - (p.lines[0].x0 - (p.lines[0].marker[2] if p.lines[0].marker else p.lines[0].x0)), p.x1 + 3.0 + extra
            part, T, B = self.para_xml(p, fx0, fx1, T)
            frame = (f'<w:framePr w:w="{tw(fx1 - fx0)}" w:h="{tw(B - T)}" w:hRule="atLeast" w:hSpace="0" w:vSpace="0" w:wrap="none" '
                     f'w:vAnchor="page" w:hAnchor="page" w:x="{tw(fx0)}" w:y="{tw(T)}"/>')
            xml += re.sub(r"<w:pPr>(<w:pStyle [^>]*/>)?", lambda m: m.group(0) + frame, part, 1)
        return xml

    def text_boxes(self, lines, tables=()):
        """The text of a design page: every paragraph a text box anchored to the sheet at its PDF position, still real text. -> (the tables, each after the text boxes that
        come before it in reading order, which sit in a paragraph of their own; the text boxes after the last table). Word prints a table's text first whatever the order,
        but the file's own order is what the cursor, a screen reader and select all follow."""
        paras = []
        for l in sorted(lines, key=lambda l: (l.base, l.x0)):
            above = [p for p in paras if self.joins(p, l, 0.0, 0.0)]
            if above:
                max(above, key=lambda p: p.lines[-1].base).lines.append(l)
            else:
                paras.append(Para([l]))
        order, mixed = self.reading_order(paras), self.reading_order(paras + list(tables))
        for t in [i for i in mixed if i.kind == "tbl"]:                       # the text boxes keep the order they have without the tables
            after = next((i for i in mixed[mixed.index(t):] if i.kind == "para"), None)
            order.insert(order.index(after) if after else len(order), t)
        xml = runs = ""
        for p in order:
            if p.kind == "tbl":
                xml += (f'<w:p><w:pPr>{BREAK}</w:pPr>{runs}</w:p>' if runs else "") + self.table(p, p.x0, p.x1, None, placed=True)[0]
                runs = ""
                continue
            first = p.lines[0]
            fx0 = p.x0 - (first.x0 - (first.marker[2] if first.marker else first.x0))
            fx1 = p.x1 + 3.0
            part, T, B = self.para_xml(p, fx0, fx1, self.metrics(p)[1])
            runs += self.text_box_xml(part, fx0, T, fx1 - fx0, B - T, wraps='<w:jc w:val="left"/>' not in part)
        return xml, runs

    def reading_order(self, items):
        """Columns of text one after the other, but the cells of a table row by row: the order Word reads text boxes in."""
        def rows(its):
            out = []
            for i in sorted(its, key=lambda i: i.y0):
                if out and i.y0 - out[-1][0].y0 <= 2.5:
                    out[-1].append(i)
                else:
                    out.append([i])
            return [i for r in out for i in sorted(r, key=lambda i: i.x0)]

        cols = self.v_cut(items)
        if cols:
            level = sum(any(abs(i.y0 - j.y0) <= 2.5 for d in cols if d is not c for j in d[2]) for c in cols for i in c[2])
            if level >= 0.6 * len(items):
                return rows(items)
            return [i for c in cols for i in self.reading_order(c[2])]
        bands = self.h_bands(items)
        if len(bands) > 1:
            return [i for b in bands for i in self.reading_order(b[2])]
        return rows(items)

    def turned_text_box(self, l):
        """A line that runs up, down or upside down: a text box as long as the line, turned about its centre."""
        dx, dy = l.dir
        turn = 90 if dy > 0 else 270 if dy < 0 else 180
        long, thick = (l.y1 - l.y0, l.x1 - l.x0) if turn != 180 else (l.x1 - l.x0, l.y1 - l.y0)
        spans = [dict(s, bbox=(s["bbox"][1], s["bbox"][0], s["bbox"][3], s["bbox"][2]) if turn != 180 else s["bbox"]) for s in l.spans]
        content = (f'<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="{tw(thick)}" w:lineRule="exact"/><w:jc w:val="left"/></w:pPr>'
                   f'{runs_xml(self.P, spans, False, self.doc.part, self.meter)}</w:p>')
        cx, cy = (l.x0 + l.x1) / 2, (l.y0 + l.y1) / 2
        return self.text_box_xml(content, cx - (long + 3.0) / 2, cy - thick / 2, long + 3.0, thick, wraps=False, turn=turn)

    def text_box_xml(self, content, x, y, w, h, wraps, turn=0):
        """A text box without fill or line and with no inset, anchored to the sheet. A left-aligned paragraph is not allowed to wrap, so a substitute font that is a little wider cannot break a line; Word places centred and right-aligned text inside a box that does not wrap as if the box were empty, so those keep a box as wide as the text."""
        pid = self.next_id()
        cx, cy = int(w * 12700), int((h + 2.0) * 12700)
        return (f'<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="{pid}" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">'
                f'<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>{int(x * 12700)}</wp:posOffset></wp:positionH>'
                f'<wp:positionV relativeFrom="page"><wp:posOffset>{int(y * 12700)}</wp:posOffset></wp:positionV>'
                f'<wp:extent cx="{cx}" cy="{cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>'
                f'<wp:docPr id="{pid}" name="Text {pid}"/><wp:cNvGraphicFramePr/>'
                f'<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">'
                f'<wps:wsp xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:cNvSpPr txBox="1"/>'
                f'<wps:spPr><a:xfrm{f' rot="{turn * 60000}"' if turn else ''}><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></wps:spPr>'
                f'<wps:txbx><w:txbxContent>{content}</w:txbxContent></wps:txbx>'
                f'<wps:bodyPr wrap="{"square" if wraps else "none"}" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t"><a:noAutofit/></wps:bodyPr></wps:wsp>'
                f'</a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>')

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
                if l.x1 >= x1 - 3 and (l.x0 > first.x1 + 20 or NUMBERED.fullmatch(l.text.strip())):
                    stops += f'<w:tab w:val="right" w:pos="{tw(l.x1 - x0)}"/>'
                else:
                    stops += f'<w:tab w:val="left" w:pos="{tw(l.x0 - x0)}"/>'
                body += "<w:r><w:tab/></w:r>"
            body += runs_xml(P, l.spans, False, self.doc.part, self.meter)
        rule, line = self.line_rule(lines, pitch, size)
        ppr = (f'<w:pPr><w:tabs>{stops}</w:tabs><w:spacing w:before="{tw(before)}" w:after="0" w:line="{line}" w:lineRule="{rule}"/>'
               f'<w:ind w:left="{tw(first.x0 - x0)}"/></w:pPr>')
        return f"<w:p>{ppr}{body}</w:p>", T, T + pitch

    def spacer(self, h):
        if h < 1.0:
            return ""
        return f'<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="{tw(h)}" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/></w:rPr></w:pPr></w:p>'

    def next_id(self):
        return next(self.lists.drawing_ids)

    def picture_xml(self, it, floating=False, name="Picture"):
        rid, _ = self.doc.part.get_or_add_image(io.BytesIO(it.data))
        cx, cy = int((it.x1 - it.x0) * 12700), int((it.y1 - it.y0) * 12700)
        pid = self.next_id()
        x, y, turn = it.x0, it.y0, ""
        if floating and self.turn:
            x, y = self.turned_corner(it)
            turn = f' rot="{self.turn * 60000}"'
        crop = getattr(it, "crop", None)
        src = "<a:srcRect " + " ".join(f'{k}="{int(round(v * 100000))}"' for k, v in zip("ltrb", crop)) + "/>" if crop else ""
        pic = (f'<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="{pid}" name="{name} {pid}"/>'
               f'<pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="{rid}"/>{src}<a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
               f'<pic:spPr><a:xfrm{turn}><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="{"ellipse" if getattr(it, "ellipse", False) else "rect"}"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>')
        if not floating:
            return (f'<w:r><w:rPr><w:sz w:val="2"/></w:rPr><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="{cx}" cy="{cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>'
                    f'<wp:docPr id="{pid}" name="{name} {pid}"/><wp:cNvGraphicFramePr/>{pic}</wp:inline></w:drawing></w:r>')
        return (f'<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="{pid}" behindDoc="1" locked="1" layoutInCell="1" allowOverlap="1">'
                f'<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>{int(x * 12700)}</wp:posOffset></wp:positionH>'
                f'<wp:positionV relativeFrom="page"><wp:posOffset>{int(y * 12700)}</wp:posOffset></wp:positionV><wp:extent cx="{cx}" cy="{cy}"/>'
                f'<wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="{pid}" name="{name} {pid}"/><wp:cNvGraphicFramePr/>{pic}</wp:anchor></w:drawing></w:r>')

    def turned_corner(self, it):
        """Top left corner, on the sheet as it is shown, of a picture that is placed upright and then turned about its centre."""
        w, h = it.x1 - it.x0, it.y1 - it.y0
        cx, cy = it.x0 + w / 2, it.y0 + h / 2
        sw, sh = self.P.w, self.P.h
        nx, ny = {90: (sh - cy, cx), 180: (sw - cx, sh - cy), 270: (cy, sw - cx)}[self.turn]
        return nx - w / 2, ny - h / 2

    def turned_page(self, xml, margins):
        """The page, built upright, as one text box the size of the upright sheet turned about its centre, so the shown sheet
        keeps the PDF's orientation and the text stays text."""
        sw, sh = self.P.w, self.P.h
        pid = self.next_id()
        ox, oy = ((sh - sw) / 2, (sw - sh) / 2) if self.turn != 180 else (0.0, 0.0)
        top, right, bottom, left = (int(m * 12700) for m in margins)
        return (f'<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/></w:rPr></w:pPr><w:r><w:drawing>'
                f'<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="{pid}" behindDoc="0" locked="1" layoutInCell="1" allowOverlap="1">'
                f'<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>{int(ox * 12700)}</wp:posOffset></wp:positionH>'
                f'<wp:positionV relativeFrom="page"><wp:posOffset>{int(oy * 12700)}</wp:posOffset></wp:positionV>'
                f'<wp:extent cx="{int(sw * 12700)}" cy="{int(sh * 12700)}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>'
                f'<wp:docPr id="{pid}" name="Page {pid}"/><wp:cNvGraphicFramePr/>'
                f'<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">'
                f'<wps:wsp xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:cNvSpPr txBox="1"/>'
                f'<wps:spPr><a:xfrm rot="{self.turn * 60000}"><a:off x="0" y="0"/><a:ext cx="{int(sw * 12700)}" cy="{int(sh * 12700)}"/></a:xfrm>'
                f'<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></wps:spPr>'
                f'<wps:txbx><w:txbxContent>{xml}<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/></w:pPr></w:p></w:txbxContent></wps:txbx>'
                f'<wps:bodyPr lIns="{left}" tIns="{top}" rIns="{right}" bIns="{bottom}" anchor="t"><a:noAutofit/></wps:bodyPr></wps:wsp>'
                f'</a:graphicData></a:graphic></wp:anchor></w:drawing></w:r></w:p>')

    def image_para(self, it, x0, x1, cursor):
        before = 0.0 if cursor is None else max(0.0, it.y0 - cursor)
        if cursor is None and self.first_top is None:
            self.first_top = it.y0
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
                reach = 2.2 * max(self.P.body, 10) if b.fill or last.fill else 2.2           # outlined boxes with a gap between them are boxes, not the rows of one table
                if abs(last.x0 - b.x0) <= 2.5 and abs(last.x1 - b.x1) <= 2.5 and -2 <= b.y0 - last.y1 <= reach:
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
        items = self.stripes(self.capped(items))
        if self.columns_ok and not self.depth:
            bands = self.h_bands(items)
            runs = self.column_runs(bands, x0, x1)
            if runs:
                return self.with_columns(bands, runs, x0, x1, cursor)
        return self.laid(items, x0, x1, cursor)

    def laid(self, items, x0, x1, cursor, whole=True):
        """`whole` is False for what lies between two runs of columns: a cut through all of it is then not a column structure of its own, and it is laid out band by band."""
        cols = self.v_cut(items) if whole else None
        if cols:
            return self.row(cols, x0, x1, cursor)
        bands = self.h_bands(items)
        if len(bands) > 1 or not whole:
            grouped = []
            for y0, y1, its in bands:
                sig = self.v_cut(its)
                key = None if not sig else [(round(c[0]), round(c[1])) for c in sig]
                if grouped and grouped[-1]["key"] == key and (key is None or all(abs(a[0] - b[0]) < 8 and abs(a[1] - b[1]) < 8 for a, b in zip(grouped[-1]["key"], key))):
                    grouped[-1]["items"].extend(its)
                else:
                    grouped.append({"key": key, "items": list(its)})
            if len(grouped) > 1 or not whole:
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
            inner, _ = self.in_cell(its, lo, hi, top)
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
        for it in items:
            if it.kind == "img" and not it.floating and sum(1 for l in items if l.kind == "line" and l.y1 > it.y0 + 2 and l.y0 < it.y1 - 2) >= 2:
                it.floating = True
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
                        f'<w:ind w:left="{tw(max(0.0, blk.x0 - x0))}" w:right="{tw(max(0.0, x1 - blk.x1) + self.room(x1))}"/><w:rPr><w:sz w:val="2"/></w:rPr></w:pPr></w:p>')
                cursor = cy + bw / 2
            elif blk.kind == "para":
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
        inner, _ = self.in_cell(bx.children, bx.x0, bx.x1, bx.y0)
        if not inner or not inner.rstrip().endswith("</w:p>"):
            inner += self.spacer(1)
        sides = {s: bx.border for s in ("top", "left", "bottom", "right")} if bx.border else {}
        shd = f'<w:shd w:val="clear" w:color="auto" w:fill="{bx.fill}"/>' if bx.fill else ""
        xml = self.spacer(before)
        xml += (f'<w:tbl><w:tblPr><w:tblW w:w="{tw(bx.x1 - bx.x0)}" w:type="dxa"/><w:tblInd w:w="{tw(max(0.0, bx.x0 - x0))}" w:type="dxa"/><w:tblLayout w:type="fixed"/>'
                f'<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPr>'
                f'<w:tblGrid><w:gridCol w:w="{tw(bx.x1 - bx.x0)}"/></w:tblGrid><w:tr><w:trPr>{self.keep(bx.y1 - bx.y0)}<w:trHeight w:val="{tw(bx.y1 - bx.y0)}" w:hRule="atLeast"/></w:trPr>'
                f'<w:tc><w:tcPr><w:tcW w:w="{tw(bx.x1 - bx.x0)}" w:type="dxa"/>{self.border_xml(sides, bx.dashed)}{shd}</w:tcPr>{inner}</w:tc></w:tr></w:tbl>')
        xml += self.spacer(1)
        return xml, bx.y1 + 1

    def table(self, t, x0, x1, cursor, placed=False):
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
                    self.cap = min(b - a for a, b in zip(ys, ys[1:])) if placed else None
                    inner, _ = self.in_cell(c["items"], cx0, cx1, cy0)
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
            rows += f'<w:tr><w:trPr>{self.keep(ys[r + 1] - ys[r])}<w:trHeight w:val="{tw(ys[r + 1] - ys[r])}" w:hRule="atLeast"/></w:trPr>{tcs}</w:tr>'
        self.cap = None
        tgrid = "".join(f'<w:gridCol w:w="{tw(xs[k + 1] - xs[k])}"/>' for k in range(ncol))
        xml = self.spacer(before)
        at = (f'<w:tblpPr w:leftFromText="0" w:rightFromText="0" w:topFromText="0" w:bottomFromText="0" w:vertAnchor="page" w:horzAnchor="page" w:tblpX="{tw(xs[0])}" w:tblpY="{tw(ys[0])}"/>'
              '<w:tblOverlap w:val="overlap"/>') if placed else ""
        xml += (f'<w:tbl><w:tblPr>{at}<w:tblW w:w="{tw(xs[-1] - xs[0])}" w:type="dxa"/><w:tblInd w:w="{tw(max(0.0, xs[0] - x0))}" w:type="dxa"/><w:tblLayout w:type="fixed"/>'
                f'<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPr>'
                f'<w:tblGrid>{tgrid}</w:tblGrid>{rows}</w:tbl>')
        xml += self.spacer(1)
        return xml, t.y1 + 1

# SPDX-License-Identifier: AGPL-3.0-or-later
"""Reading the text of a page as lines: spans joined into lines, pieces on one row merged, bullets and numbers split off as list markers."""

import re

from pdf_spans import TEXT_FLAGS, has_unmapped_symbols

from .common import BULLETS, NUMBER


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
    return not has_unmapped_symbols(t, BULLETS)


TRACKED = re.compile(r"^(?:[^\s]{1,3} ){2,}[^\s]{1,3}$|(?:^|\s)[A-Z] [A-Z]{1,3} ")


def repair_tracked(page, blocks):
    """Letter-spaced capitals (a label with tracking) come out of the text layer with spaces inside the words. The gaps
    between the real characters say where the real spaces are."""
    suspects = [s for b in blocks if b["type"] == 0 for ln in b["lines"] for s in ln["spans"]
                if s["text"].count(" ") >= 2 and s["text"].strip().upper() == s["text"].strip() and TRACKED.search(s["text"].strip())]
    if not suspects:
        return
    raw = page.get_text("rawdict", flags=TEXT_FLAGS)["blocks"]
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
    blocks = page.get_text("dict", flags=TEXT_FLAGS)["blocks"]
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

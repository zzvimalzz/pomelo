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
        self.block = self.block_x1 = None   # the PDF text block the line came from, and where it ends on the right
        self.seq = 0                  # where the PDF wrote the line among the lines of its page
        self.justified = False
        self.dir = (1.0, 0.0)
        self.cap = None               # the drop capital that stands beside this line, when it starts the paragraph the capital opens
        self.leader = None            # (Word's name for the leader, where the end piece ends) when a tab with a leader leads to the end of the line
        self.lead_in = None           # Word's name for the leader of the tab that leads to this line, when a dotted stroke runs to it on its row

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


def span_ok(s, hidden_ok=False):
    t = s["text"]
    if s["size"] < 2.5:
        return False
    if s.get("alpha", 255) == 0 and not hidden_ok:
        return False
    return not has_unmapped_symbols(t, BULLETS)


TRACKED = re.compile(r"^(?:[^\s]{1,3} ){2,}[^\s]{1,3}$|(?:^|\s)[A-Z] [A-Z]{1,3} ")


def repair_tracked(blocks):
    """Letter-spaced capitals (a label with tracking) come out of the text layer with spaces inside the words. The gaps
    between the real characters say where the real spaces are."""
    for b in blocks:
        if b["type"] != 0:
            continue
        for ln in b["lines"]:
            for s in ln["spans"]:
                t = s["text"].strip()
                if s["text"].count(" ") < 2 or t.upper() != t or not TRACKED.search(t):
                    continue
                kept, last = [], None
                for ch in s["chars"]:
                    if ch["c"].isspace():
                        continue
                    if last is not None and ch["bbox"][0] - last["bbox"][2] > 0.34 * s["size"] and kept and kept[-1]["c"] != " ":
                        kept.append({"c": " ", "origin": ch["origin"]})
                    kept.append(ch)
                    last = ch
                s["chars"] = kept
                s["text"] = "".join(c["c"] for c in kept)


def read_lines(page, clip=None, hidden_ok=False):
    out = []
    blocks = page.get_text("rawdict", flags=TEXT_FLAGS, clip=clip)["blocks"]
    for block in blocks:
        for ln in block.get("lines", ()):
            for s in ln["spans"]:
                s["text"] = "".join(c["c"] for c in s["chars"])
    try:
        repair_tracked(blocks)
    except Exception:
        pass
    for block in blocks:
        for ln in block.get("lines", ()):
            for s in ln["spans"]:
                s["org"] = [c["origin"] for c in s.pop("chars")]       # where each letter starts, for the letter spacing
                s["raw"] = s["text"]                                   # what those starts belong to, since the text is cut later
    for bi, block in enumerate(blocks):
        if block["type"] != 0:
            continue
        for ln in block["lines"]:
            spans = [s for s in ln["spans"] if s["text"] != ""]
            if not any(s["text"].strip() for s in spans):
                continue
            dx, dy = ln["dir"]
            rot = abs(dy) > 0.02 or dx < 0.98
            real = [s for s in spans if s["text"].strip()]
            if not all(span_ok(s, hidden_ok) for s in real):
                # a symbol-font glyph that has no Unicode meaning stays in the picture, whatever else the line holds
                spans = [s for s in spans if span_ok(s, hidden_ok)]
                if not any(s["text"].strip() for s in spans):
                    continue
            size = max(s["size"] for s in spans if s["text"].strip())
            line = Line([dict(s) for s in spans], ln["bbox"], spans[0]["origin"][1], size, rot)
            line.block, line.block_x1 = bi, block["bbox"][2]
            line.seq = len(out)
            line.dir = (dx, dy)
            out.append(line)
    return out


def in_separate_boxes(r, shapes):
    """True when the pieces sit in different drawn boxes (the pills of a tag list), which a justified line never does."""
    homes = set()
    for l in r:
        cx, cy = (l.x0 + l.x1) / 2, (l.y0 + l.y1) / 2
        around = [s[0] for s in shapes if s[0].x0 <= cx <= s[0].x1 and s[0].y0 <= cy <= s[0].y1]
        if around:
            homes.add(tuple(min(around, key=lambda b: b.width * b.height)))
    return len(homes) > 1


def stretched_row(r, shapes=()):
    """The words of a justified line, which the PDF holds one by one: three or more of them from one text block, with
    the same wide gap between each pair, the last one at the block's right edge. A row of numbers, a menu bar or the
    cells of a table fail one of these tests and stay apart."""
    if len(r) < 3 or r[0].block is None or any(l.block != r[0].block for l in r) or in_separate_boxes(r, shapes):
        return False
    if sum(bool(re.search(r"[^\W\d_]", l.text)) for l in r) < 2 * len(r) / 3:
        return False
    gaps = [b.x0 - a.x1 for a, b in zip(r, r[1:])]
    return max(gaps) - min(gaps) <= 1.0 and max(gaps) < 3 * min(l.size for l in r) and r[-1].x1 >= r[-1].block_x1 - 2.5


def join_pieces(cur, nxt):
    gap = nxt.x0 - cur.x1
    spans = cur.spans
    if gap > 0.12 * cur.size and not cur.text.endswith(" ") and not nxt.text.startswith(" "):
        spans = spans + [dict(cur.spans[-1], text=" ", bbox=(cur.x1, cur.y0, nxt.x0, cur.y1))]
    merged = Line(spans + nxt.spans, (cur.x0, min(cur.y0, nxt.y0), nxt.x1, max(cur.y1, nxt.y1)), cur.base, max(cur.size, nxt.size))
    merged.block, merged.block_x1 = cur.block, cur.block_x1
    merged.seq = min(cur.seq, nxt.seq)
    return merged


def join_stretched(r, shapes):
    """The words of each justified line in a row become one line. Two columns share a row, so each text block is judged on its own."""
    blocks = {}
    for l in r:
        blocks.setdefault(l.block, []).append(l)
    out = []
    for group in blocks.values():
        if not stretched_row(group, shapes):
            out += group
            continue
        cur = group[0]
        for nxt in group[1:]:
            cur = join_pieces(cur, nxt)
        cur.justified = True
        out.append(cur)
    return sorted(out, key=lambda l: l.x0)


def is_letter(l):
    t = l.text.strip()
    return len(t) == 1 and t.isalpha()


def is_drop_cap(a, b):
    """A single letter at least twice the size of the text beside it, on its baseline: the capital that opens a paragraph, not a part of its first line."""
    big, small = (a, b) if a.size > b.size else (b, a)
    return is_letter(big) and big.size >= 2 * small.size


LEADER_PIECE = re.compile(r"\s*(?:[.·…_\-]\s*){4,}\S{1,12}\s*$")


def merge_rows(lines, shapes=()):
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
        r = join_stretched(sorted(r, key=lambda l: l.x0), shapes)
        cur = r[0]
        for nxt in r[1:]:
            if (nxt.x0 - cur.x1 < 0.8 * min(cur.size, nxt.size) or LEADER_PIECE.match(nxt.text)) and not is_drop_cap(cur, nxt):
                cur = join_pieces(cur, nxt)
            else:
                out.append(cur)
                cur = nxt
        out.append(cur)
    return out


LEADER = re.compile(r"(?P<run>\s*(?:[.·…_\-]\s*){4,})(?P<tail>[^\s.·…_\-]\S{0,11}(?:\s\S{1,5})?)\s*$")
LEADERS = {".": "dot", "·": "dot", "…": "dot", "_": "underscore", "-": "hyphen"}


def split_leader(line):
    """A text, a run of leader characters and a short end piece (a contents entry, a price on a menu) becomes the text, a tab that carries the leader, and the end piece:
    Word's tab leader fills the gap at any width, where literal dots would wrap a line that is a little wider in Word."""
    text = line.text
    m = LEADER.search(text) if len(text) <= 400 else None
    if not m or not text[:m.start()].strip() or line.marker:
        return
    a, b, pos = m.start(), m.start("tail"), 0
    head, tail = [], []
    for s in line.spans:
        t = s["text"]
        lo, hi, pos = pos, pos + len(t), pos + len(t)
        x0, x1 = s["bbox"][0], s["bbox"][2]
        cut = lambda i, j: dict(s, text=t[i:j], bbox=(x0 + (x1 - x0) * i / len(t), s["bbox"][1], x0 + (x1 - x0) * j / len(t), s["bbox"][3]))
        if lo < a:
            head.append(cut(0, min(len(t), a - lo)))
        if hi > b:
            tail.append(cut(max(0, b - lo), len(t)))
    if not head or not tail or tail[0]["bbox"][0] - head[-1]["bbox"][2] < 2.5 * line.size:
        return
    tab = {k: v for k, v in head[-1].items() if k not in ("ul", "st", "hl", "link", "field")}
    tab.update(text="\t", bbox=(head[-1]["bbox"][2], head[-1]["bbox"][1], tail[0]["bbox"][0], head[-1]["bbox"][3]))        # the gap it stands for, so the dots leave the picture
    line.spans = head + [tab] + tail
    line.leader = (LEADERS[m.group("run").strip()[0]], line.x1)


def bullet(token):
    """A bullet is made only of bullet characters, so a flag such as "-sU" is not one. The letter "o" counts only on its own."""
    return all(c in BULLETS for c in token) and (token == "o" or "o" not in token)


def attach_markers(lines):
    """A bullet or a number the PDF drew as a line of its own joins the text on its row."""
    def marker_only(l):
        t = l.text.strip()
        return 0 < len(t) <= 3 and (bullet(t) or bool(NUMBER.match(t)))
    out = list(lines)
    for m in [l for l in lines if marker_only(l)]:
        mates = [o for o in out if o is not m and not marker_only(o) and abs(o.base - m.base) <= 0.35 * m.size + 1.0 and 0 < o.x0 - m.x1 <= 4.5 * m.size]
        if not mates:
            continue
        o = min(mates, key=lambda o: o.x0 - m.x1)
        gap = dict(m.spans[-1], text=" ", bbox=(m.x1, m.y0, o.x0, m.y1))
        merged = Line(m.spans + [gap] + o.spans, (m.x0, min(m.y0, o.y0), o.x1, max(m.y1, o.y1)), o.base, max(m.size, o.size))
        merged.seq = min(m.seq, o.seq)
        out.remove(m)
        out[out.index(o)] = merged
    return out


def hangs(line, lines):
    """False when the line below starts under the marker, not under the text, and is no marker line itself: a number that opens a running paragraph, as in "(1) The Supplier ...", is not a list item."""
    below = [m for m in lines if m is not line and -2 <= m.y0 - line.y1 <= 0.9 * line.size and m.x0 <= line.x1 and m.x1 >= line.x0 and m.text.strip()]
    if not below:
        return True
    nxt = min(below, key=lambda m: m.y0)
    first = nxt.text.split(None, 1)[0]
    return not (abs(nxt.x0 - line.x0) <= 2 and not (bullet(first) or NUMBER.match(first)))


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
    if len(first) <= 2 and bullet(first):
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

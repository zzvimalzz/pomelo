# SPDX-License-Identifier: AGPL-3.0-or-later
"""Reading the text of a page as lines: spans joined into lines, pieces on one row merged, bullets and numbers split off as list markers."""

import copy
import re

import pymupdf

from pdf_fonts import MATH_ITALIC
from pdf_spans import RTL, TEXT_FLAGS, has_unmapped_symbols

from .common import BULLETS, NUMBER, ZERO_WIDTH


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
        self.block = self.block_x1 = None   # the PDF text block the line came from, and where it ends on the right
        self.seq = 0                  # where the PDF wrote the line among the lines of its page
        self.justified = False
        self.dir = (1.0, 0.0)
        self.cap = None               # the drop capital that stands beside this line, when it starts the paragraph the capital opens
        self.leader = None            # (Word's name for the leader, where the end piece ends) when a tab with a leader leads to the end of the line
        self.lead_in = None           # Word's name for the leader of the tab that leads to this line, when a dotted stroke runs to it on its row
        self.parts = ()               # the lines this one was joined from, so that the check for text never written counts them
        self.wrapped = False          # a picture or box beside the line shortens it, and Word wraps the paragraph round that drawing
        self.floats = ()              # the drawings anchored in the paragraph this line belongs to
        self.tags = ()                # the elements a tagged PDF puts the line in, outermost first, as (number, type)

    @property
    def text(self):
        return "".join(s["text"] for s in self.spans)

    @property
    def bbox(self):
        return (self.x0, self.y0, self.x1, self.y1)

    @property
    def left(self):
        return self.marker[2] if self.marker else self.x0

    @property
    def bold_all(self):
        real = [s for s in self.spans if s["text"].strip()]
        return bool(real) and all(is_bold(s) for s in real)


def is_bold(s):
    n = s["font"].lower()
    return bool(s["flags"] & 16) or "bold" in n or "black" in n or "heavy" in n or "semibold" in n


def is_italic(s):
    n = s["font"].lower()
    return bool(s["flags"] & 2) or "italic" in n or "oblique" in n or bool(MATH_ITALIC.match(re.sub(r"^[a-z]{6}\+", "", n)))


def span_ok(s, hidden_ok=False):
    t = s["text"]
    if s["size"] < 1.0:
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


def clipped_runs(spans, seen, upright):
    """The spans with the letters that the page's clip paths cut away (a long title in a cell that is narrower than it) split off as hidden runs: the PDF does not show them."""
    out = []
    for s in spans:
        org, text = s["org"], s["text"]
        shown = [(round(x, 2), round(y, 2)) in seen for x, y in org]
        if not upright:
            out.append(dict(s, hidden=True) if org and not any(shown) else s)
            continue
        if all(shown) or s["raw"] != text or len(org) != len(text):
            out.append(s)
            continue
        cuts = [0] + [k for k in range(1, len(text)) if shown[k] != shown[k - 1]] + [len(text)]
        for a, b in zip(cuts, cuts[1:]):
            x0 = org[a][0]
            x1 = org[b][0] if b < len(text) else s["bbox"][2]
            out.append(dict(s, text=text[a:b], raw=text[a:b], org=org[a:b], bbox=(x0, s["bbox"][1], x1, s["bbox"][3]), origin=org[a], hidden=not shown[a]))
    return out


HEADINGS = {"Title": 0, "H": 1, "H1": 1, "H2": 2, "H3": 3, "H4": 3, "H5": 3, "H6": 3}
PARAGRAPHS = {"P", "LI", "TD", "TH", "Caption", "TOCI", "BlockQuote", *HEADINGS}


def struct_tags(page, clip=None):
    """{where a span starts: the elements it is tagged with, outermost first} for a tagged PDF, as Word, Google Docs and most office programs write them; {} for any other.
    The tags say which lines make one paragraph, which are headings and which are the cells of a table, where the page itself only says where each letter stands."""
    doc = page.parent
    try:
        if doc.xref_get_key(doc.pdf_catalog(), "StructTreeRoot")[0] == "null":
            return {}
        blocks = page.get_text("dict", flags=TEXT_FLAGS | pymupdf.TEXT_COLLECT_STRUCTURE, clip=clip)["blocks"]
    except Exception:
        return {}
    out = {}
    todo = [(b, ()) for b in blocks]
    while todo:
        b, path = todo.pop()
        if b["type"] == 2:
            path += ((b["number"], b.get("std") or b.get("raw") or ""),)
            todo += [(c, path) for c in b.get("blocks", ())]
        elif b["type"] == 0 and path:
            out.update((spot(s["origin"]), path) for ln in b["lines"] for s in ln["spans"])
    return out


def spot(origin):
    return round(origin[0], 1), round(origin[1], 1)


def para_tag(l):
    """The paragraph a tagged PDF puts the line in, as (number, type): its innermost list item (whose number and text are tagged apart), or else its innermost paragraph,
    heading or cell; None when the line has no such tag."""
    return next((t for t in reversed(l.tags) if t[1] == "LI"), None) or next((t for t in reversed(l.tags) if t[1] in PARAGRAPHS), None)


def read_lines(page, clip=None, hidden_ok=False):
    out = []
    tags = struct_tags(page, clip)
    blocks = page.get_text("rawdict", flags=TEXT_FLAGS, clip=clip)["blocks"]
    r = page.rect
    off = lambda c: c["bbox"][0] < r.x0 or c["bbox"][1] < r.y0 or c["bbox"][2] > r.x1 or c["bbox"][3] > r.y1
    chars = lambda bs, keep: {(round(c["origin"][0], 2), round(c["origin"][1], 2)) for b in bs for ln in b.get("lines", ()) for s in ln["spans"] for c in s["chars"] if keep(c)}
    # the sheet's own edge cuts letters too, and those are left as they are
    seen = chars(page.get_text("rawdict", flags=TEXT_FLAGS | pymupdf.TEXT_CLIP, clip=clip)["blocks"], lambda c: True) | chars(blocks, off)
    for block in blocks:
        for ln in block.get("lines", ()):
            for s in ln["spans"]:
                s["chars"] = [c for c in s["chars"] if c["c"] not in ZERO_WIDTH]
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
            spans = clipped_runs(spans, seen, abs(ln["dir"][1]) <= 0.02 and ln["dir"][0] >= 0.98)
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
            line.tags = next((tags[spot(s["origin"])] for s in real if spot(s["origin"]) in tags), ())
            out.append(line)
    return out


def even_sizes(lines):
    """A scanner's text layer sets every word at the height of its own box, so one line holds many sizes: each line is set in the size most of its letters have, and a line
    within a fifth of the page's usual size in that size."""
    own = {}
    for l in lines:
        sizes = sorted(s["size"] for s in l.spans for c in s["text"] if c.strip())
        if sizes:
            own[id(l)] = sizes[len(sizes) // 2]
    usual = sorted(own.values())[len(own) // 2] if own else 0.0
    for l in lines:
        if id(l) in own:
            l.size = usual if 0.85 * usual <= own[id(l)] <= 1.18 * usual else own[id(l)]
            for s in l.spans:
                s["size"] = l.size


def field_marks(page):
    """The check boxes and radio buttons of a form as one character each in Segoe UI Symbol, the way Word draws its own: they are widgets, which the text of the page does not hold and its drawings may not."""
    out = []
    for w in [] if page.rotation else page.widgets() or []:
        radio = w.field_type_string == "RadioButton"
        if radio or w.field_type_string == "CheckBox":
            on = str(w.field_value) not in ("Off", "False", "", "None")
            r, size = w.rect, max(7.0, min(14.0, 1.15 * w.rect.height))
            text = ("◉" if on else "◯") if radio else ("☒" if on else "☐")
            span = {"size": size, "flags": 0, "font": "Segoe UI Symbol", "color": 0, "ascender": 1.0, "descender": -0.3, "text": text, "raw": text, "origin": (r.x0, r.y1), "org": [(r.x0, r.y1)], "bbox": tuple(r)}
            out.append(Line([span], tuple(r), r.y1, size))
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


def stretched_row(r, shapes=(), others=()):
    """The words of a justified line, which the PDF holds one by one: three or more of them from one text block, with the same wide gap between each pair (or two, one wide gap apart, that start and end on the edges of other lines of the block), the last one
    at the block's right edge or at an edge that other lines of the block end on, as in a column that text wraps round. A row of numbers, a menu bar or the cells of a
    table fail one of these tests and stay apart."""
    if len(r) < 2 or r[0].block is None or any(l.block != r[0].block for l in r) or in_separate_boxes(r, shapes):
        return False
    mates = [m for m in others if m.block == r[0].block and abs(m.base - r[0].base) > 0.3 * r[0].size]
    if len(r) == 2:
        return (r[1].x0 - r[0].x1 < 1.5 * r[0].size and all(re.search(r"[^\W\d_]{2}", l.text) for l in r)
                and any(abs(m.x0 - r[0].x0) <= 1.5 for m in mates) and any(abs(m.x1 - r[1].x1) <= 1.5 for m in mates))
    if sum(bool(re.search(r"[^\W\d_]", l.text)) for l in r) < 2 * len(r) / 3:
        return False
    gaps = [b.x0 - a.x1 for a, b in zip(r, r[1:])]
    flush = r[-1].x1 >= r[-1].block_x1 - 2.5 or any(abs(m.x1 - r[-1].x1) <= 1.5 for m in mates)
    return max(gaps) - min(gaps) <= 1.0 and max(gaps) < 3 * min(l.size for l in r) and flush


def mostly_rtl(lines):
    letters = [c for l in lines for c in l.text if c.isalpha()]
    return sum(bool(RTL.match(c)) for c in letters) * 2 > len(letters)


def join_pieces(cur, nxt, tab=False):
    behind = nxt.x1 <= cur.x0            # right-to-left pieces are joined from the right, so nxt lies to the left of cur
    gap = cur.x0 - nxt.x1 if behind else nxt.x0 - cur.x1
    spans = cur.spans
    if tab:
        spans = [s for s in spans if s["text"].strip()]
        last = dict(spans[-1], text=spans[-1]["text"].rstrip())
        stop = {k: v for k, v in last.items() if k not in ("ul", "st", "hl", "link", "field")}
        spans = spans[:-1] + [last, dict(stop, text="\t", bbox=(cur.x1, cur.y0, nxt.x0, cur.y1))]
    elif gap > 0.12 * cur.size and not cur.text.endswith(" ") and not nxt.text.startswith(" "):
        spans = spans + [dict(cur.spans[-1], text=" ", bbox=(nxt.x1 if behind else cur.x1, cur.y0, cur.x0 if behind else nxt.x0, cur.y1))]
    merged = Line(spans + nxt.spans, (min(cur.x0, nxt.x0), min(cur.y0, nxt.y0), max(cur.x1, nxt.x1), max(cur.y1, nxt.y1)), cur.base, max(cur.size, nxt.size))
    merged.block, merged.block_x1 = cur.block, cur.block_x1
    merged.seq = min(cur.seq, nxt.seq)
    merged.tags = cur.tags
    return merged


def join_stretched(r, shapes, others):
    """The words of each justified line in a row become one line. Two columns share a row, so each text block is judged on its own."""
    blocks = {}
    for l in r:
        blocks.setdefault(l.block, []).append(l)
    out = []
    for group in blocks.values():
        if not stretched_row(group, shapes, others):
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
SECTION = re.compile(r"\d{1,2}(?:\.\d{1,2})*\.?")


def heading_number(a, b):
    """A bold section number and the bold title after it in the same size, up to one and a half sizes apart: a heading Word sets with a tab after its number. Years and table figures are not section numbers."""
    return bool(SECTION.fullmatch(a.text.strip())) and a.bold_all and b.bold_all and abs(a.size - b.size) <= 0.5 and 0 <= b.x0 - a.x1 < 1.5 * a.size and bool(re.search(r"[^\W\d_]", b.text))


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
        r = join_stretched(sorted(r, key=lambda l: l.x0), shapes, lines)
        runs = [[r[0]]]
        for nxt in r[1:]:
            cur = runs[-1][-1]
            if (nxt.x0 - cur.x1 < 0.8 * min(cur.size, nxt.size) or LEADER_PIECE.match(nxt.text) or heading_number(cur, nxt)) and not is_drop_cap(cur, nxt):
                runs[-1].append(nxt)
            else:
                runs.append([nxt])
        for pieces in runs:
            pieces = pieces[::-1] if mostly_rtl(pieces) else pieces       # the PDF draws right-to-left text from its right end; the words are read in that order
            cur = pieces[0]
            for nxt in pieces[1:]:
                cur = join_pieces(cur, nxt, heading_number(cur, nxt) and nxt.x0 - cur.x1 >= 0.8 * min(cur.size, nxt.size))
            out.append(cur)
    return out


LEADER = re.compile(r"(?P<run>\s*(?:[.·…_\-]\s*){4,})(?P<tail>[^\s.·…_\-]\S{0,11}(?:\s\S{1,5})?)\s*$")
LEADERS = {".": "dot", "·": "dot", "…": "dot", "_": "underscore", "-": "hyphen"}


def letter_x(s, i):
    """Where the i-th letter of the span's text starts (the span's right edge for the end). A dot is far narrower than a letter, so a piece's share of the span's width cannot be read from how many characters it holds."""
    t, raw, org = s["text"], s.get("raw"), s.get("org")
    k = raw.find(t) if raw and org else -1
    x0, x1 = s["bbox"][0], s["bbox"][2]
    if k < 0:
        return x0 + (x1 - x0) * i / max(1, len(t))
    return org[k + i][0] if i < len(t) else x1


def cut_span(s, a, b):
    k0 = s["raw"].find(s["text"])
    return dict(s, text=s["text"][a:b], raw=s["raw"][k0 + a:k0 + b], org=s["org"][k0 + a:k0 + b], origin=s["org"][k0 + a],
                bbox=(letter_x(s, a), s["bbox"][1], letter_x(s, b), s["bbox"][3]))


def cut_at_rects(spans, rects):
    """The spans with the letters inside each rectangle (the drawn highlight of a few words) split off as spans of their own."""
    for r in rects:
        out = []
        for s in spans:
            if not (s.get("raw") and s.get("org") and s["raw"].find(s["text"]) >= 0):
                out.append(s)
                continue
            inside = [r.x0 - 0.5 <= (letter_x(s, i) + letter_x(s, i + 1)) / 2 <= r.x1 + 0.5 for i in range(len(s["text"]))]
            cuts = [0] + [i for i in range(1, len(inside)) if inside[i] != inside[i - 1]] + [len(inside)]
            out += [cut_span(s, a, b) for a, b in zip(cuts, cuts[1:])] if len(cuts) > 2 and any(inside) else [s]
        spans = out
    return spans


def cut_at_cells(line, cells):
    """A line that runs from one table cell into the next, because the PDF sets the two on one baseline, is cut where the next cell starts when that falls on a space or between two
    letters, so that each cell holds its own text and none is as wide as the line."""
    cy = (line.y0 + line.y1) / 2
    edges = sorted(c["bbox"][0] for c in cells if c["bbox"][1] <= cy <= c["bbox"][3] and line.x0 < c["bbox"][0] < line.x1)
    if not edges or any(not (s.get("raw") and s.get("org") and s["raw"].find(s["text"]) >= 0) for s in line.spans):
        return [line]
    flat = [(si, i, letter_x(s, i)) for si, s in enumerate(line.spans) for i in range(len(s["text"]))]
    starts, dropped = [], set()
    for x in edges:
        j = max((k for k, (_, _, left) in enumerate(flat) if left <= x + 0.5), default=None)
        if j is None:
            continue
        si, i, left = flat[j]
        if line.spans[si]["text"][i].isspace():
            starts.append(j + 1)
            dropped.add(j)
        elif left >= x - 0.5 and j > 0:
            starts.append(j)
        elif j + 1 < len(flat) and flat[j + 1][2] - left > line.size and x >= left + 0.7 * line.size:
            starts.append(j + 1)
    if not starts:
        return [line]
    group = lambda k: sum(1 for p in starts if p <= k)
    runs = {}
    for k, (si, i, _) in enumerate(flat):
        if k not in dropped:
            runs.setdefault((group(k), si), []).append(i)
    pieces = {}
    for (g, si), idx in sorted(runs.items()):
        pieces.setdefault(g, []).append(cut_span(line.spans[si], idx[0], idx[-1] + 1))
    out = []
    for g in sorted(pieces):
        spans = pieces[g]
        if not any(s["text"].strip() for s in spans):
            continue
        piece = copy.copy(line)
        piece.spans, piece.x0, piece.x1 = spans, spans[0]["bbox"][0], spans[-1]["bbox"][2]
        if out:
            piece.marker = piece.marker_box = piece.cap = None
        out.append(piece)
    return out


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
        cut = lambda i, j: dict(s, text=t[i:j], bbox=(letter_x(s, i), s["bbox"][1], letter_x(s, j), s["bbox"][3]))
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


FIGURE = re.compile(r"[£$€]?\d[\d.,]*%?")


def end_figures(items):
    """Rows made only of texts that each have a figure after them (an index with page numbers, a price list set in columns): the text, a tab and the figure are one line,
    with the tab at the figure's right edge, so that a column of figures keeps its edge whatever the text before it is set in. Three such pairs are needed: a table
    has figures after figures or text after text on its rows and is left to the table code."""
    rows = []
    for l in sorted([i for i in items if i.kind == "line" and not (i.leader or i.marker)], key=lambda l: (l.base, l.x0)):
        if rows and abs(rows[-1][0].base - l.base) <= 0.3 * min(rows[-1][0].size, l.size):
            rows[-1].append(l)
        else:
            rows.append([l])
    pairs = []
    for r in rows:
        r.sort(key=lambda l: l.x0)
        figure = [len(l.text.strip()) <= 12 and bool(FIGURE.fullmatch(l.text.strip())) for l in r]
        if len(r) % 2 == 0 and figure[1::2] == [True] * (len(r) // 2) and not any(figure[0::2]) and not any(l.lead_in for l in r) and all(re.search(r"[^\W\d_]", l.text) for l in r[0::2]) and all(
                b.x0 - a.x1 >= 2.5 * a.size for a, b in zip(r[0::2], r[1::2])):
            pairs += zip(r[0::2], r[1::2])
    if len(pairs) < 3:
        return items
    joined, gone = {}, set()
    for text, fig in pairs:
        tab = {k: v for k, v in text.spans[-1].items() if k not in ("ul", "st", "hl", "link", "field")}
        tab.update(text="	", bbox=(text.x1, text.y0, fig.x0, text.y1))
        line = Line(text.spans + [tab] + fig.spans, (text.x0, min(text.y0, fig.y0), fig.x1, max(text.y1, fig.y1)), text.base, max(text.size, fig.size))
        line.tags = text.tags
        line.block, line.block_x1, line.seq = text.block, text.block_x1, min(text.seq, fig.seq)
        line.leader = ("none", fig.x1)
        line.parts = (text, fig)
        joined[id(text)] = line
        gone.add(id(fig))
    return [joined.get(id(i), i) for i in items if id(i) not in gone]


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
        merged.tags = o.tags
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
        t = spans[0]["text"]
        lead = len(t) - len(t.lstrip())
        text_x0 = letter_x(spans[0], lead)
        if lead and "org" in spans[0]:
            spans[0] = cut_span(spans[0], lead, len(t))
    line.marker_box = (marker_x0, line.y0, max(text_x0, marker_x0 + 1.0), line.y1)
    line.spans = spans
    line.marker = (kind, first, marker_x0, text_x0)
    line.x0 = text_x0

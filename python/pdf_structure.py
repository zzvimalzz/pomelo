# SPDX-License-Identifier: AGPL-3.0-or-later
"""Pomelo helper: PDF -> Markdown, HTML or plain text, keeping all of the text, in reading order, with headings, lists,
tables, links, bold/italic, code and pictures (PyMuPDF, AGPL, run as a separate process).

How it reads a page: lines come from the PDF's text layer; a line that shares its row with another (a title and its date
on the right) becomes one line; columns are found and read one after the other; lines are joined into paragraphs
where the spacing says they belong together; a line is a heading when it is larger than the body text (or a short
bold line of its own), and a list item when it starts with a bullet or a number; ruled tables and the aligned rows of
borderless ones become tables; headers, footers and page numbers that repeat on every page are left out.
"""
import base64
import html as htmllib
import os
import re
from collections import Counter

import pymupdf

from pdf_spans import dedupe, dominant_size

BULLETS = set("•●▪◦·‣⁃■○✓✔❖➢–—-*")
NUMBERED = re.compile(r"^(\(?\d{1,3}[.)]|\(?[a-z][.)])$")
GAP = " "          # an em space: the gap between a title and the date on its right
SENTENCE_END = re.compile(r"[.!?:;”\")\]]\s*$")


# ---- reading a page ------------------------------------------------------------------------------------------------
def style_of(span):
    name = span["font"].lower()
    f = span["flags"]
    return (bool(f & 16) or "bold" in name or "black" in name or "heavy" in name,
            bool(f & 2) or "italic" in name or "oblique" in name,
            bool(f & 8) or any(k in name for k in ("mono", "courier", "consolas", "menlo", "lucida console")))


def rect_overlap(a, b):
    ix, iy = min(a[2], b[2]) - max(a[0], b[0]), min(a[3], b[3]) - max(a[1], b[1])
    return max(0, ix) * max(0, iy)


class Line:
    __slots__ = ("bbox", "runs", "size", "text", "block", "single", "rotated", "bold_all", "mono_all", "page")

    def __init__(self, bbox, runs, size, block, single, rotated=False):
        self.bbox, self.runs, self.size, self.block, self.single, self.rotated = list(bbox), runs, size, block, single, rotated
        self.text = "".join(r[0] for r in runs).strip()
        real = [r for r in runs if r[0].strip()]
        self.bold_all = bool(real) and all(r[1] for r in real)
        self.mono_all = bool(real) and all(r[3] for r in real)

    @property
    def x0(self): return self.bbox[0]
    @property
    def x1(self): return self.bbox[2]
    @property
    def y0(self): return self.bbox[1]
    @property
    def y1(self): return self.bbox[3]


def read_lines(page, links):
    out = []
    blocks = page.get_text("dict")["blocks"]
    for bi, block in enumerate(blocks):
        if block["type"] != 0:
            continue
        single = len([l for l in block["lines"] if any(s["text"].strip() for s in l["spans"])]) == 1
        for line in block["lines"]:
            spans = [s for s in line["spans"] if s["text"] != ""]
            if not any(s["text"].strip() for s in spans):
                continue
            runs = []
            for s in spans:
                link = None
                for rect, uri in links:
                    if rect_overlap(s["bbox"], rect) >= 0.5 * max(1e-6, (s["bbox"][2] - s["bbox"][0]) * (s["bbox"][3] - s["bbox"][1])):
                        link = uri
                        break
                b, i, m = style_of(s)
                runs.append((s["text"], b, i, m, link, s["size"]))
            size = max((r[5] for r in runs if r[0].strip()), default=10)
            rotated = abs(line["dir"][1]) > 0.02 or line["dir"][0] < 0.98
            out.append(Line(line["bbox"], runs, size, (page.number, bi), single, rotated))
    return out


def is_marker_only(l):
    t = l.text
    return 0 < len(t) <= 2 and t[0] in BULLETS or bool(re.fullmatch(r"\(?\d{1,3}[.)]|\(?[a-zA-Z][.)]", t))


def attach_markers(lines):
    """A bullet or number the PDF drew as a line of its own joins the text beside it, so it reads as one list item."""
    out = list(lines)
    for m in [l for l in lines if is_marker_only(l) and not l.rotated]:
        near = [o for o in out if o is not m and not is_marker_only(o) and not o.rotated and abs(o.y1 - m.y1) < 0.45 * m.size + 1.5
                and 0 <= o.x0 - m.x1 < 3.5 * m.size]
        if near:
            o = min(near, key=lambda o: o.x0 - m.x1)
            o.runs = [(m.text, False, False, False, None, m.size), ("\t", False, False, False, None, m.size)] + o.runs
            o.bbox[0] = m.x0
            o.text = ("".join(r[0] for r in o.runs)).replace("\t", " ").strip()
            out.remove(m)
    return out


def merge_rows(lines):
    """A title and its date on the right become one line, the gap kept as an em space. Lines side by side that go on
    side by side on the next row are columns, and stay apart."""
    lines = sorted(lines, key=lambda l: (round(l.y0 / 2), l.x0))

    def column_member(b):                  # does b share its left edge with other lines? then it is a column, not a stray date
        return sum(1 for o in lines if o is not b and abs(o.x0 - b.x0) < 3 and abs(o.y0 - b.y0) < 400) >= 2

    out = []
    for l in lines:
        prev = out[-1] if out else None
        if (prev and not prev.rotated and not l.rotated
                and min(prev.y1, l.y1) - max(prev.y0, l.y0) > 0.6 * min(prev.y1 - prev.y0, l.y1 - l.y0)
                and l.x0 - prev.x1 > 0.5 * min(prev.size, l.size) and not column_member(l)):
            gap = [(GAP, False, False, False, None, prev.size)] if l.x0 - prev.x1 > 1.5 * min(prev.size, l.size) else [(" ", False, False, False, None, prev.size)]
            out[-1] = Line((prev.x0, min(prev.y0, l.y0), l.x1, max(prev.y1, l.y1)), prev.runs + gap + l.runs, max(prev.size, l.size), prev.block, True)
        else:
            out.append(l)
    return out


def stack_lines(lines):
    """Lines that run on from one another (same left edge, normal leading) form a unit: a paragraph, a list, a column."""
    stacks = []
    for l in sorted(lines, key=lambda l: (l.y0, l.x0)):
        best = None
        for s in stacks:
            last, first = s["items"][-1], s["items"][0]
            dy = l.y0 - last.y0
            if not (0.7 * last.size < dy < 2.4 * max(last.size, l.size)) or abs(l.size - last.size) > 3.5 or l.x0 >= last.x1:
                continue
            aligned = abs(l.x0 - last.x0) < 3 + 0.3 * last.size or abs(l.x0 - first.x0) < 3 or (last.x0 < l.x0 < last.x0 + 40 and classify(first) is not None) \
                or (l.x0 > last.x0 and l.x0 - last.x0 < 2.5 * last.size)
            if aligned and (best is None or dy < best[0]):
                best = (dy, s)
        if best:
            s = best[1]
            s["items"].append(l)
            b = s["bbox"]
            s["bbox"] = [min(b[0], l.x0), min(b[1], l.y0), max(b[2], l.x1), max(b[3], l.y1)]
            s["lines"] += 1
        else:
            stacks.append({"items": [l], "bbox": list(l.bbox), "lines": 1, "kind": "text"})
    return stacks


# ---- tables and pictures ---------------------------------------------------------------------------------------------
def clean_cell(c):
    return " ".join((c or "").split())


def good_text_table(rows, width, page_width):
    if len(rows) < 3 or width < 0.4 * page_width:
        return False
    cols = max(len(r) for r in rows)
    if cols < 2 or cols > 12:
        return False
    filled = [sum(1 for c in r if c) for r in rows]
    if sum(1 for n in filled if n >= 2) < 0.7 * len(rows):
        return False
    cells = [c for r in rows for c in r if c]
    return bool(cells) and sum(len(c) for c in cells) / len(cells) < 40


def find_tables(page):
    found = []
    try:
        for t in page.find_tables().tables:
            rows = [[clean_cell(c) for c in r] for r in t.extract()]
            if any(any(r) for r in rows):
                found.append((pymupdf.Rect(t.bbox), rows))
    except Exception:
        pass
    if found:
        return found
    try:
        for t in page.find_tables(strategy="text").tables:
            rows = [[clean_cell(c) for c in r] for r in t.extract()]
            rows = [r for r in rows if any(r)]
            if good_text_table(rows, t.bbox[2] - t.bbox[0], page.rect.width):
                found.append((pymupdf.Rect(t.bbox), rows))
    except Exception:
        pass
    return found


def trusted_tables(tables, lines):
    """A table is believed only if its cells hold what the page text inside its box holds: nothing lost, nothing made up.
    (The table finder reads alignment too eagerly: a résumé's whole body can look like a grid.)"""
    ok = []
    for rect, rows in tables:
        inside = Counter()
        for l in lines:
            cx, cy = (l.x0 + l.x1) / 2, (l.y0 + l.y1) / 2
            if rect.x0 - 1 <= cx <= rect.x1 + 1 and rect.y0 - 1 <= cy <= rect.y1 + 1:
                inside.update(re.findall(r"\w+", l.text.lower()))
        cells = Counter()
        for r in rows:
            for c in r:
                cells.update(re.findall(r"\w+", c.lower()))
        hit = sum((inside & cells).values())
        if inside and hit / sum(inside.values()) >= 0.92 and hit / max(1, sum(cells.values())) >= 0.92:
            ok.append((rect, rows))
    return ok


class Pictures:
    """Pictures worth keeping: not tiny, not a page-sized background, and not a logo repeated on every page."""

    def __init__(self, doc):
        self.doc = doc
        self.seen = Counter()
        for page in doc:
            for info in page.get_image_info(xrefs=True):
                if info.get("xref"):
                    self.seen[info["xref"]] += 1
        self.count = 0

    def on_page(self, page, has_text):
        found = []
        for info in page.get_image_info(xrefs=True):
            r = pymupdf.Rect(info["bbox"])
            xref = info.get("xref")
            if not xref or r.width < 24 or r.height < 24:
                continue
            if has_text and r.width * r.height > 0.8 * page.rect.width * page.rect.height:
                continue
            if self.seen[xref] > 2 and len(self.doc) > 2:
                continue
            data = self.encode(page, xref, r)
            if data:
                found.append((r, data))
        return found

    def encode(self, page, xref, rect):
        try:
            pix = pymupdf.Pixmap(self.doc, xref)
            smask = self.doc.extract_image(xref).get("smask", 0)
            if smask:
                pix = pymupdf.Pixmap(pix, pymupdf.Pixmap(self.doc, smask))
            if pix.colorspace and pix.colorspace.n > 3:
                pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
            if pix.width * pix.height > 4_000_000:
                pix.shrink(1)
            raw = self.doc.extract_image(xref)
            if raw["ext"] in ("jpeg", "jpg") and not smask and raw.get("colorspace", 3) in (1, 3):
                return raw["image"], "jpg"
            return pix.tobytes("png"), "png"
        except Exception:
            return None


# ---- building the document -------------------------------------------------------------------------------------------
def body_size(all_lines):
    return dominant_size((r[0], r[5]) for l in all_lines for r in l.runs)


def order_units(units, page):
    """Reading order for a page's units (each has .bbox): single column top to bottom; several columns one after another."""
    if len(units) < 3:
        return sorted(units, key=lambda u: (u["bbox"][1], u["bbox"][0]))
    xs0 = min(u["bbox"][0] for u in units)
    xs1 = max(u["bbox"][2] for u in units)
    width = max(1, xs1 - xs0)
    tall = [u for u in units if u["lines"] >= 2 and (u["bbox"][2] - u["bbox"][0]) < 0.6 * width]
    cols = []
    for u in sorted(tall, key=lambda u: u["bbox"][0]):
        for c in cols:
            if abs(c["x0"] - u["bbox"][0]) < 0.08 * width:
                c["units"].append(u)
                break
        else:
            cols.append({"x0": u["bbox"][0], "units": [u]})
    cols = [c for c in cols if len(c["units"]) >= 2]
    if len(cols) < 2:
        return sorted(units, key=lambda u: (u["bbox"][1], u["bbox"][0]))
    cols.sort(key=lambda c: c["x0"])
    members = {id(u) for c in cols for u in c["units"]}
    top = min(u["bbox"][1] for c in cols for u in c["units"])
    bottom = max(u["bbox"][3] for c in cols for u in c["units"])
    before = sorted([u for u in units if id(u) not in members and u["bbox"][3] <= top + 2], key=lambda u: (u["bbox"][1], u["bbox"][0]))
    after = sorted([u for u in units if id(u) not in members and u["bbox"][1] >= bottom - 2], key=lambda u: (u["bbox"][1], u["bbox"][0]))
    rest = [u for u in units if id(u) not in members and u not in before and u not in after]
    for u in rest:                                          # inside the columns' span: join the nearest column
        cx = (u["bbox"][0] + u["bbox"][2]) / 2
        min(cols, key=lambda c: abs(c["x0"] - cx))["units"].append(u)
    out = list(before)
    for c in cols:
        out += sorted(c["units"], key=lambda u: u["bbox"][1])
    return out + after


def classify(line):
    """('bullet', rest runs) / ('number', ...) / None"""
    runs = line.runs
    text = line.text
    if not text:
        return None
    first = text.split()[0]
    if len(first) <= 2 and first[0] in BULLETS and (len(text) > len(first)) and (first[0] not in "-–—*" or text[len(first):len(first) + 1].isspace()):
        return "bullet"
    if len(text) > len(first) and NUMBERED.match(first) and (first[0] == "(" or first[-1] in ".)"):
        return "number"
    return None


def strip_marker(line):
    """The line's runs without the leading bullet or number."""
    runs, dropped = [], False
    for r in line.runs:
        if not dropped:
            t = r[0].lstrip()
            if not t:
                continue
            first = t.split()[0]
            t = t[len(first):].lstrip()
            dropped = True
            if t:
                runs.append((t,) + r[1:])
            continue
        runs.append(r)
    return runs


def trim(runs):
    runs = [list(r) for r in runs]
    while runs and not runs[0][0].strip():
        runs.pop(0)
    while runs and not runs[-1][0].strip():
        runs.pop()
    if runs:
        runs[0][0] = runs[0][0].lstrip()
        runs[-1][0] = runs[-1][0].rstrip()
    return [tuple(r) for r in runs]


def join_runs(a, b):
    """Two lines of one paragraph: a space between them, or nothing after a hyphen at the line end."""
    a, b = trim(a), trim(b)
    if a and b and a[-1][0].endswith("-") and len(a[-1][0]) > 2 and a[-1][0][-2].isalpha() and b[0][0][:1].islower():
        a = a[:-1] + [(a[-1][0][:-1],) + a[-1][1:]]
        return a + b
    return a + [(" ", False, False, False, None, 0)] + b


def build(doc, progress):
    links_by_page = []
    all_lines = []
    pages = []
    pictures = Pictures(doc)
    for page in doc:
        links = [(pymupdf.Rect(l["from"]), l["uri"]) for l in page.get_links() if l.get("uri")]
        lines = read_lines(page, links)
        pages.append((page, lines))
        all_lines += [l for l in lines if not l.rotated]
        links_by_page.append(links)
    body = body_size(all_lines)

    # headers, footers and page numbers
    repeated = set()
    if len(doc) >= 3:
        counts = Counter()
        for page, lines in pages:
            seen = set()
            for l in lines:
                if l.y1 < page.rect.height * 0.08 or l.y0 > page.rect.height * 0.92:
                    key = re.sub(r"\d+", "#", l.text)
                    if key not in seen:
                        seen.add(key)
                        counts[key] += 1
        repeated = {k for k, n in counts.items() if n >= max(3, 0.5 * len(doc))}

    heading_sizes = set()
    for l in all_lines:
        if l.size >= body * 1.18 and len(l.text) <= 120 and not classify(l):
            heading_sizes.add(round(l.size * 2) / 2)
    levels = {s: min(i + 1, 4) for i, s in enumerate(sorted(heading_sizes, reverse=True))}

    blocks = []
    for pno, (page, lines) in enumerate(pages):
        progress(pno / len(pages))
        lines = [l for l in lines if not (l.y1 < page.rect.height * 0.08 or l.y0 > page.rect.height * 0.92) or re.sub(r"\d+", "#", l.text) not in repeated]
        lines = [l for l in lines if not (re.fullmatch(r"\d{1,3}", l.text) and (l.y1 < page.rect.height * 0.08 or l.y0 > page.rect.height * 0.92))]

        tables = trusted_tables(find_tables(page), lines)
        keep, in_table = [], []
        for l in lines:
            cx, cy = (l.x0 + l.x1) / 2, (l.y0 + l.y1) / 2
            (in_table if any(r.x0 - 1 <= cx <= r.x1 + 1 and r.y0 - 1 <= cy <= r.y1 + 1 for r, _ in tables) else keep).append(l)
        upright = merge_rows(attach_markers(dedupe([l for l in keep if not l.rotated], 4)))
        rotated = dedupe([l for l in keep if l.rotated], 4)

        # units: lines that run on from one another (a paragraph, a list, a column)
        units = stack_lines(upright)
        for r, rows in tables:
            if len(rows) < 2 or max(len(x) for x in rows) < 2:          # a one-row or one-column "table" is a boxed paragraph
                text = " ".join(c for x in rows for c in x if c)
                units.append({"block": None, "items": [], "bbox": list(r), "lines": 1, "kind": "note", "text": text})
                continue
            units.append({"block": None, "items": [], "bbox": list(r), "lines": max(2, len(rows)), "kind": "table", "rows": rows})
        for r, data in pictures.on_page(page, bool(upright)):
            units.append({"block": None, "items": [], "bbox": list(r), "lines": 1, "kind": "image", "data": data})
        ordered = order_units(units, page)

        page_blocks = []
        for u in ordered:
            if u["kind"] == "table":
                page_blocks.append({"type": "table", "rows": u["rows"]})
            elif u["kind"] == "note":
                page_blocks.append({"type": "para", "runs": [(u["text"], False, False, False, None, body)]})
            elif u["kind"] == "image":
                page_blocks.append({"type": "image", "data": u["data"][0], "ext": u["data"][1], "page": pno + 1})
            else:
                page_blocks += paragraphs(u["items"], body, levels)
        for l in sorted(rotated, key=lambda l: (l.y0, l.x0)):
            page_blocks.append({"type": "para", "runs": trim(l.runs)})
        page_blocks = [b for b in page_blocks if b["type"] != "para" or b["runs"]]
        # a paragraph that carries on over the page break
        if blocks and page_blocks and blocks[-1]["type"] == "para" and page_blocks[0]["type"] == "para":
            last, first = blocks[-1], page_blocks[0]
            lt = "".join(r[0] for r in last["runs"])
            ft = "".join(r[0] for r in first["runs"]).lstrip()
            if lt and not SENTENCE_END.search(lt) and ft[:1].islower():
                last["runs"] = join_runs(last["runs"], first["runs"])
                page_blocks.pop(0)
        blocks += page_blocks
    progress(0.97)
    return blocks, body


def paragraphs(lines, body, levels):
    out = []
    cur = None                  # the paragraph or list item being filled: {"type", "runs", "last"}
    for i, l in enumerate(lines):
        kind = classify(l)
        size = round(l.size * 2) / 2
        # larger text is a heading when it is clearly larger, bold, or a line standing alone (not a lead-in paragraph)
        is_head = size in levels and len(l.text) <= 120 and not kind and (l.size >= body * 1.4 or l.bold_all or len(lines) == 1)
        if not is_head and l.bold_all and not kind and len(l.text) <= 70 and l.size >= body * 1.04 and not l.mono_all:
            nxt = lines[i + 1] if i + 1 < len(lines) else None
            if nxt is None or nxt.y0 - l.y1 > 0.35 * l.size or classify(nxt):
                is_head, size = True, None
        if is_head:
            level = levels.get(size, 3) if size else 3
            runs = [(r[0], False) + r[2:] for r in trim(l.runs)]
            prev = out[-1] if out else None
            if prev and prev["type"] == "heading" and prev["level"] == level and l.y0 - prev["y1"] < 1.3 * l.size:
                prev["runs"] = join_runs(prev["runs"], runs)          # a heading that wrapped onto a second line
                prev["y1"] = l.y1
            else:
                out.append({"type": "heading", "level": level, "runs": runs, "y1": l.y1})
            cur = None
            continue
        if l.mono_all and body * 1.4 > l.size:
            if out and out[-1]["type"] == "code" and l.y0 - cur_y1(out[-1]) < 1.8 * l.size:
                out[-1]["lines"].append(l.text)
                out[-1]["y1"] = l.y1
            else:
                out.append({"type": "code", "lines": [l.text], "y1": l.y1})
            cur = None
            continue
        if kind:
            cur = {"type": "item", "ordered": kind == "number", "marker": l.text.split()[0], "runs": trim(strip_marker(l)), "x0": l.x0, "y1": l.y1, "size": l.size}
            out.append(cur)
            continue
        if cur and l.y0 - cur["y1"] < 1.5 * l.size and abs(l.size - cur["size"]) < 1.5 and (cur["type"] == "item" and l.x0 > cur["x0"] - 2 or cur["type"] == "para" and abs(l.x0 - cur["x0"]) < 4 + 0.6 * l.size):
            cur["runs"] = join_runs(cur["runs"], l.runs)
            cur["y1"] = l.y1
            continue
        cur = {"type": "para", "runs": trim(l.runs), "x0": l.x0, "y1": l.y1, "size": l.size}
        out.append(cur)
    return out


def cur_y1(block):
    return block.get("y1", 0)


# ---- writing -----------------------------------------------------------------------------------------------------------
def md_escape(t):
    t = t.replace("\\", "\\\\")
    for ch in "*_`[]<>|":
        t = t.replace(ch, "\\" + ch)
    return t


def merge_runs(runs):
    out = []
    for r in runs:
        if out and out[-1][1:5] == r[1:5]:
            out[-1] = (out[-1][0] + r[0],) + out[-1][1:]
        else:
            out.append(r)
    return out


def md_inline(runs, plain_style=False):
    out = ""
    for text, bold, ital, mono, link, *_ in merge_runs(runs):
        if not text.strip():
            out += text
            continue
        lead, core, tail = re.match(r"^(\s*)(.*?)(\s*)$", text, re.S).groups()
        t = f"`{core}`" if mono else md_escape(core)
        if not plain_style:
            if bold and ital and not mono:
                t = f"***{t}***"
            elif bold and not mono:
                t = f"**{t}**"
            elif ital and not mono:
                t = f"*{t}*"
        if link:
            t = f"[{t}]({link})"
        out += lead + t + tail
    return out.replace(GAP, " " + GAP + " ").replace("  ", " ")


def html_inline(runs):
    out = ""
    for text, bold, ital, mono, link, *_ in merge_runs(runs):
        if not text.strip():
            out += htmllib.escape(text)
            continue
        lead, core, tail = re.match(r"^(\s*)(.*?)(\s*)$", text, re.S).groups()
        t = htmllib.escape(core)
        if mono:
            t = f"<code>{t}</code>"
        if bold:
            t = f"<strong>{t}</strong>"
        if ital:
            t = f"<em>{t}</em>"
        if link:
            t = f'<a href="{htmllib.escape(link, quote=True)}">{t}</a>'
        out += htmllib.escape(lead) + t + htmllib.escape(tail)
    return out


def plain_inline(runs):
    return "".join(r[0] for r in runs).replace(GAP, "  ")


def group_lists(blocks):
    out = []
    for b in blocks:
        if b["type"] == "item":
            if out and out[-1]["type"] == "list" and out[-1]["ordered"] == b["ordered"]:
                out[-1]["items"].append(b)
            else:
                out.append({"type": "list", "ordered": b["ordered"], "items": [b]})
        else:
            out.append(b)
    return out


def write_md(blocks, images_dir):
    parts, n = [], 0
    for b in group_lists(blocks):
        t = b["type"]
        if t == "heading":
            parts.append("#" * b["level"] + " " + md_inline(b["runs"], True))
        elif t == "para":
            text = md_inline(b["runs"])
            text = re.sub(r"^(\d+)\.(\s)", r"\1\\.\2", re.sub(r"^([#>+-])(\s)", r"\\\1\2", text))
            parts.append(text)
        elif t == "list":
            lines = []
            for i, it in enumerate(b["items"]):
                m = (re.sub(r"[.)]$", "", it["marker"]) if it["ordered"] else "-")
                lines.append((f"{m}. " if it["ordered"] and m.isdigit() else ("- " if it["ordered"] else "- ")) + md_inline(it["runs"]))
            parts.append("\n".join(lines))
        elif t == "table":
            rows = [[c.replace("|", "\\|") for c in r] for r in b["rows"]]
            width = max(len(r) for r in rows)
            rows = [r + [""] * (width - len(r)) for r in rows]
            parts.append("\n".join(["| " + " | ".join(rows[0]) + " |", "|" + "---|" * width] + ["| " + " | ".join(r) + " |" for r in rows[1:]]))
        elif t == "code":
            parts.append("```\n" + "\n".join(b["lines"]) + "\n```")
        elif t == "image" and images_dir:
            os.makedirs(images_dir, exist_ok=True)
            n += 1
            name = f"image-{n}.{b['ext']}"
            with open(os.path.join(images_dir, name), "wb") as f:
                f.write(b["data"])
            parts.append(f"![Image on page {b['page']}]({os.path.basename(images_dir).replace(' ', '%20')}/{name})")
    return "\n\n".join(parts) + "\n"


def write_html(blocks, title):
    out = []
    for b in group_lists(blocks):
        t = b["type"]
        if t == "heading":
            out.append(f"<h{b['level']}>{html_inline(b['runs'])}</h{b['level']}>")
        elif t == "para":
            out.append(f"<p>{html_inline(b['runs'])}</p>")
        elif t == "list":
            tag = "ol" if b["ordered"] else "ul"
            out.append(f"<{tag}>" + "".join(f"<li>{html_inline(i['runs'])}</li>" for i in b["items"]) + f"</{tag}>")
        elif t == "table":
            rows = b["rows"]
            width = max(len(r) for r in rows)
            head = "<tr>" + "".join(f"<th>{htmllib.escape(c)}</th>" for c in rows[0] + [""] * (width - len(rows[0]))) + "</tr>"
            body = "".join("<tr>" + "".join(f"<td>{htmllib.escape(c)}</td>" for c in r + [""] * (width - len(r))) + "</tr>" for r in rows[1:])
            out.append(f"<table>{head}{body}</table>")
        elif t == "code":
            out.append("<pre><code>" + htmllib.escape("\n".join(b["lines"])) + "</code></pre>")
        elif t == "image":
            mime = "image/jpeg" if b["ext"] == "jpg" else "image/png"
            out.append(f'<p><img src="data:{mime};base64,{base64.b64encode(b["data"]).decode()}" alt="Image on page {b["page"]}"/></p>')
    css = ("body{font:16px/1.55 system-ui,'Segoe UI',sans-serif;max-width:46em;margin:2em auto;padding:0 1em;color:#1a1a1a}"
           "h1,h2,h3,h4{line-height:1.25}img{max-width:100%;height:auto}table{border-collapse:collapse;margin:1em 0}"
           "td,th{border:1px solid #bbb;padding:.3em .6em;vertical-align:top}th{background:#f1f1f1;text-align:left}"
           "pre{background:#f5f5f5;padding:.7em;overflow:auto}code{font-family:Consolas,monospace}")
    return ('<!doctype html>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"/><title>' + htmllib.escape(title) +
            "</title><style>" + css + "</style></head><body>\n" + "\n".join(out) + "\n</body></html>\n")


def write_txt(blocks):
    parts = []
    for b in group_lists(blocks):
        t = b["type"]
        if t in ("heading", "para"):
            parts.append(plain_inline(b["runs"]))
        elif t == "list":
            parts.append("\n".join(("• " if not it["ordered"] else it["marker"] + " ") + plain_inline(it["runs"]) for it in b["items"]))
        elif t == "table":
            parts.append("\n".join("\t".join(r) for r in b["rows"]))
        elif t == "code":
            parts.append("\n".join(b["lines"]))
    return "\n\n".join(parts) + "\n"


def read(path, progress):
    """The PDF at `path` as blocks, and its title if it has one; the document is closed again before this returns."""
    with pymupdf.open(path) as doc:
        blocks, _ = build(doc, progress)
        return blocks, (doc.metadata or {}).get("title")

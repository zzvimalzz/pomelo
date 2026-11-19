# SPDX-License-Identifier: AGPL-3.0-or-later
"""Built-up mathematics: pieces stacked on several baselines (a fraction, a root, a sum with limits, a matrix) cannot be laid out as lines of text, so each such equation
becomes one inline picture cut from the page, with its own text kept after it as hidden text."""

import io
import re

import pymupdf

from pdf_fonts import math_font

from .common import HI_DPI, inside
from .lines import Line

MATH_NAME = re.compile(r"CMMI|CMSY|CMEX|MSAM|MSBM|LMMath|Math", re.I)
WORD = re.compile(r"[^\W\d_]{3}")
MAX_PIXELS = 6e6      # a picture of one equation is never larger than a few hundred points a side; a crafted page must not ask for a whole sheet at high resolution
TAG = re.compile(r"\(\s*[\w.\-]{1,8}\s*\)")


def math_span(s):
    return math_font(s["font"], s["text"]) or bool(MATH_NAME.search(re.sub(r"^[A-Z]{6}\+", "", s["font"])))


def prose_span(s):
    return not math_span(s) and bool(WORD.search(s["text"]))


def is_prose(l):
    return any(prose_span(s) for s in l.spans)


class Bar:
    """A fraction bar or the top of a root: a short horizontal stroke."""
    def __init__(self, a, b, pos):
        self.x0, self.x1, self.y0, self.y1, self.base = a, b, pos - 0.5, pos + 0.5, pos


def linked(a, b, gap):
    """Two things that belong together: two pieces side by side or one over the other that overlap in height, or a bar and a piece that overlaps it in width and has it
    within a third of its size of its top or bottom edge."""
    if isinstance(a, Bar) or isinstance(b, Bar):
        bar, piece = (a, b) if isinstance(a, Bar) else (b, a)
        return isinstance(piece, Line) and min(bar.x1, piece.x1) > max(bar.x0, piece.x0) and piece.y0 - 0.33 * piece.size <= bar.base <= piece.y1 + 0.33 * piece.size
    across = min(a.y1, b.y1) - max(a.y0, b.y0)
    return max(a.x0, b.x0) - min(a.x1, b.x1) <= gap and across > -0.25 * min(a.size, b.size)


def components(items, gap):
    """The pieces and bars joined into groups by `linked`."""
    items = sorted(items, key=lambda i: i.y0)
    parent = list(range(len(items)))

    def root(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    for i, a in enumerate(items):
        for j in range(i + 1, len(items)):
            if items[j].y0 > a.y1 + gap:
                break
            if linked(a, items[j], gap):
                parent[root(j)] = root(i)
    groups = {}
    for i, l in enumerate(items):
        groups.setdefault(root(i), []).append(l)
    return list(groups.values())


def built_up(lines, body):
    """More than one baseline, and a font of mathematical symbols among them."""
    bases = sorted(l.base for l in lines)
    return len(bases) > 1 and bases[-1] - bases[0] > 0.15 * body and any(math_span(s) for l in lines for s in l.spans)


def main_baseline(group, body):
    """The baseline that carries most of the equation's width: where the text before and after it stands, and where its number is."""
    rows = []
    for l in sorted(group, key=lambda l: l.base):
        if rows and l.base - rows[-1][-1].base <= 0.15 * body:
            rows[-1].append(l)
        else:
            rows.append([l])
    best = max(rows, key=lambda r: (sum(l.x1 - l.x0 for l in r), max(l.size for l in r)))
    return sum(l.base for l in best) / len(best), max(l.size for l in best)


def reach(spans, a, b, gap):
    """The spans of the row that belong to the equation: those standing inside [a, b] and, on each side, the ones next to it that are not words. -> (the spans, a, b), or None
    when a word stands inside the range."""
    centre = lambda s: (s["bbox"][0] + s["bbox"][2]) / 2
    taken = {id(s) for s in spans if a <= centre(s) <= b}
    if any(prose_span(s) for s in spans if id(s) in taken):
        return None
    for side in (-1, 1):
        while True:
            near = [s for s in spans if id(s) not in taken and s["text"].strip() and -0.5 <= (a - s["bbox"][2] if side < 0 else s["bbox"][0] - b) <= gap]
            if not near:
                break
            s = min(near, key=lambda s: a - s["bbox"][2] if side < 0 else s["bbox"][0] - b)
            if prose_span(s):
                break
            taken.add(id(s))
            a, b = min(a, s["bbox"][0]), max(b, s["bbox"][2])
    return [s for s in spans if id(s) in taken or a <= centre(s) <= b], a, b


def inline_run(pic):
    """The run that holds the picture: inline, lowered so that the equation's main baseline lies on the line's."""
    rid, pid, cx, cy, drop, alt = pic
    graphic = (f'<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="{pid}" name="Equation {pid}"/>'
               f'<pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
               f'<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>')
    return (f'<w:r><w:rPr><w:position w:val="{-round(2 * drop)}"/></w:rPr><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="{cx}" cy="{cy}"/>'
            f'<wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="{pid}" name="Equation {pid}"/><wp:cNvGraphicFramePr/>{graphic}</wp:inline></w:drawing></w:r>')


def picture(page, clip, mine):
    """-> (the clip of the page as a PNG, the clip cut down to the rows that hold ink). Clear where nothing is drawn, so that the text a tall glyph overlaps shows through, and with
    the letters of other lines painted out: the box of a big integral sign reaches into the lines above and below, and their letters would show. `mine` are the spans of the equation."""
    k = HI_DPI / 72
    ours = lambda s: any(abs(s["origin"][0] - m["origin"][0]) < 0.6 and abs(s["origin"][1] - m["origin"][1]) < 0.6 and s["font"] == m["font"] for m in mine)

    def render(clip):
        pix = page.get_pixmap(dpi=HI_DPI, clip=clip, alpha=True)
        for block in page.get_text("rawdict", clip=clip)["blocks"]:
            for line in block.get("lines", ()):
                for s in line["spans"]:
                    if ours(s):
                        continue
                    for c in s["chars"]:
                        x0, x1 = max(c["bbox"][0], clip.x0), min(c["bbox"][2], clip.x1)
                        y0, y1 = max(c["origin"][1] - 0.78 * s["size"], clip.y0), min(c["origin"][1] + 0.22 * s["size"], clip.y1)
                        if x1 > x0 and y1 > y0:
                            pix.set_rect(pymupdf.IRect(int((x0 - clip.x0) * k), int((y0 - clip.y0) * k), int((x1 - clip.x0) * k) + 1, int((y1 - clip.y0) * k) + 1), (255, 255, 255, 0))
        return pix
    pix = render(clip)
    alpha = pix.samples[3::4]
    inked = [max(alpha[y * pix.width:(y + 1) * pix.width], default=0) > 24 for y in range(pix.height)]
    if any(inked):
        top, bottom = inked.index(True), len(inked) - inked[::-1].index(True)
        trimmed = pymupdf.Rect(clip.x0, clip.y0 + max(0, top - 1) / k, clip.x1, clip.y0 + min(pix.height, bottom + 1) / k)
        if trimmed.height < clip.height - 1:
            clip, pix = trimmed, render(trimmed)
    return pix.tobytes("png"), clip


def equations(P, part, ids):
    """Replaces the built-up equations among the lines of the page by inline pictures. A picture goes into the line of text that stands on the equation's main baseline, taking
    the spans of the equation out of it; with no such line it is a line of its own."""
    body = P.body
    candidates = [l for l in P.upright if not any(inside(l.bbox, t.bbox, 0.5) for t in P.tbls)]
    pieces = [l for l in candidates if not is_prose(l)]
    hosts = [l for l in candidates if is_prose(l)]
    bars = [Bar(a, b, pos) for o, pos, a, b, width, *_ in P.segments if o == "h" and width <= 1.5 and 6 <= b - a <= 0.5 * P.w]
    gone = set()
    for group in components(pieces + bars, 0.6 * body):
        lines = [i for i in group if isinstance(i, Line)]
        if not built_up(lines, body):
            continue
        base, size = main_baseline(lines, body)
        a, b = min(i.x0 for i in group), max(i.x1 for i in group)
        gap = 0.6 * size
        tag = next((l for l in pieces if id(l) not in gone and l.x0 > b + gap and min(i.y0 for i in group) <= l.base <= max(i.y1 for i in group) and TAG.fullmatch(l.text.strip())), None)
        if tag:
            base = tag.base
        beside = [h for h in hosts if id(h) not in gone and h.x1 >= a - gap and h.x0 <= b + gap and abs(h.base - base) <= 0.8 * h.size]
        if beside:
            nearest = min(beside, key=lambda h: abs(h.base - base))
            base, size = nearest.base, nearest.size
        row = [h for h in hosts if id(h) not in gone and abs(h.base - base) <= 0.3 * h.size]
        found = reach([s for h in row for s in h.spans], a, b, gap)
        if found is None:
            continue
        taken, a, b = found
        y0 = min([i.y0 for i in group] + [s["bbox"][1] for s in taken])
        y1 = max([i.y1 for i in group] + [s["bbox"][3] for s in taken])
        clip = pymupdf.Rect(a - 0.5, y0 - 0.5, b + 0.5, y1 + 0.5) & P.page.rect
        if clip.is_empty or clip.width * clip.height * (HI_DPI / 72) ** 2 > MAX_PIXELS:
            continue
        ours = {id(s) for s in taken}
        spans = sorted([s for l in lines for s in l.spans] + taken, key=lambda s: (s["bbox"][0], s["bbox"][1]))
        png, clip = picture(P.page, clip, spans)
        main = max(spans, key=lambda s: s["size"])
        pic = dict(main, text="\ufffc", bbox=tuple(clip), origin=(clip.x0, base), pic=(part.get_or_add_image(io.BytesIO(png))[0], next(ids), round(clip.width * 12700), round(clip.height * 12700),
                                                                                     max(0.0, clip.y1 - base), [dict(s, hidden=True, text=s["text"].rstrip() + " ") for s in spans]))
        near = sorted([h for h in row if any(id(s) in ours for s in h.spans) or h.x1 >= a - gap and h.x0 <= b + gap], key=lambda h: h.x0)
        if near:
            host = near[0]
            kept = [s for h in near for s in h.spans if id(s) not in ours]
            host.spans = sorted(kept + [pic], key=lambda s: s["bbox"][0])
            if not kept:
                host.size = size
            host.x0, host.x1 = min(h.x0 for h in near), max(h.x1 for h in near)
            host.y0, host.y1 = min([h.y0 for h in near] + [clip.y0]), max([h.y1 for h in near] + [clip.y1])
            host.parts += tuple(x for h in near[1:] for x in (h, *h.parts))
            gone.update(id(h) for h in near[1:])
        else:
            host = Line([pic], tuple(clip), base, size)
            host.seq = min(l.seq for l in lines)
            host.block = lines[0].block
            P.upright.append(host)
        if tag and host.spans[-1] is pic and not any(m is not tag and m is not host and abs(m.base - base) <= 0.3 * size and clip.x1 < m.x0 < tag.x0 for m in candidates):
            host.spans += [dict(main, text="\t", bbox=(clip.x1, clip.y0, tag.x0, clip.y1))] + tag.spans
            host.x1 = tag.x1
            host.parts += (tag, *tag.parts)
            gone.add(id(tag))
        gone.update(id(l) for l in lines)
        P.maths.append(tuple(clip))
        P.used_segments.update(i for i, (o, pos, sa, sb, *_) in enumerate(P.segments) if inside((sa, pos, sb, pos) if o == "h" else (pos, sa, pos, sb), tuple(clip), 1.5))
    P.upright = [l for l in P.upright if id(l) not in gone]

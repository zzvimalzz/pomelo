# SPDX-License-Identifier: AGPL-3.0-or-later
"""Exact-position PDF -> DOCX, for pages that cannot be rebuilt as flowing text (designed pages, columns, text over
pictures, shapes, stamps). Used by pdf2docx_run.py when a page is too complex for a flowing rebuild.

Each page becomes one Word section of the same size, made of two layers:
  * a background picture behind the text: the page exactly as it looks with its text taken out (pictures, shapes,
    gradients, rules, backgrounds). A page with nothing but text gets no picture at all.
  * the text itself, as real, editable text: one frame per run of text, placed at the position, font, size, colour,
    bold and italic it has in the PDF, with the word spacing of justified lines kept.
Text that cannot be reproduced faithfully (right-to-left, rotated, symbol fonts) is left in the picture instead of
being re-typed wrongly, so it still looks right.
"""
import re
import sys

import pymupdf
from docx import Document
from docx.opc.constants import RELATIONSHIP_TYPE  # noqa: F401  (kept for parity with the flowing path)
from docx.oxml import parse_xml
from docx.oxml.ns import nsdecls, qn
from docx.shared import Emu

from pdf_fonts import word_family

TW = 20  # twips per point
PUA_OK = {"", "", "", "", ""}   # the bullets Word itself writes in Symbol/Wingdings
BAD_XML = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]")
RTL = re.compile(r"[֐-ࣿיִ-﷿ﹰ-﻿]")
BG_DPI = 200


def esc(s):
    return BAD_XML.sub("", s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def hexcolor(c):
    return "%02X%02X%02X" % ((c >> 16) & 255, (c >> 8) & 255, c & 255)


def span_ok(line, span):
    dx, dy = line["dir"]
    if abs(dy) > 0.02 or dx < 0.98:
        return False                      # rotated
    t = span["text"]
    if not t.strip() or span["size"] < 3:
        return False
    if RTL.search(t):
        return False                      # right-to-left stays in the picture, exactly as drawn
    if any(0xE000 <= ord(c) <= 0xF8FF and c not in PUA_OK for c in t):
        return False                      # symbol-font glyphs with no Unicode meaning
    return True


class FontMeter:
    """Natural width of a string in the PDF's own font, to spread justified lines the way the PDF did."""

    def __init__(self, doc):
        self.doc = doc
        self.cache = {}
        self.by_name = {}
        for page in doc:
            for xref, ext, kind, name, *_ in page.get_fonts(full=False):
                self.by_name.setdefault(re.sub(r"^[A-Z]{6}\+", "", name), xref)

    def font(self, name):
        key = re.sub(r"^[A-Z]{6}\+", "", name)
        if key in self.cache:
            return self.cache[key]
        f = None
        xref = self.by_name.get(key)
        if xref:
            try:
                buf = self.doc.extract_font(xref)[3]
                if buf:
                    f = pymupdf.Font(fontbuffer=buf)
            except Exception:
                f = None
        self.cache[key] = f
        return f

    def width(self, name, text, size):
        f = self.font(name)
        if f is None:
            return None
        try:
            w = f.text_length(text, fontsize=size)
        except Exception:
            return None
        return w if w > 0 else None


def run_xml(span, text, link_rid=None, extra_spacing=0):
    font = esc(word_family(span["font"]) or "Arial")
    flags, name = span["flags"], span["font"].lower()
    bold = bool(flags & 16) or "bold" in name or "black" in name or "heavy" in name
    ital = bool(flags & 2) or "italic" in name or "oblique" in name
    size = span["size"]
    half = max(2, round(size * 2))
    scale = round(size / (half / 2) * 100) if half else 100
    rpr = (f'<w:rFonts w:ascii="{font}" w:hAnsi="{font}" w:eastAsia="{font}" w:cs="{font}"/>'
           + ("<w:b/><w:bCs/>" if bold else "") + ("<w:i/><w:iCs/>" if ital else "")
           + f'<w:color w:val="{hexcolor(span["color"])}"/>'
           + (f'<w:spacing w:val="{extra_spacing}"/>' if extra_spacing else "")
           + (f'<w:w w:val="{scale}"/>' if abs(scale - 100) >= 2 else "")
           + f'<w:sz w:val="{half}"/><w:szCs w:val="{half}"/>')
    return f'<w:r><w:rPr>{rpr}</w:rPr><w:t xml:space="preserve">{esc(text)}</w:t></w:r>'


def split_spaces(span, meter):
    """Runs for one span; when the PDF stretched the spaces (justified text), carry that stretch on the spaces."""
    text = span["text"]
    x0, x1 = span["bbox"][0], span["bbox"][2]
    spaces = text.count(" ")
    natural = meter.width(span["font"], text, span["size"]) if spaces else None
    if natural and spaces and len(text) > 8:
        extra = (x1 - x0 - natural) / spaces                    # points added to each space
        if 0.35 < extra < 25:
            twips = int(round(extra * TW))
            parts = re.split(r"( )", text)
            xml = ""
            for part in parts:
                if not part:
                    continue
                xml += run_xml(span, part, extra_spacing=twips if part == " " else 0)
            return xml
    return run_xml(span, text)


def collect(page):
    """Lines of spans, each line cut into segments wherever the gap or the baseline changes."""
    segments = []
    d = page.get_text("dict", flags=pymupdf.TEXT_PRESERVE_WHITESPACE | pymupdf.TEXT_PRESERVE_LIGATURES)
    for block in d["blocks"]:
        for line in block.get("lines", []):
            spans = [s for s in line["spans"] if span_ok(line, s)]
            if not spans:
                continue
            cur = [spans[0]]
            for s in spans[1:]:
                prev = cur[-1]
                gap = s["origin"][0] - prev["bbox"][2]
                same_base = abs(s["origin"][1] - prev["origin"][1]) <= max(0.35, prev["size"] * 0.04)
                spaced = prev["text"].endswith(" ") or s["text"].startswith(" ")
                # joined only when they touch, or a real space character sits between them; any other gap (letter-spaced
                # headings, tab-aligned columns, a label and its value) keeps the second piece at its own exact position
                if same_base and (gap <= prev["size"] * 0.12 or (spaced and gap < max(prev["size"] * 1.2, 9))):
                    cur.append(s)
                else:
                    segments.append(cur)
                    cur = [s]
            segments.append(cur)
    return segments


def links_of(page):
    out = []
    for lk in page.get_links():
        if lk.get("uri"):
            out.append((pymupdf.Rect(lk["from"]), lk["uri"]))
    return out


def frame_xml(seg, page_w, links, doc_part, meter):
    first, last = seg[0], seg[-1]
    x = first["origin"][0]
    size = max(s["size"] for s in seg)
    asc = first.get("ascender", 0.9) or 0.9
    desc = first.get("descender", -0.2) or -0.2
    line_h = size * (asc - desc)
    base = first["origin"][1]
    top = base - asc * size
    width = max(last["bbox"][2] - x, 4) * 1.1 + 10      # room to spare: a wider substitute font must not wrap
    runs = ""
    for s in seg:
        link = next((uri for rect, uri in links if rect.intersects(pymupdf.Rect(s["bbox"])) and (rect & pymupdf.Rect(s["bbox"])).get_area() >= 0.5 * pymupdf.Rect(s["bbox"]).get_area()), None)
        body = split_spaces(s, meter)
        if link:
            rid = doc_part.relate_to(link, RELATIONSHIP_TYPE.HYPERLINK, is_external=True)
            runs += f'<w:hyperlink r:id="{rid}" w:history="1">{body}</w:hyperlink>'
        else:
            runs += body
    ppr = (f'<w:framePr w:w="{int((width + 2) * TW)}" w:h="{int(line_h * TW)}" w:hRule="exact" w:hSpace="0" w:vSpace="0" w:wrap="none" '
           f'w:vAnchor="page" w:hAnchor="page" w:x="{int(round(x * TW))}" w:y="{int(round(top * TW))}"/>'
           f'<w:widowControl w:val="0"/><w:spacing w:before="0" w:after="0" w:line="{int(line_h * TW)}" w:lineRule="exact"/><w:ind w:left="0" w:right="0" w:firstLine="0"/>')
    return f'<w:p {nsdecls("w", "r")}><w:pPr>{ppr}</w:pPr>{runs}</w:p>'


def background(work_page, dpi=BG_DPI):
    pix = work_page.get_pixmap(dpi=dpi, alpha=False)
    if pix.is_unicolor and pix.samples[:3] == b"\xff\xff\xff":
        return None
    png = pix.tobytes("png")
    jpg = pix.tobytes("jpeg", jpg_quality=88)
    return (png, "png") if len(png) <= len(jpg) * 1.3 else (jpg, "jpg")


def anchor_picture(doc, paragraph, data, ext, w_pt, h_pt):
    import io
    run = paragraph.add_run()
    run.add_picture(io.BytesIO(data), width=Emu(int(w_pt * 12700)), height=Emu(int(h_pt * 12700)))
    inline = run._r.xpath(".//wp:inline")[0]
    graphic = inline.xpath("./a:graphic")[0]
    doc_pr = inline.xpath("./wp:docPr")[0]
    anchor = parse_xml(
        '<wp:anchor %s distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="0" behindDoc="1" locked="1" layoutInCell="1" allowOverlap="1">'
        '<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionH>'
        '<wp:positionV relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionV>'
        '<wp:extent cx="%d" cy="%d"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>'
        '<wp:docPr id="%s" name="Page background"/><wp:cNvGraphicFramePr/></wp:anchor>'
        % (nsdecls("wp", "a", "pic", "r"), int(w_pt * 12700), int(h_pt * 12700), doc_pr.get("id")))
    anchor.append(graphic)
    inline.getparent().replace(inline, anchor)


def design_reason(src, max_pages=40):
    """Why a PDF cannot be rebuilt as flowing paragraphs without losing something, or None if it can.

    A flowing rebuild loses coloured shapes and pictures behind text (white text on a banner turns invisible), cannot
    place side-by-side columns, and has no way to express rotated text."""
    doc = pymupdf.open(src)
    for page in list(doc)[:max_pages]:
        centres = []
        for block in page.get_text("dict")["blocks"]:
            for line in block.get("lines", []):
                if abs(line["dir"][1]) > 0.02 or line["dir"][0] < 0.98:
                    return f"rotated text on page {page.number + 1}"
                for s in line["spans"]:
                    if s["text"].strip():
                        if RTL.search(s["text"]):
                            return f"right-to-left text on page {page.number + 1}"
                        b = s["bbox"]
                        centres.append(((b[0] + b[2]) / 2, (b[1] + b[3]) / 2))
        for d in page.get_drawings():
            fill, r = d.get("fill"), d["rect"]
            if not fill or r.width * r.height < 150:
                continue
            luma = 0.2126 * fill[0] + 0.7152 * fill[1] + 0.0722 * fill[2]
            if luma < 0.8 and any(r.x0 < x < r.x1 and r.y0 < y < r.y1 for x, y in centres):
                return f"text on a coloured shape on page {page.number + 1}"
        for info in page.get_image_info():
            r = pymupdf.Rect(info["bbox"])
            if r.width * r.height > 2500 and any(r.x0 < x < r.x1 and r.y0 < y < r.y1 for x, y in centres):
                return f"text over a picture on page {page.number + 1}"
        blocks = [b for b in page.get_text("blocks") if b[6] == 0 and b[3] - b[1] > 30 and b[2] - b[0] > 60]
        for i, a in enumerate(blocks):
            for b in blocks[i + 1:]:
                overlap = min(a[3], b[3]) - max(a[1], b[1])
                if overlap > 0.5 * min(a[3] - a[1], b[3] - b[1]) and (a[2] + 8 < b[0] or b[2] + 8 < a[0]):
                    return f"columns on page {page.number + 1}"
    return None


def convert(src, dst):
    doc = pymupdf.open(src)
    work = pymupdf.open(src)             # a copy to take the text out of
    meter = FontMeter(doc)
    out = Document()
    body = out.element.body
    for el in list(body):
        if el.tag != qn("w:sectPr"):
            body.remove(el)

    n_pages = len(doc)
    stats = {"frames": 0, "bg_pages": 0}
    for pno in range(n_pages):
        page, wpage = doc[pno], work[pno]
        w_pt, h_pt = page.rect.width, page.rect.height
        segments = collect(page)
        kept = [s for seg in segments for s in seg]

        for s in kept:
            r = pymupdf.Rect(s["bbox"])
            inset = r.height * 0.2              # glyph ink is shorter than the line box; do not clip a neighbour's letters
            wpage.add_redact_annot(pymupdf.Rect(r.x0, r.y0 + inset, r.x1, r.y1 - inset), fill=False)
        if kept:
            wpage.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE, graphics=pymupdf.PDF_REDACT_LINE_ART_NONE, text=pymupdf.PDF_REDACT_TEXT_REMOVE)

        links = links_of(page)
        for seg in segments:
            body.insert(len(body) - 1, parse_xml(frame_xml(seg, w_pt, links, out.part, meter)))
            stats["frames"] += 1

        # the closing paragraph of the page: carries the background picture and ends the section
        anchor_p = parse_xml(f'<w:p {nsdecls("w")}><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/></w:rPr></w:pPr></w:p>')
        body.insert(len(body) - 1, anchor_p)
        from docx.text.paragraph import Paragraph
        par = Paragraph(anchor_p, out._body)
        # sharp enough for the sharpest picture on the page (but no more than 300 dpi), never below 200
        native = max((i["width"] / max(i["bbox"][2] - i["bbox"][0], 1) * 72 for i in page.get_image_info() if i["width"] > 16), default=0)
        bg = background(wpage, int(min(300, max(BG_DPI, native))))
        if bg:
            anchor_picture(out, par, bg[0], bg[1], w_pt, h_pt)
            stats["bg_pages"] += 1
        sect = (f'<w:sectPr {nsdecls("w")}><w:type w:val="nextPage"/><w:pgSz w:w="{int(round(w_pt * TW))}" w:h="{int(round(h_pt * TW))}"/>'
                '<w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>')
        if pno < n_pages - 1:
            anchor_p.find(qn("w:pPr")).append(parse_xml(sect))
        else:
            final = body.find(qn("w:sectPr"))
            body.replace(final, parse_xml(sect))
    meta = doc.metadata or {}
    props = out.core_properties
    props.title = meta.get("title") or ""
    props.author = meta.get("author") or ""
    props.subject = meta.get("subject") or ""
    props.keywords = meta.get("keywords") or ""
    out.save(dst)
    return stats


if __name__ == "__main__":
    print(convert(sys.argv[1], sys.argv[2]))

# SPDX-License-Identifier: AGPL-3.0-or-later
"""What makes the DOCX a Word document and not only a drawing of the PDF: the styles, and the headers and footers that repeat on the pages."""

import io
import itertools
import re
from collections import Counter

from docx.enum.section import WD_HEADER_FOOTER
from docx.opc.constants import RELATIONSHIP_TYPE
from docx.oxml import parse_xml
from docx.oxml.ns import qn
import pymupdf

from pdf_fonts import latin

from .common import NS, esc
from .lines import merge_rows, read_lines

NUMBER = re.compile(r"\d+")
BAND = 0.1
ONE_POINT = '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/></w:rPr></w:pPr>%s</w:p>'
SPACER = ONE_POINT % ""
LOGO = re.compile('r:embed="\x02(\\d+)"')


def body_font(lines, size, meter):
    """The family most of the ordinary text is set in."""
    count = Counter()
    for l in lines:
        for s in l.spans:
            if abs(s["size"] - size) <= 0.3 and latin(s["text"]):
                count[meter.family(s)] += len(s["text"].strip())
    return count.most_common(1)[0][0] if count else None


def table_style(look, n):
    """A table style for the look of a table (see `table_look`): its rules and padding, and the header row, stripes and first column that the cells would otherwise
    each state. Word's own designs take their colours from the theme, so the PDF's colours need a style of their own, which Table Design lists beside them."""
    rule, pad, head, stripes, first = look
    shd = lambda fill: f'<w:shd w:val="clear" w:color="auto" w:fill="{fill}"/>' if fill else ""
    side = lambda s: f'<w:{s} w:val="single" w:sz="{rule[0]}" w:space="0" w:color="{rule[1]}"/>'
    borders = "<w:tblBorders>" + "".join(side(s) for s in ("top", "left", "bottom", "right", "insideH", "insideV")) + "</w:tblBorders>" if rule else ""
    margins = "".join(f'<w:{s} w:w="{pad if s in ("left", "right") else 0}" w:type="dxa"/>' for s in ("top", "left", "bottom", "right"))

    def part(kind, give, fill=None):
        color, bold = (give[1], give[2]) if give else (None, None)
        rpr = ("<w:b/><w:bCs/>" if bold else "") + (f'<w:color w:val="{color}"/>' if color else "")
        tcpr = shd(give[0] if give else fill)
        return f'<w:tblStylePr w:type="{kind}">' + (f"<w:rPr>{rpr}</w:rPr>" if rpr else "") + (f"<w:tcPr>{tcpr}</w:tcPr>" if tcpr else "") + "</w:tblStylePr>"
    band = '<w:tblStyleRowBandSize w:val="1"/>' if stripes else ""
    parts = (part("firstRow", head) if head else "") + (part("firstCol", first) if first else "")
    if stripes:
        parts += "".join(part(kind, None, fill) for kind, fill in (("band1Horz", stripes[0]), ("band2Horz", stripes[1])) if fill)
    return (f'<w:style w:type="table" w:customStyle="1" w:styleId="PDFTable{n}"><w:name w:val="PDF Table {n}"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="59"/><w:qFormat/>'
            f'<w:tblPr>{band}{borders}<w:tblCellMar>{margins}</w:tblCellMar></w:tblPr>{parts}</w:style>')


def set_styles(out, font, half, looks=()):
    """The styles the paragraphs refer to. They carry no look of their own beyond the body font: every run states its own, so a style changes nothing on the page and
    only gives Word the structure (the Navigation pane, a list, a caption). Heading styles do not keep a heading with the next paragraph, which would move it to another sheet."""
    base = (f'<w:rFonts w:ascii="{esc(font)}" w:hAnsi="{esc(font)}" w:eastAsia="{esc(font)}" w:cs="{esc(font)}"/>' if font else "") + f'<w:sz w:val="{half}"/><w:szCs w:val="{half}"/>'
    styles = [
        ('Normal', f'<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/>'
                   f'<w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr>{base}</w:rPr></w:style>'),
        ('Title', '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="10"/><w:qFormat/></w:style>'),
        ('ListParagraph', '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/></w:style>'),
        ('Caption', '<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="35"/><w:qFormat/></w:style>'),
    ] + [(f'Heading{n}', f'<w:style w:type="paragraph" w:styleId="Heading{n}"><w:name w:val="heading {n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/>'
                         f'<w:pPr><w:outlineLvl w:val="{n - 1}"/></w:pPr></w:style>') for n in (1, 2, 3)]
    root = out.styles.element
    for style_id, xml in styles:
        for old in root.findall(qn("w:style")):
            if old.get(qn("w:styleId")) == style_id:
                root.remove(old)
        root.append(parse_xml(xml.replace("<w:style ", f"<w:style {NS} ", 1)))
    for n, look in enumerate(looks, 1):
        root.append(parse_xml(table_style(look, n).replace("<w:style ", f"<w:style {NS} ", 1)))


def readings(text, pno, n):
    """The ways the numbers in a line of a footer can be read as page numbers: [(key, [(start, end, field)])]. The key is the text with the fields in place of the numbers, so
    the lines "1 of 8" and "2 of 8" have the key "{PAGE} of {NUMPAGES}". A number that is neither stays as it is."""
    found = [(m.start(), m.end(), m.group()) for m in NUMBER.finditer(text)]
    if len(found) > 6:
        return [(text, [])]
    options = []
    for _, _, digits in found:
        o = [None]
        if digits == str(n):
            o.insert(0, "NUMPAGES")
        if digits == str(pno + 1):
            o.insert(0, "PAGE")
        options.append(o)
    out = []
    for pick in itertools.product(*options):
        key, at = "", 0
        for (a, b, _), field in zip(found, pick):
            key += text[at:a] + ("{%s}" % field if field else text[a:b])
            at = b
        out.append((key + text[at:], [(a, b, f) for (a, b, _), f in zip(found, pick) if f]))
    return out


def with_fields(line, cuts):
    """The spans of the line cut at its page numbers, the number pieces marked as fields; None when a number is split between two spans."""
    out, pos = [], 0
    for s in line.spans:
        t = s["text"]
        a, b = pos, pos + len(t)
        pos = b
        edges = sorted({a, b} | {x for c in cuts for x in c[:2] if a < x < b})
        for lo, hi in zip(edges, edges[1:]):
            x0, x1 = s["bbox"][0], s["bbox"][2]
            piece = dict(s, whole=s, text=t[lo - a:hi - a], bbox=(x0 + (x1 - x0) * (lo - a) / len(t), s["bbox"][1], x0 + (x1 - x0) * (hi - a) / len(t), s["bbox"][3]))
            for c in cuts:
                if c[0] == lo and c[1] == hi:
                    piece["field"] = c[2]
            out.append(piece)
    for c in cuts:
        if not any(s.get("field") and s["text"] == line.text[c[0]:c[1]] for s in out):
            return None
    return out


def band_of(bbox, h):
    return "header" if bbox[3] <= BAND * h else "footer" if bbox[1] >= (1 - BAND) * h else None


def same_place(a, b):
    return all(abs(u - v) <= 2 for u, v in zip(a, b))


class Furniture:
    """The lines and pictures that repeat in the top or bottom tenth of most pages (a running title, a reference, a page number, a logo). They are written once, in header and footer parts."""

    def __init__(self, doc, turns):
        self.n = len(doc)
        seen, logos = {}, {}
        for pno, page in enumerate(doc):
            if turns.get(pno):
                continue
            w, h = page.rect.width, page.rect.height
            for band, clip in (("header", pymupdf.Rect(0, 0, w, BAND * h)), ("footer", pymupdf.Rect(0, (1 - BAND) * h, w, h))):
                for l in merge_rows([l for l in read_lines(page, clip) if not l.rot]):
                    for key, _ in readings(l.text.strip(), pno, self.n):
                        seen.setdefault((band, key), set()).add(pno)
            for info in page.get_image_info(xrefs=True):
                edge = band_of(info["bbox"], h)
                if edge and info["xref"]:
                    logos.setdefault((edge, info["xref"]), []).append((pno, info["bbox"]))
        need = max(2, round(0.75 * self.n))
        self.keep = {k for k, pages in seen.items() if len(pages) >= need}
        self.logos = {k: found[0][1] for k, found in logos.items() if len({pno for pno, b in found if same_place(b, found[0][1])}) >= need}
        self.pictures = {}

    def logo(self, info, h):
        """("header" or "footer") when the picture is one that repeats at the same place on most pages."""
        band = band_of(info["bbox"], h)
        ref = self.logos.get((band, info["xref"]))
        return band if ref and not info.get("full") and same_place(info["bbox"], ref) else None

    def take(self, l, pno, h):
        """("header" or "footer") when the line is part of what repeats; the line's spans are then cut at its page numbers."""
        band = "header" if l.y1 <= BAND * h else "footer" if l.y0 >= (1 - BAND) * h else None
        if band is None:
            return None
        text = l.text.strip()
        lead = len(l.text) - len(l.text.lstrip())
        for key, cuts in readings(text, pno, self.n):
            if (band, key) in self.keep:
                spans = with_fields(l, [(a + lead, b + lead, f) for a, b, f in cuts]) if cuts else l.spans
                if spans is None:
                    return None
                for s in spans:
                    if s.get("field"):
                        s["text"] = "1" if s["field"] == "PAGE" else str(self.n)
                l.spans = spans
                return band
        return None


def attach(out, states, log=lambda m: None, pictures=None):
    """Header and footer parts for the sections. `states` holds, for each section, the XML of its header and of its footer. A section that differs from the one before it
    gets its own references; the others carry on with the previous one, as the headers of a Word document do. When the counts differ, the lines that were taken out of the
    pages are still kept: the first header and the first footer that exist go to the first section. A picture in a part is named by its xref after a control character, which
    no text can hold, and is related from the part itself, which `pictures` ({xref: (image bytes, drawing id)}) supplies."""
    sections = out.sections
    if len(sections) != len(states):
        log("%d sections but %d header and footer states; the header and footer go to the first section" % (len(sections), len(states)))
        states = [tuple(next((s[i] for s in states if s[i]), "") for i in (0, 1))]
        sections = sections[:1]
    part = out.part
    made = {}
    before = ("", "")
    for sec, state in zip(sections, states):
        for i, kind in enumerate(("header", "footer")):
            if state[i] == before[i]:
                continue
            if (kind, state[i]) not in made:
                new, rid = (part.add_header_part if kind == "header" else part.add_footer_part)()
                xml = re.sub(r'<w:hyperlink r:id="(rId\d+)"', lambda m: '<w:hyperlink r:id="%s"' % new.relate_to(part.rels[m.group(1)].target_ref, RELATIONSHIP_TYPE.HYPERLINK, is_external=True), state[i])
                xml = LOGO.sub(lambda m: 'r:embed="%s"' % new.get_or_add_image(io.BytesIO(pictures[int(m.group(1))][0]))[0], xml)
                for old in list(new.element):
                    new.element.remove(old)
                for el in parse_xml(f'<w:body {NS}>{xml}{SPACER}</w:body>'):
                    new.element.append(el)
                made[(kind, state[i])] = rid
            add = sec._sectPr.add_headerReference if kind == "header" else sec._sectPr.add_footerReference
            add(WD_HEADER_FOOTER.PRIMARY, made[(kind, state[i])])
        before = state

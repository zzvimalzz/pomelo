# SPDX-License-Identifier: AGPL-3.0-or-later
"""What makes the DOCX a Word document and not only a drawing of the PDF: the styles, and the headers and footers that repeat on the pages."""

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
SPACER = '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/></w:rPr></w:pPr></w:p>'


def body_font(lines, size, meter):
    """The family most of the ordinary text is set in."""
    count = Counter()
    for l in lines:
        for s in l.spans:
            if abs(s["size"] - size) <= 0.3 and latin(s["text"]):
                count[meter.family(s)] += len(s["text"].strip())
    return count.most_common(1)[0][0] if count else None


def set_styles(out, font, half):
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


class Furniture:
    """The lines that repeat in the top or bottom tenth of most pages (a running title, a reference, a page number). They are written once, in header and footer parts."""

    def __init__(self, doc, turns):
        self.n = len(doc)
        seen = {}
        for pno, page in enumerate(doc):
            if turns.get(pno):
                continue
            w, h = page.rect.width, page.rect.height
            for band, clip in (("header", pymupdf.Rect(0, 0, w, BAND * h)), ("footer", pymupdf.Rect(0, (1 - BAND) * h, w, h))):
                for l in merge_rows([l for l in read_lines(page, clip) if not l.rot]):
                    for key, _ in readings(l.text.strip(), pno, self.n):
                        seen.setdefault((band, key), set()).add(pno)
        need = max(2, round(0.75 * self.n))
        self.keep = {k for k, pages in seen.items() if len(pages) >= need}

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


def attach(out, states):
    """Header and footer parts for the sections. `states` holds, for each page, the XML of its header and of its footer. A section that differs from the one before it
    gets its own references; the others carry on with the previous one, as the headers of a Word document do."""
    sections = out.sections
    if len(sections) != len(states):
        return
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
                for old in list(new.element):
                    new.element.remove(old)
                for el in parse_xml(f'<w:body {NS}>{xml}{SPACER}</w:body>'):
                    new.element.append(el)
                made[(kind, state[i])] = rid
            add = sec._sectPr.add_headerReference if kind == "header" else sec._sectPr.add_footerReference
            add(WD_HEADER_FOOTER.PRIMARY, made[(kind, state[i])])
        before = state

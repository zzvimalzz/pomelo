# SPDX-License-Identifier: AGPL-3.0-or-later
"""What makes the DOCX a Word document and not only a drawing of the PDF: the styles, the table of contents, and the headers and footers that repeat on the pages."""

import copy
import io
import itertools
import re
from bisect import bisect_left
from collections import Counter

from docx.enum.section import WD_HEADER_FOOTER
from docx.opc.constants import CONTENT_TYPE, RELATIONSHIP_TYPE
from docx.opc.packuri import PackURI
from docx.opc.part import Part
from docx.oxml import parse_xml
from docx.oxml.ns import nsdecls, qn
import pymupdf

from pdf_fonts import latin

from .common import NS, cluster, esc, nearest
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


def set_styles(out, font, half, looks=(), hyphenate=False):
    """The styles the paragraphs refer to. They carry no look of their own beyond the body font: every run states its own, so a style changes nothing on the page and
    only gives Word the structure (the Navigation pane, a list, a caption). Heading styles do not keep a heading with the next paragraph, which would move it to another sheet.
    With `hyphenate`, Word hyphenates, but only the paragraphs that ask for it: justified text that the PDF hyphenates (a title or a cell must not break a word)."""
    base = (f'<w:rFonts w:ascii="{esc(font)}" w:hAnsi="{esc(font)}" w:eastAsia="{esc(font)}" w:cs="{esc(font)}"/>' if font else "") + f'<w:sz w:val="{half}"/><w:szCs w:val="{half}"/>'
    styles = [
        ('Normal', f'<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/>'
                   f'<w:pPr>{"<w:suppressAutoHyphens/>" if hyphenate else ""}<w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr>{base}</w:rPr></w:style>'),
        ('Title', '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="10"/><w:qFormat/></w:style>'),
        ('ListParagraph', '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/></w:style>'),
        ('FootnoteText', '<w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/></w:style>'),
        ('FootnoteReference', '<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:uiPriority w:val="99"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>'),
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
    if hyphenate:
        settings = out.settings.element
        settings.insert(list(settings).index(settings.find(qn("w:defaultTabStop"))) + 1, parse_xml(f'<w:autoHyphenation {W}/>'))


def add_notes(out, notes):
    """The footnotes part, from the XML of each note, with the two separators Word expects, and the entry in the settings that names them."""
    if not notes:
        return
    para = lambda kind: f'<w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:{kind}/></w:r></w:p>'
    xml = (f'<w:footnotes {NS}><w:footnote w:type="separator" w:id="-1">{para("separator")}</w:footnote>'
           f'<w:footnote w:type="continuationSeparator" w:id="0">{para("continuationSeparator")}</w:footnote>{"".join(notes)}</w:footnotes>')
    part = Part(PackURI("/word/footnotes.xml"), CONTENT_TYPE.WML_FOOTNOTES, xml.encode("utf8"), out.part.package)
    out.part.relate_to(part, RELATIONSHIP_TYPE.FOOTNOTES)
    settings = out.settings.element
    settings.insert(list(settings).index(settings.find(qn("w:compat"))), parse_xml(f'<w:footnotePr {W}><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr>'))


W = nsdecls("w")
LEADERS = ("dot", "hyphen", "underscore", "middleDot")
FLOW = (qn("w:body"), qn("w:tc"))


def squash(text):
    return re.sub(r"\s+", "", text).lower()


def text_of(p):
    """A paragraph's text with each tab as a tab character."""
    return "".join("\t" if el.tag == qn("w:tab") and el.getparent().tag == qn("w:r") else el.text or "" for el in p.iter(qn("w:t"), qn("w:tab")))


def entry_of(p):
    """(text before the page number, indent in twips) when the paragraph is a contents entry: a tab with a leader in its stops, and a page number after its last tab."""
    ppr = p.find(qn("w:pPr"))
    tabs = ppr.find(qn("w:tabs")) if ppr is not None else None
    pieces = text_of(p).split("\t")
    if tabs is None or not any(t.get(qn("w:leader")) in LEADERS for t in tabs) or p.find(qn("w:hyperlink")) is not None:
        return None
    if len(pieces) < 2 or not re.fullmatch(r"\d{1,4}|[ivxlc]{1,6}", pieces[-1].strip(), re.I):
        return None
    ind = ppr.find(qn("w:ind"))
    return "".join(pieces[:-1]), int(ind.get(qn("w:left")) or 0) if ind is not None else 0


def bookmark(p, ids, name):
    n = str(next(ids))
    start = parse_xml(f'<w:bookmarkStart {W} w:id="{n}" w:name="{name}"/>')
    ppr = p.find(qn("w:pPr"))
    p.insert(0 if ppr is None else 1, start)
    p.append(parse_xml(f'<w:bookmarkEnd {W} w:id="{n}"/>'))


def heading_style(p, level):
    ppr = p.find(qn("w:pPr"))
    if ppr is None:
        ppr = parse_xml(f"<w:pPr {W}/>")
        p.insert(0, ppr)
    style = ppr.find(qn("w:pStyle"))
    if style is None:
        style = parse_xml(f'<w:pStyle {W} w:val="Heading{level}"/>')
        ppr.insert(0, style)
    style.set(qn("w:val"), f"Heading{level}")


def contents(out, outline):
    """Word's own table of contents, and the bookmarks that its links and the Navigation pane use. A block of three or more contents entries whose titles are, in order, the
    text of paragraphs further on becomes a TOC field (the entries as the PDF shows them, each a link to its heading, which gets the heading style of its level); a block
    where one entry has no such paragraph stays as it is. The PDF's own outline then bookmarks the paragraphs whose text is the title of an outline entry."""
    body = out.element.body
    paras = [p for p in body.iter(qn("w:p")) if p.getparent().tag in FLOW]
    at = {id(p): i for i, p in enumerate(paras)}
    texts = [squash(text_of(p)) for p in paras]
    where = {}
    for k, t in enumerate(texts):
        where.setdefault(t, []).append(k)
    after = lambda key, pos, ok: next((k for k in where.get(key, ())[bisect_left(where.get(key, ()), pos):] if ok(k)), None)
    ids = itertools.count(1 + max([int(b.get(qn("w:id"))) for b in body.iter(qn("w:bookmarkStart"))] or [0]))
    marked, entries = set(), {}
    for p in paras:
        entry = entry_of(p)
        if entry:
            entries[id(p)] = entry
    blocks, run, gap = [], [], 0
    for el in body:
        if id(el) in entries:
            run.append(el)
            gap = 0
        elif run and gap < 4 and el.tag == qn("w:p") and len(text_of(el)) <= 80 and el.find(".//" + qn("w:drawing")) is None:
            gap += 1                                          # a rule, a page break or a running foot between two pages of one contents list
        else:
            blocks += [run] if len(run) >= 3 else []
            run, gap = [], 0
    styles, titled = {}, False
    for block in blocks:
        levels = cluster([entries[id(p)][1] for p in block], 20)
        pos, found = 0, []
        for p in block:
            key = squash(entries[id(p)][0])
            j = after(key, pos, lambda k: k not in marked and heading_free(paras[k]))
            if j is None:
                break
            found.append(j)
            pos = j + 1
        if len(levels) > 3 or len(found) < len(block):
            continue
        marked.update(found)
        k = at[id(block[0])]
        while k and not texts[k - 1]:
            k -= 1
        style = paras[k - 1].find(qn("w:pPr") + "/" + qn("w:pStyle")) if k else None
        if style is not None and texts[k - 1] in ("contents", "tableofcontents") and style.get(qn("w:val")).startswith("Heading"):
            style.set(qn("w:val"), "TOCHeading")                  # the contents' own title is not an entry of the table it heads
            titled = True
        names = [f"_Toc{100000 + next(ids)}" for _ in block]
        for p, j, name in zip(block, found, names):
            level = nearest(levels, entries[id(p)][1]) + 1
            heading_style(paras[j], level)
            bookmark(paras[j], ids, name)
            ppr = p.find(qn("w:pPr"))
            ppr.insert(0, parse_xml(f'<w:pStyle {W} w:val="TOC{level}"/>'))
            styles.setdefault(level, ppr)
            link = parse_xml(f'<w:hyperlink {W} w:anchor="{name}" w:history="1"/>')
            for run_ in [c for c in p if c.tag != qn("w:pPr") and c.find(".//" + qn("w:drawing")) is None]:
                link.append(run_)
            p.append(link)
        fld = lambda kind: parse_xml(f'<w:r {W}><w:fldChar w:fldCharType="{kind}"/></w:r>')
        first, last = block[0], block[-1]
        first.find(qn("w:hyperlink")).addprevious(fld("begin"))
        first.find(qn("w:hyperlink")).addprevious(parse_xml(f'<w:r {W}><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r>'))
        first.find(qn("w:hyperlink")).addprevious(fld("separate"))
        last.append(fld("end"))
    root = out.styles.element
    for level, ppr in styles.items():
        style = parse_xml(f'<w:style {W} w:type="paragraph" w:styleId="TOC{level}"><w:name w:val="toc {level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="39"/><w:pPr/></w:style>')
        style.find(qn("w:pPr")).extend(copy.deepcopy(ppr.find(qn(f"w:{tag}"))) for tag in ("tabs", "ind") if ppr.find(qn(f"w:{tag}")) is not None)
        root.append(style)
    if titled:
        root.append(parse_xml(f'<w:style {W} w:type="paragraph" w:styleId="TOCHeading"><w:name w:val="TOC Heading"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="39"/></w:style>'))
    pos = 0
    for _, title, *_ in outline:
        j = after(squash(title), pos, lambda k: k not in marked)
        if j is not None:
            bookmark(paras[j], ids, f"section_{next(ids)}")
            pos = j + 1


def captions(out):
    """The number in the caption of a figure or a table is a SEQ field, so a figure added later renumbers. Only when the numbers of a label run 1, 2, 3 in order:
    otherwise a field would change them."""
    found = []
    for p in out.element.body.iter(qn("w:p")):
        style = p.find(qn("w:pPr") + "/" + qn("w:pStyle"))
        run = p.find(qn("w:r"))
        text = run.find(qn("w:t")) if run is not None and style is not None and style.get(qn("w:val")) == "Caption" else None
        m = re.match(r"(Figure|Fig\.|Table)(\s+)(\d+)(?=[.:\s])", text.text or "") if text is not None else None
        if m and [c.tag for c in run if c.tag != qn("w:rPr")] == [qn("w:t")]:
            found.append((run, text, m, "Table" if m.group(1) == "Table" else "Figure"))
    for label in ("Figure", "Table"):
        mine = [f for f in found if f[3] == label]
        if not mine or [int(f[2].group(3)) for f in mine] != list(range(1, len(mine) + 1)):
            continue
        for run, text, m, _ in mine:
            rpr = run.find(qn("w:rPr"))
            def piece(inner):
                r = parse_xml(f"<w:r {W}>{inner}</w:r>")
                if rpr is not None:
                    r.insert(0, copy.deepcopy(rpr))
                return r
            fld = lambda kind: piece(f'<w:fldChar w:fldCharType="{kind}"/>')
            new = [piece(f'<w:t xml:space="preserve">{esc(text.text[:m.start(3)])}</w:t>'), fld("begin"), piece(f'<w:instrText xml:space="preserve"> SEQ {label} \\* ARABIC</w:instrText>'),
                   fld("separate"), piece(f"<w:t>{m.group(3)}</w:t>"), fld("end"), piece(f'<w:t xml:space="preserve">{esc(text.text[m.end(3):])}</w:t>')]
            for r in new:
                run.addprevious(r)
            run.getparent().remove(run)


def heading_free(p):
    """True for a paragraph that may become a heading: one that has no style of its own (a list or a caption keeps it) or has a heading style already."""
    style = p.find(qn("w:pPr") + "/" + qn("w:pStyle"))
    return style is None or style.get(qn("w:val")) in ("Heading1", "Heading2", "Heading3")


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

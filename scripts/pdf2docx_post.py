# SPDX-License-Identifier: AGPL-3.0-or-later
"""Clean-up passes over a DOCX that pdf2docx has just written (used by pdf2docx_run.py).

  * table rows with an exact height clip whatever does not fit, so they become "at least" rows
  * bullets that pdf2docx writes as a Symbol character + a tab become real Word bullet lists, with the same
    indents, so the page looks the same but the list can be edited as a list
"""
import copy

from docx.oxml import OxmlElement, parse_xml
from docx.oxml.ns import nsdecls, qn

BULLETS = {"", "•", "·", "▪", "◦", "●", "○", "■", "‣", "⁃", "", "", "", ""}


def _text(run):
    return "".join(t.text or "" for t in run.findall(qn("w:t")))


def _fonts(run):
    rpr = run.find(qn("w:rPr"))
    f = rpr.find(qn("w:rFonts")) if rpr is not None else None
    return f.get(qn("w:ascii")) if f is not None else None


def fix_row_heights(body):
    n = 0
    for h in body.iter(qn("w:trHeight")):
        if h.get(qn("w:hRule")) == "exact":
            h.set(qn("w:hRule"), "atLeast")
            n += 1
    return n


def _numbering(doc):
    try:
        return doc.part.numbering_part.element
    except Exception:
        return None


def bullets_to_lists(doc):
    numbering = _numbering(doc)
    if numbering is None:
        return 0
    body = doc.element.body
    ids_a = [int(a.get(qn("w:abstractNumId"))) for a in numbering.findall(qn("w:abstractNum"))]
    ids_n = [int(n.get(qn("w:numId"))) for n in numbering.findall(qn("w:num"))]
    next_a, next_n = (max(ids_a) + 1 if ids_a else 1), (max(ids_n) + 1 if ids_n else 1)
    made = {}   # (glyph, font, size, color) -> numId
    converted = 0

    for p in list(body.iter(qn("w:p"))):
        runs = [c for c in p if c.tag == qn("w:r")]
        if len(runs) < 3:
            continue
        first, second = runs[0], runs[1]
        glyph = _text(first)
        if glyph not in BULLETS or second.find(qn("w:tab")) is None or _text(second):
            continue
        ppr = p.find(qn("w:pPr"))
        if ppr is None:
            continue
        ind = ppr.find(qn("w:ind"))
        tabs = ppr.find(qn("w:tabs"))
        if ind is None or tabs is None:
            continue
        stops = [int(t.get(qn("w:pos"))) for t in tabs.findall(qn("w:tab")) if t.get(qn("w:val")) in ("left", "start", None)]
        left = int(float(ind.get(qn("w:left")) or ind.get(qn("w:start")) or 0))
        if not stops:
            continue
        text_at = min((s for s in stops if s > left), default=None)
        if text_at is None or text_at - left < 120:
            continue

        rpr = first.find(qn("w:rPr"))
        font = _fonts(first) or "Symbol"
        sz = rpr.find(qn("w:sz")).get(qn("w:val")) if rpr is not None and rpr.find(qn("w:sz")) is not None else "20"
        color = rpr.find(qn("w:color")).get(qn("w:val")) if rpr is not None and rpr.find(qn("w:color")) is not None else "000000"
        key = (glyph, font, sz, color)
        if key not in made:
            lvl_rpr = f'<w:rPr><w:rFonts w:ascii="{font}" w:hAnsi="{font}" w:eastAsia="{font}" w:hint="default"/><w:color w:val="{color}"/><w:sz w:val="{sz}"/></w:rPr>'
            xml = (f'<w:abstractNum {nsdecls("w")} w:abstractNumId="{next_a}"><w:multiLevelType w:val="hybridMultilevel"/>'
                   f'<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="{glyph}"/><w:lvlJc w:val="left"/>'
                   f'<w:pPr><w:ind w:left="{text_at}" w:hanging="{text_at - left}"/></w:pPr>{lvl_rpr}</w:lvl></w:abstractNum>')
            first_num = numbering.find(qn("w:num"))
            node = parse_xml(xml)
            if first_num is not None:
                first_num.addprevious(node)
            else:
                numbering.append(node)
            numbering.append(parse_xml(f'<w:num {nsdecls("w")} w:numId="{next_n}"><w:abstractNumId w:val="{next_a}"/></w:num>'))
            made[key] = next_n
            next_a += 1
            next_n += 1

        # numPr goes after the style / keep* elements and before spacing, ind and the rest
        num_pr = parse_xml(f'<w:numPr {nsdecls("w")}><w:ilvl w:val="0"/><w:numId w:val="{made[key]}"/></w:numPr>')
        anchor = next((c for c in ppr if c.tag in {qn(t) for t in ("w:suppressLineNumbers", "w:pBdr", "w:shd", "w:tabs", "w:suppressAutoHyphens", "w:kinsoku", "w:wordWrap", "w:overflowPunct", "w:topLinePunct", "w:autoSpaceDE", "w:autoSpaceDN", "w:bidi", "w:adjustRightInd", "w:snapToGrid", "w:spacing", "w:ind")}), None)
        if anchor is not None:
            anchor.addprevious(num_pr)
        else:
            ppr.append(num_pr)
        ppr.remove(tabs)
        ind.set(qn("w:left"), str(text_at))
        ind.set(qn("w:hanging"), str(text_at - left))
        for attr in ("w:firstLine", "w:start"):
            if ind.get(qn(attr)) is not None:
                del ind.attrib[qn(attr)]
        p.remove(first)
        p.remove(second)
        converted += 1
    return converted


def fix_docx(path):
    import docx
    d = docx.Document(path)
    stats = {"rows": fix_row_heights(d.element.body), "bullets": bullets_to_lists(d)}
    d.save(path)
    return stats

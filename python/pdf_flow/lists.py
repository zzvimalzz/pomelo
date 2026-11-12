# SPDX-License-Identifier: AGPL-3.0-or-later
"""Numbering: the bullet and numbered lists the document needs."""

import itertools
import re

from docx.oxml import parse_xml
from docx.oxml.ns import nsdecls
from docx.oxml.ns import qn

from pdf_fonts import word_family
from pdf_spans import hexcolor

from .common import esc


class Lists:
    """Bullet and numbering definitions, made once per look and per run of numbers. It also hands out the drawing ids, which must be unique in the whole document."""

    def __init__(self):
        self.drawing_ids = itertools.count(1001)
        self.made = {}
        self.next_a = 1
        self.next_n = 1
        self.last = {}                 # (indent key) -> (last number, numId)
        self.looks = {}                # the look of each kind of table -> the id of its table style

    def setup(self, doc):
        part = doc.part.numbering_part.element
        ids_a = [int(a.get(qn("w:abstractNumId"))) for a in part.findall(qn("w:abstractNum"))]
        ids_n = [int(n.get(qn("w:numId"))) for n in part.findall(qn("w:num"))]
        self.next_a = (max(ids_a) + 1) if ids_a else 1
        self.next_n = (max(ids_n) + 1) if ids_n else 1
        self.part = part

    def item(self, doc, marker, line):
        kind, token, mx0, tx0 = marker
        span = next((s for s in line.spans if s["text"].strip()), line.spans[0])
        font = esc(word_family(span["font"]) or "Arial")
        sz = max(2, round(span["size"] * 2))
        color = hexcolor(span["color"])
        hang = max(0, tx0 - mx0)
        if kind == "bullet":
            glyph = {"o": "o", "": "•", "": "▪", "": "➢", "": "❖", "": "■", "": "✓", "": "□", "": "o"}.get(token, token)
            key = ("b", glyph, sz, color, round(hang))
            if key not in self.made:
                font_bullet = "Courier New" if glyph == "o" else "Arial"
                self.made[key] = self.define(f'<w:numFmt w:val="bullet"/><w:suff w:val="tab"/><w:lvlText w:val="{esc(glyph)}"/>', f'<w:rFonts w:ascii="{font_bullet}" w:hAnsi="{font_bullet}" w:cs="{font_bullet}" w:hint="default"/><w:color w:val="{color}"/><w:sz w:val="{sz}"/>', 1)
            return self.made[key]
        digits = re.sub(r"[^0-9a-z]", "", token)
        paren = token.startswith("(")
        suffix = token[-1]
        if digits.isdigit():
            fmt, start = "decimal", int(digits)
        else:
            fmt, start = "lowerLetter", ord(digits[0]) - 96 if digits else 1
        key = ("n", fmt, suffix, paren, sz, color, round(hang))
        last = self.last.get(key)
        if last and last[0] + 1 == start:
            self.last[key] = (start, last[1])
            return last[1]
        text = ("(" if paren else "") + "%1" + suffix
        num_id = self.define(f'<w:numFmt w:val="{fmt}"/><w:suff w:val="tab"/><w:lvlText w:val="{text}"/>', f'<w:rFonts w:ascii="{font}" w:hAnsi="{font}" w:cs="{font}"/><w:color w:val="{color}"/><w:sz w:val="{sz}"/>', start)
        self.last[key] = (start, num_id)
        return num_id

    def table_style(self, look):
        return self.looks.setdefault(look, f"PDFTable{len(self.looks) + 1}")

    def define(self, fmt, rpr, start):
        a, n = self.next_a, self.next_n
        self.next_a += 1
        self.next_n += 1
        abstract = parse_xml(f'<w:abstractNum {nsdecls("w")} w:abstractNumId="{a}"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="{start}"/>{fmt}<w:lvlJc w:val="left"/><w:rPr>{rpr}</w:rPr></w:lvl></w:abstractNum>')
        first_num = self.part.find(qn("w:num"))
        if first_num is not None:
            first_num.addprevious(abstract)
        else:
            self.part.append(abstract)
        self.part.append(parse_xml(f'<w:num {nsdecls("w")} w:numId="{n}"><w:abstractNumId w:val="{a}"/></w:num>'))
        return n

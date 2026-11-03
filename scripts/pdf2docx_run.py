# SPDX-License-Identifier: AGPL-3.0-or-later
"""Pomelo helper: layout-preserving PDF -> DOCX using pdf2docx (MIT). It needs PyMuPDF (AGPL-3.0) and is run
as a separate process, never linked into the app.

usage: python pdf2docx_run.py <input.pdf> <output.docx>
Prints OK on success; a one-line error on stderr otherwise (exit 1 failed, 2 not installed).

Fixes applied on top of stock pdf2docx:
  * Subset fonts with stripped name tables made pdf2docx write EMPTY font names. Spans now keep their real name.
  * PostScript font names (Cambria-Bold, TimesNewRomanPS-BoldMT, ...) are turned into Word family names
    (Cambria, Times New Roman); bold/italic stay as run flags.
"""
import re
import sys
import warnings

warnings.filterwarnings("ignore")

try:
    from pdf2docx import Converter
    from pdf2docx.font.Fonts import Fonts
    from pdf2docx.text.TextSpan import TextSpan
except Exception as e:  # not installed
    sys.stderr.write("pdf2docx is not available: %s\n" % e)
    sys.exit(2)

# ---- font name clean-up ----------------------------------------------------------------------------
KNOWN = {
    "TIMESNEWROMAN": "Times New Roman", "TIMESNEWROMANPS": "Times New Roman", "TIMESNEWROMANPSMT": "Times New Roman",
    "ARIAL": "Arial", "ARIALMT": "Arial", "ARIALNARROW": "Arial Narrow", "ARIALBLACK": "Arial Black",
    "COURIERNEW": "Courier New", "COURIERNEWPS": "Courier New", "COURIERNEWPSMT": "Courier New",
    "TAHOMA": "Tahoma", "VERDANA": "Verdana", "GEORGIA": "Georgia", "TREBUCHETMS": "Trebuchet MS",
    "SEGOEUI": "Segoe UI", "CALIBRILIGHT": "Calibri Light", "CAMBRIAMATH": "Cambria Math",
    "LIBERATIONSERIF": "Liberation Serif", "LIBERATIONSANS": "Liberation Sans", "LIBERATIONMONO": "Liberation Mono",
    "HELVETICA": "Arial", "HELVETICANEUE": "Helvetica Neue", "TIMES": "Times New Roman", "COURIER": "Courier New",
}
STYLE_TAIL = re.compile(r"[-,_ ]?(BoldItalic|BoldOblique|Bold|Italic|Oblique|Regular|Roman|Semibold|Medium|BdIt|It|Bd|MT|PS)+$", re.I)


def word_family(name: str) -> str:
    base = (name or "").split("+")[-1].strip()
    if not base:
        return base
    key = re.sub(r"[^A-Za-z]", "", base).upper()
    stripped = base
    for _ in range(3):  # peel -Bold, -Italic, MT, PS ... repeatedly (TimesNewRomanPS-BoldItalicMT)
        new = STYLE_TAIL.sub("", stripped)
        if new == stripped or not new:
            break
        stripped = new
    skey = re.sub(r"[^A-Za-z]", "", stripped).upper()
    if skey in KNOWN:
        return KNOWN[skey]
    if key in KNOWN:
        return KNOWN[key]
    stripped = stripped.replace("-", " ").replace("_", " ")
    stripped = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", stripped) if " " not in stripped and len(stripped) > 14 else stripped
    return stripped.strip()


# 1) never let a font record with an empty name override a span's own font name
_orig_get = Fonts.get


def _get(self, font_name):
    f = _orig_get(self, font_name)
    return f if (f is not None and f.name) else None


Fonts.get = _get

# 2) normalise names as spans are created
_orig_init = TextSpan.__init__


def _init(self, raw=None):
    _orig_init(self, raw)
    self.font = word_family(self.font) or self.font


TextSpan.__init__ = _init

# ---- standalone horizontal rules ---------------------------------------------------------------------
# pdf2docx drops stray lines (section dividers, title underlines). Re-create them as a top border on the
# paragraph that follows the rule, and take the distance back out of that paragraph's space-before so the
# page layout does not shift.
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from pdf2docx.text.TextBlock import TextBlock

_PBDR_SUCCESSORS = (
    "w:shd", "w:tabs", "w:suppressAutoHyphens", "w:kinsoku", "w:wordWrap", "w:overflowPunct", "w:topLinePunct",
    "w:autoSpaceDE", "w:autoSpaceDN", "w:bidi", "w:adjustRightInd", "w:snapToGrid", "w:spacing", "w:ind",
    "w:contextualSpacing", "w:mirrorIndents", "w:suppressOverlap", "w:jc", "w:textDirection", "w:textAlignment",
    "w:textboxTightWrap", "w:outlineLvl", "w:divId", "w:cnfStyle", "w:rPr", "w:sectPr", "w:pPrChange",
)


def _hex(rgb):
    r, g, b = (max(0, min(255, round(c * 255))) for c in rgb[:3])
    return "%02X%02X%02X" % (r, g, b)


def find_rules(fitz_page, page_width):
    min_len = page_width * 0.3
    rules = []
    for d in fitz_page.get_drawings():
        r = d["rect"]
        items = d["items"]
        if d["type"] == "s" and d.get("color") and len(items) == 1 and items[0][0] == "l":
            p1, p2 = items[0][1], items[0][2]
            if abs(p1.y - p2.y) <= 0.6 and abs(p2.x - p1.x) >= min_len:
                rules.append({"y": (p1.y + p2.y) / 2, "width": d.get("width") or 1.0, "color": _hex(d["color"])})
        elif d["type"] == "f" and d.get("fill") and r.height <= 2.5 and r.width >= min_len and tuple(d["fill"][:3]) != (1.0, 1.0, 1.0):
            rules.append({"y": (r.y0 + r.y1) / 2, "width": max(r.height, 0.5), "color": _hex(d["fill"])})
    return rules


def apply_rules(cv):
    for page in cv.pages:
        if not getattr(page, "finalized", False):
            continue
        rules = find_rules(cv.fitz_doc[page.id], page.width)
        if not rules:
            continue
        text_blocks, tables = [], []
        for sec in page.sections:
            for col in sec:
                for blk in col.blocks:
                    (text_blocks if blk.is_text_block else tables).append(blk)
        for rule in rules:
            y = rule["y"]
            if any(t.bbox.y0 - 1 <= y <= t.bbox.y1 + 1 for t in tables if not t.is_text_block):
                continue                                   # a table border, already handled
            if any(b.bbox.y0 + 1 < y < b.bbox.y1 - 1 for b in text_blocks):
                continue                                   # inside a paragraph: an underline / strike
            below = [b for b in text_blocks if b.bbox.y0 >= y - 1 and not hasattr(b, "_zest_rule")]
            if not below:
                continue
            blk = min(below, key=lambda b: b.bbox.y0)
            gap = blk.bbox.y0 - y
            if gap > 120:
                continue
            space = int(max(1, min(31, round(gap - 1))))
            blk._zest_rule = (max(2, int(round(rule["width"] * 8))), rule["color"], space)
            blk.before_space = max(blk.before_space - (space + rule["width"]), 0.0)


_orig_make_docx = TextBlock.make_docx


def _make_docx(self, p):
    _orig_make_docx(self, p)
    rule = getattr(self, "_zest_rule", None)
    if rule:
        size, color, space = rule
        pPr = p._p.get_or_add_pPr()
        for old in pPr.findall(qn("w:pBdr")):
            pPr.remove(old)
        bdr = OxmlElement("w:pBdr")
        top = OxmlElement("w:top")
        for k, v in (("val", "single"), ("sz", str(size)), ("space", str(space)), ("color", color)):
            top.set(qn("w:" + k), v)
        bdr.append(top)
        pPr.insert_element_before(bdr, *_PBDR_SUCCESSORS)


TextBlock.make_docx = _make_docx

# ---- run ---------------------------------------------------------------------------------------------
src, dst = sys.argv[1], sys.argv[2]
try:
    cv = Converter(src)
    try:
        settings = cv.default_settings
        cv.parse(**settings)
        try:
            apply_rules(cv)
        except Exception as e:  # rules are a nicety: never fail the conversion over them
            sys.stderr.write("rule pass skipped: %s\n" % e)
        cv.make_docx(dst, **settings)
    finally:
        cv.close()
except Exception as e:
    sys.stderr.write("pdf2docx failed: %s\n" % str(e).replace("\n", " ")[:300])
    sys.exit(1)
print("OK")

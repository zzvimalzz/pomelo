# SPDX-License-Identifier: AGPL-3.0-or-later
"""PDF -> DOCX, page by page; the entry point is convert()."""

import os
import sys

from docx import Document
from docx.oxml import parse_xml
from docx.oxml.ns import nsdecls
from docx.oxml.ns import qn
import pymupdf

from pdf_spans import dominant_size

from .builder import Builder
from .common import NS, area, inside, overlap, tw
from .fonts import FontMeter
from .lines import read_lines
from .lists import Lists
from .page import Page
from .shapes import Fig, Img, Rule


def body_size(all_lines):
    return dominant_size((sp["text"], sp["size"]) for l in all_lines for sp in l.spans)


def convert(src, dst, progress=lambda f: None, log=lambda m: None):
    doc = pymupdf.open(src)
    if doc.needs_pass:
        raise RuntimeError("This PDF is password-protected")
    work_all = pymupdf.open(src)
    work_keep = pymupdf.open(src)
    meter = FontMeter(doc)
    out = Document()
    body = out.element.body
    for el in list(body):
        if el.tag != qn("w:sectPr"):
            body.remove(el)
    lists = Lists()
    lists.setup(out)

    # the size of ordinary text, for the whole document: headings and list detection key off it
    sample = []
    for page in list(doc)[:60]:
        sample += [l for l in read_lines(page) if not l.rot]
    body_pt = body_size(sample)

    n = len(doc)
    totals = {"words": 0}
    for pno in range(n):
        progress(0.97 * pno / max(1, n))
        page = doc[pno]
        try:
            xml, sect = convert_page(doc, work_all, work_keep, out, page, pno, meter, lists, body_pt, n, log)
        except Exception as e:                                         # one odd page must not lose the document: its text is kept
            log("page %d could not be rebuilt in full (%s); kept as text" % (pno + 1, e))
            xml, sect = convert_page(doc, work_all, work_keep, out, page, pno, meter, lists, body_pt, n, log, safe=True)
        for el in list(parse_xml(f'<w:body {NS}>{xml}</w:body>')):
            body.insert(len(body) - 1, el)
        if pno == n - 1:
            final = body.find(qn("w:sectPr"))
            body.replace(final, parse_xml(sect))
    meta = doc.metadata or {}
    props = out.core_properties
    props.title = meta.get("title") or ""
    props.author = meta.get("author") or ""
    props.subject = meta.get("subject") or ""
    props.keywords = meta.get("keywords") or ""
    out.save(dst)


def convert_page(doc, work_all, work_keep, out, page, pno, meter, lists, body_pt, n_pages, log, safe=False):
    """safe: only the text, as paragraphs (what a page falls back to when something exotic in it cannot be rebuilt)."""
    P = Page(doc, work_all[pno], work_keep[pno], page, pno, meter, body_pt)
    P.read()
    P.tbls = []
    if not safe:
        P.tables()
    P.decorate()
    # a page that is one big picture with an invisible text layer is a scan: the picture is dropped, the text is kept
    big = [i for i in page.get_image_info() if area(tuple(i["bbox"])) > 0.85 * P.w * P.h]
    scan = False
    if big and P.upright:
        try:
            trace = page.get_texttrace()
            hidden = sum(len(t.get("chars", [])) for t in trace if t.get("type") == 3)
            total = sum(len(t.get("chars", [])) for t in trace) or 1
            scan = hidden / total > 0.8
        except Exception:
            scan = False
    P.pictures(ocr_scan=scan)
    P.boxes()
    if safe:
        P.imgs, P.box_items = [], []
    # a colour that covers the whole page is the page's background: a one-pixel picture stretched behind everything
    P.page_fills = []
    background = []
    for b in list(P.box_items):
        if area(b.bbox) >= 0.9 * P.w * P.h and b.fill:
            P.box_items.remove(b)
            P.page_fills.append((b.bbox, b.fill))
            rgb = tuple(int(b.fill[i:i + 2], 16) for i in (0, 2, 4))
            px = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 2, 2), False)
            px.clear_with(0)
            for xx in range(2):
                for yy in range(2):
                    px.set_pixel(xx, yy, rgb)
            background.append(Fig((0.0, 0.0, P.w, P.h), px.tobytes("png"), "png", floating=True))
            background[-1].overlay = True

    # redact the text we recreate from two copies of the page: one with all of it gone (to find leftovers), one that
    # keeps the text that belongs to a chart or a logo (to cut pictures from)
    rot_boxes = []
    for l in P.rotated:
        b = list(l.bbox)
        for o in rot_boxes:
            if overlap(tuple(b), tuple(o)) > 0 or (abs(o[0] - b[0]) < 30 and abs(o[1] - b[1]) < 30):
                o[:] = [min(o[0], b[0]), min(o[1], b[1]), max(o[2], b[2]), max(o[3], b[3])]
                break
        else:
            rot_boxes.append(b)
    P.rot_boxes = [tuple(b) for b in rot_boxes]
    rot_boxes = P.rot_boxes
    all_lines = [l for l in P.upright if not any(overlap(l.bbox, r) > 0.05 * area(l.bbox) for r in rot_boxes)]
    def boxes_of(l):
        out = [s["bbox"] for s in l.spans]
        if l.marker_box:
            out.append(l.marker_box)
        return out
    for l in all_lines:
        for bb in boxes_of(l):
            r = pymupdf.Rect(bb)
            inset = r.height * 0.18
            P.work_all.add_redact_annot(pymupdf.Rect(r.x0, r.y0 + inset, r.x1, r.y1 - inset), fill=False)
    if all_lines:
        P.work_all.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE, graphics=pymupdf.PDF_REDACT_LINE_ART_NONE, text=pymupdf.PDF_REDACT_TEXT_REMOVE)
    if safe:
        P.figs = []
    else:
        P.leftovers()
    merged = []
    for b in P.rot_boxes:
        box = list(b)
        for f in list(P.figs):
            if f[0] - 8 <= box[2] and box[0] - 8 <= f[2] and f[1] - 8 <= box[3] and box[1] - 8 <= f[3]:
                box = [min(box[0], f[0]), min(box[1], f[1]), max(box[2], f[2]), max(box[3], f[3])]
                P.figs.remove(f)
        merged.append(tuple(box))
    P.rot_boxes = merged

    # text that belongs to a picture (chart labels): stays in the picture
    absorbed = set()
    for f in P.figs:
        inside_lines = [l for l in P.upright if inside(l.bbox, f, 1.0)]
        if len(inside_lines) >= 5 and sum(len(l.text) for l in inside_lines) / len(inside_lines) <= 16 and 8000 < area(f) <= 0.35 * P.w * P.h:
            for l in inside_lines:
                absorbed.add(id(l))
    for l in P.upright:
        if id(l) in absorbed:
            l.absorbed = True
    keep_lines = [l for l in all_lines if not l.absorbed]
    for l in keep_lines:
        for bb in boxes_of(l):
            r = pymupdf.Rect(bb)
            inset = r.height * 0.18
            P.work_keep.add_redact_annot(pymupdf.Rect(r.x0, r.y0 + inset, r.x1, r.y1 - inset), fill=False)
    if keep_lines:
        P.work_keep.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE, graphics=pymupdf.PDF_REDACT_LINE_ART_NONE, text=pymupdf.PDF_REDACT_TEXT_REMOVE)

    text_lines = [l for l in P.upright if not l.absorbed]
    # elements
    elements = []
    tbls = P.tbls
    boxes = P.box_items
    # pictures: in line with the text, or behind it when text sits on top
    def sits_on(bb):
        return any(overlap(l.bbox, bb) >= 0.5 * area(l.bbox) for l in text_lines)
    for r, info in P.imgs:
        data = P.encode_image(info, r)
        if not data:
            continue
        elements.append(Img(r, data[0], data[1], floating=sits_on(r)))
    for f in P.figs:
        data = P.render_clip(f)
        if not data:
            continue
        elements.append(Fig(f, data[0], data[1], floating=sits_on(f) and area(f) > 600))
    elements += background
    for b in P.rot_boxes:                                           # rotated text (a stamp, a margin label) stays a picture
        data = P.render_clip(pymupdf.Rect(b) + (-2, -2, 2, 2))
        if data:
            fig = Fig(b, data[0], data[1], floating=True)
            fig.overlay = True
            elements.append(fig)
    # rules
    rules = []
    for i, (o, pos, a, b, width, color, d) in enumerate(P.segments):
        if o == "h" and i not in P.used_segments and (b - a) >= 0.28 * P.w and width <= 4:
            rules.append(Rule((a, pos - width / 2, b, pos + width / 2), width, color))
    # assign lines, pictures, boxes to the smallest container that holds them
    containers = tbls + boxes
    def owner(bb):
        best = None
        for c in containers:
            if c.kind == "tbl":
                for cell in c.cells:
                    if inside(bb, cell["bbox"], 1.0):
                        return ("cell", c, cell)
            elif inside(bb, c.bbox, 1.0) and (best is None or area(c.bbox) < area(best[1].bbox)):
                best = ("box", c, None)
        return best
    top_items = []
    behind = [e.bbox for e in elements if e.kind == "img" and e.floating and not getattr(e, "overlay", False)]
    framed = [l for l in text_lines if any(overlap(l.bbox, b) >= 0.5 * area(l.bbox) for b in behind)]
    text_lines = [l for l in text_lines if l not in framed]
    pool = text_lines + elements + rules
    for it in pool:
        o = owner(it.bbox)
        if o is None:
            top_items.append(it)
        elif o[0] == "cell":
            o[2]["items"].append(it)
        else:
            o[1].children.append(it)
    # a box inside a box goes inside; a box inside a table cell goes in the cell
    for b in sorted(boxes + tbls, key=lambda b: area(b.bbox)):
        placed = False
        for c in containers:
            if c is b:
                continue
            if c.kind == "tbl":
                for cell in c.cells:
                    if inside(b.bbox, cell["bbox"], 1.0):
                        cell["items"].append(b)
                        placed = True
                        break
            elif c.kind == "box" and inside(b.bbox, c.bbox, 1.0) and area(c.bbox) > area(b.bbox) * 1.02:
                c.children.append(b)
                placed = True
            if placed:
                break
        if not placed:
            top_items.append(b)
    for c in boxes:
        c.children = [i for i in c.children if i is not c]

    flow = [i for i in top_items if not (i.kind == "img" and i.floating)]
    for i in top_items:
        if i.kind == "img" and i.floating:
            P.floaters.append(i)
    # rotated text: a text box, rotated
    B = Builder(out, P, meter, lists)
    if flow:
        x0 = min(i.x0 for i in flow)
        x1 = max(i.x1 for i in flow)
    else:
        x0, x1 = 0.0, P.w
    B.page_x1 = x1
    B.slack = max(0.0, min(10.0, P.w - x1 - 0.5))
    xml, cursor = B.emit(flow, x0, x1, None)
    if framed:
        xml += B.frames(framed)
    if os.environ.get("POMELO_DEBUG"):
        lost = [l for l in P.upright if not l.absorbed and id(l) not in B.emitted]
        if lost:
            sys.stderr.write("page %d: %d lines never written: %s\n" % (pno + 1, len(lost), " | ".join(l.text for l in lost)[:300]))
    top_margin = max(0.0, B.first_top if B.first_top is not None else 0.0)
    room = P.h - (cursor if cursor is not None else top_margin)
    bottom_margin = 0.0 if room < 70 else min(room - 14, 30.0)
    # the closing paragraph carries the floating pictures and ends the section
    floats = ""
    for it in sorted(P.floaters, key=lambda i: -area(i.bbox)):
        floats += B.picture_xml(it, floating=True, name="Picture")
    inner = (f'<w:type w:val="nextPage"/><w:pgSz w:w="{tw(P.w)}" w:h="{tw(P.h)}"/>'
             f'<w:pgMar w:top="{tw(top_margin)}" w:right="{tw(max(0.0, P.w - x1 - B.slack))}" w:bottom="{tw(bottom_margin)}" w:left="{tw(x0)}" w:header="0" w:footer="0" w:gutter="0"/>')
    sect = f'<w:sectPr {nsdecls("w")}>{inner}</w:sectPr>'
    mark = '<w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/></w:rPr>'
    if pno < n_pages - 1:
        closing = f'<w:p><w:pPr>{mark}<w:sectPr>{inner}</w:sectPr></w:pPr>{floats}</w:p>'
    else:
        closing = f'<w:p><w:pPr>{mark}</w:pPr>{floats}</w:p>'
    return xml + closing, sect

# SPDX-License-Identifier: AGPL-3.0-or-later
"""PDF -> DOCX, page by page; the entry point is convert()."""

import math
import os
import re
import sys

from docx import Document
from docx.oxml import parse_xml
from docx.oxml.ns import nsdecls, qn
import pymupdf

from pdf_spans import dominant_size

from .builder import Builder
from .common import HI_DPI, NS, area, inside, overlap, tw
from .fonts import FontMeter
from .lines import read_lines
from .lists import Lists
from .page import Page, page_kind
from .shapes import Fig, Img, Rule
from .structure import Furniture, attach, body_font, set_styles


def body_size(all_lines):
    return dominant_size((sp["text"], sp["size"]) for l in all_lines for sp in l.spans)


def open_upright(src):
    """The document and two working copies, with /Rotate pages turned upright, and the rotation each page had: the text
    coordinates of a rotated page are those of the unrotated sheet, so reading them as they are scatters the page."""
    doc = pymupdf.open(src)
    if doc.needs_pass:
        raise RuntimeError("This PDF is password-protected")
    turns = {p.number: p.rotation for p in doc if p.rotation}
    if not turns:
        return doc, pymupdf.open(src), pymupdf.open(src), turns
    for p in doc:
        p.set_rotation(0)
    blob = doc.tobytes()
    doc.close()
    return (*(pymupdf.open("pdf", blob) for _ in range(3)), turns)


def convert(src, dst, progress=lambda f: None, log=lambda m: None):
    doc, work_all, work_keep, turns = open_upright(src)
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
        meter.register(page)
        sample += [l for l in read_lines(page) if not l.rot]
    body_pt = body_size(sample)
    meter.hyphenated = {w.lower() for l in sample for w in re.findall(r"[^\W\d_]+-[^\W\d_]+", l.text)}
    font = body_font(sample, body_pt, meter)
    half = max(2, round(body_pt * 2))
    meter.base = (font, half)

    n = len(doc)
    furniture = Furniture(doc, turns) if n > 1 else None
    states = []
    for pno in range(n):
        progress(0.97 * pno / max(1, n))
        page = doc[pno]
        try:
            xml, sect, furn = convert_page(doc, work_all, work_keep, out, page, pno, meter, lists, body_pt, n, log, furniture, turn=turns.get(pno, 0))
        except Exception as e:                                         # one odd page must not lose the document: its text is kept
            log("page %d could not be rebuilt in full (%s); kept as text" % (pno + 1, e))
            xml, sect, furn = convert_page(doc, work_all, work_keep, out, page, pno, meter, lists, body_pt, n, log, None, safe=True, turn=turns.get(pno, 0))
        sections = xml.count("<w:sectPr>") + (pno == n - 1)
        if len(furn) != sections:
            log("page %d has %d sections but %d header and footer states" % (pno + 1, sections, len(furn)))
            furn = (list(furn) + list(furn[-1:]) * sections)[:sections]
        states.extend(furn)
        for el in list(parse_xml(f'<w:body {NS}>{xml}</w:body>')):
            body.insert(len(body) - 1, el)
        if pno == n - 1:
            final = body.find(qn("w:sectPr"))
            body.replace(final, parse_xml(sect))
    set_styles(out, font, half, lists.looks)
    attach(out, states, log)
    meta = doc.metadata or {}
    props = out.core_properties
    props.title = meta.get("title") or ""
    props.author = meta.get("author") or ""
    props.subject = meta.get("subject") or ""
    props.keywords = meta.get("keywords") or ""
    out.save(dst)


def boxes_of(l):
    out = [s["bbox"] for s in l.spans]
    if l.marker_box:
        out.append(l.marker_box)
    return out


def mark_text(work, lines):
    """Queue the lines of text on a copy of the page for removal. A line's box is cut short on its thin side, so that the next line's letters are not taken with it."""
    for l in lines:
        for bb in boxes_of(l):
            r = pymupdf.Rect(bb)
            if r.width >= r.height:
                r = pymupdf.Rect(r.x0, r.y0 + 0.18 * r.height, r.x1, r.y1 - 0.18 * r.height)
            else:
                r = pymupdf.Rect(r.x0 + 0.18 * r.width, r.y0, r.x1 - 0.18 * r.width, r.y1)
            work.add_redact_annot(r, fill=False)


def convert_page(doc, work_all, work_keep, out, page, pno, meter, lists, body_pt, n_pages, log, furniture, safe=False, turn=0):
    """-> (the page's XML, its section's properties, the XML of the header and of the footer of each of its sections).
    safe: only the text, as paragraphs (what a page falls back to when something exotic in it cannot be rebuilt).
    turn: the /Rotate of the page; it is built upright and shown turned, in a text box the size of the sheet."""
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
    P.figs = [f for f in P.figs if not any(overlap(f, r) > 0.8 * area(f) for r, _ in P.imgs)]
    kind, why = page_kind(P)
    if os.environ.get("POMELO_DEBUG"):
        sys.stderr.write("page %d: %s page (%s)\n" % (pno + 1, kind, why))
    if kind == "design" and not (safe or scan or turn):
        return (*design_page(P, out, meter, lists, pno, n_pages), [("", "")])
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
    mark_text(P.work_keep, P.rotated)
    if keep_lines or P.rotated:
        P.work_keep.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE, graphics=pymupdf.PDF_REDACT_LINE_ART_NONE, text=pymupdf.PDF_REDACT_TEXT_REMOVE)

    text_lines = [l for l in P.upright if not l.absorbed]
    # elements
    elements = []
    tbls = P.tbls
    boxes = P.box_items
    # pictures: in line with the text, or behind it when text sits on top
    def sits_on(bb):
        return any(overlap(l.bbox, bb) >= 0.5 * area(l.bbox) for l in text_lines)

    def ends_page(bb):
        # a wide picture at the foot of the page is placed, not set in the line: when Word sets the text above a little
        # taller, an in-line picture would move to a new sheet whole
        return bb[2] - bb[0] >= 0.6 * P.w and bb[3] >= 0.88 * P.h
    # a photo cropped to a circle is placed as the photo itself, so the page copy the ring and shadow under it are cut from must not show it again
    placed = {}
    for r, info in P.imgs:
        if info.get("full"):
            placed[id(info)] = P.encode_image(info, r)
            if info.get("crop") and info["ellipse"] and info["unique"]:
                P.work_keep.delete_image(info["xref"])
    for r, info in P.imgs:
        data = placed.get(id(info)) or P.encode_image(info, r)
        if not data:
            continue
        elements.append(Img(r, data[0], data[1], floating=sits_on(r) or ends_page(r), crop=info.get("crop"), ellipse=info.get("ellipse"), order=info.get("number") or 0))
    for f in P.figs:
        data = P.render_clip(f)
        if not data:
            continue
        elements.append(Fig(f, data[0], data[1], floating=sits_on(f) and area(f) > 600))
    pics = [e for e in elements if e.kind == "img"]
    for a in pics:
        if any(b is not a and overlap(a.bbox, b.bbox) >= 0.5 * min(area(a.bbox), area(b.bbox)) for b in pics):
            a.floating = True                                       # a picture on a picture keeps its place on the page
    elements += background
    for b in P.rot_boxes:                                           # what surrounds turned text (a stamp's frame and colour) stays a picture
        data = P.render_clip(pymupdf.Rect(b) + (-2, -2, 2, 2))
        if data:
            fig = Fig(b, data[0], data[1], floating=True)
            fig.overlay = True
            elements.append(fig)
    # rules
    rules = []
    for i, (o, pos, a, b, width, color, d) in enumerate(P.segments):
        edge_of_box = any(bx.border and min(b, bx.x1) - max(a, bx.x0) >= 0.9 * (b - a) and (abs(pos - bx.y0) <= 2 or abs(pos - bx.y1) <= 2) for bx in boxes)
        if o == "h" and i not in P.used_segments and (b - a) >= 0.28 * P.w and width <= 4 and not edge_of_box:
            rules.append(Rule((a, pos - width / 2, b, pos + width / 2), width, color))
    for e in pics:
        if any(e.y0 + 1 < (r.y0 + r.y1) / 2 < e.y1 - 1 and min(r.x1, e.x1) - max(r.x0, e.x0) >= 0.5 * (r.x1 - r.x0) for r in rules):
            e.floating = True
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
    feet = [e.bbox for e in elements if e.kind == "img" and e.floating and ends_page(e.bbox)]
    framed += [l for l in text_lines if l not in framed and any(0 <= l.y0 - b[3] <= 30 and l.x0 >= b[0] - 2 and l.x1 <= b[2] + 2 for b in feet)]
    taken = {"header": [], "footer": []}
    if furniture and not (safe or scan or turn):
        for l in text_lines:
            band = None if l in framed or owner(l.bbox) is not None else furniture.take(l, pno, P.h)
            if band:
                taken[band].append(l)
        text_lines = [l for l in text_lines if not any(l is t for ts in taken.values() for t in ts)]
    if not turn:
        low = [l for l in text_lines if l not in framed and l.y0 >= 0.9 * P.h and owner(l.bbox) is None]
        above = [l.y1 for l in text_lines if l not in framed and l not in low] + [e.bbox[3] for e in elements if not getattr(e, "floating", False)]
        # a footer sits at the foot of the sheet whatever the text above grows to, so it is placed, not set after a long gap
        if low and (not above or min(l.y0 for l in low) - max(above) >= 24):
            framed += low
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
    B.columns_ok = not (safe or scan or turn)
    if flow:
        x0 = max(0.0, min(i.x0 for i in flow))
        x1 = max(i.x1 for i in flow)
    else:
        x0, x1 = 0.0, P.w
    B.page_x1 = x1
    B.slack = max(0.0, min(10.0, P.w - x1 - 0.5))
    xml, cursor = B.emit(flow, x0, x1, None)
    if framed:
        xml += B.frames(framed)
    furn = tuple("".join(B.frames([l], 1.2 * l.size if any(sp.get("field") for sp in l.spans) else 0.0) for l in taken[k]) for k in ("header", "footer"))
    if os.environ.get("POMELO_DEBUG"):
        lost = [l for l in P.upright if not l.absorbed and id(l) not in B.emitted]
        if lost:
            sys.stderr.write("page %d: %d lines never written: %s\n" % (pno + 1, len(lost), " | ".join(l.text for l in lost)[:300]))
    top_margin = max(0.0, B.first_top if B.first_top is not None else 0.0)
    room = P.h - (cursor if cursor is not None else top_margin)
    bottom_margin = 0.0 if room < 70 else min(room - 14, 30.0)
    turned = bool(turn) and not framed
    B.turn = turn if turned else 0
    floats = ""
    # larger pictures go underneath; pictures of about the same size are stacked as the PDF painted them
    for it in sorted(P.floaters, key=lambda i: (-round(math.log(max(area(i.bbox), 1.0)) / 0.1), getattr(i, "order", 0))):
        floats += B.picture_xml(it, floating=True, name="Picture")
    floats += "".join(B.turned_text_box(l) for l in P.rotated)
    # the pictures are anchored in the page's first paragraph: when the text runs a line over, the closing paragraph moves
    # to the next sheet, and the background would go with it. A page that starts with something else keeps them in the closing one.
    if floats and not turned and xml.startswith("<w:p><w:pPr>") and not re.match(r"<w:p><w:pPr>(<w:pStyle [^>]*/>)?<w:framePr", xml):
        cut = xml.index("</w:pPr>") + len("</w:pPr>")
        xml, floats = xml[:cut] + floats + xml[cut:], ""
    elif floats and not turned and xml.startswith("<w:tbl>"):
        # a shaded cell would hide pictures that sit behind the text in the same cell, so only a plain first cell is used
        cell = re.search(r"<w:tc><w:tcPr>(.*?)</w:tcPr><w:p><w:pPr>.*?</w:pPr>", xml)
        if cell and cell.start() == xml.index("<w:tc>") and "<w:shd" not in cell.group(1):
            xml, floats = xml[:cell.end()] + floats.replace('layoutInCell="1"', 'layoutInCell="0"') + xml[cell.end():], ""
    margins = (top_margin, max(0.0, P.w - x1 - B.slack), bottom_margin, x0)
    if turned:
        xml = B.turned_page(xml, margins)
        sheet_w, sheet_h, margins = (P.w, P.h, (0.0,) * 4) if turn == 180 else (P.h, P.w, (0.0,) * 4)
    else:
        sheet_w, sheet_h = P.w, P.h
    props = page_props(sheet_w, sheet_h, margins)
    xml, count = end_sections(xml, props)
    closing, sect = close_page(props, floats, pno, n_pages, count)
    return xml + closing, sect, [furn] * (count + 1)


def page_props(sheet_w, sheet_h, margins):
    return (f'<w:pgSz w:w="{tw(sheet_w)}" w:h="{tw(sheet_h)}"{' w:orient="landscape"' if sheet_w > sheet_h else ''}/>'
            f'<w:pgMar w:top="{tw(margins[0])}" w:right="{tw(margins[1])}" w:bottom="{tw(margins[2])}" w:left="{tw(margins[3])}" w:header="0" w:footer="0" w:gutter="0"/>')


def end_sections(xml, props):
    """The marks that columns leave in the page's XML become the sections they end: the first section of a page starts on a new sheet, the others follow on the same one."""
    count = 0

    def section(m):
        nonlocal count
        count += 1
        return f'<w:sectPr><w:type w:val="{"nextPage" if count == 1 else "continuous"}"/>{props}{m.group(1)}</w:sectPr>'
    return re.sub("\x01SECT:(.*?)\x01", section, xml), count


def close_page(props, floats, pno, n_pages, count):
    """The closing paragraph of a page, which carries its pictures and ends its last section, and the section's properties."""
    mark = '<w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/></w:rPr>'
    inner = f'<w:type w:val="{"continuous" if count else "nextPage"}"/>{props}'
    sect = f'<w:sectPr {nsdecls("w")}>{inner}</w:sectPr>'
    if pno < n_pages - 1:
        return f'<w:p><w:pPr>{mark}<w:sectPr>{inner}</w:sectPr></w:pPr>{floats}</w:p>', sect
    return f'<w:p><w:pPr>{mark}</w:pPr>{floats}</w:p>', sect


def design_page(P, out, meter, lists, pno, n_pages):
    """A page set freely over pictures and colour: the page without its text is one picture behind everything, and each
    paragraph of text is a text box at its place on the sheet. Nothing flows, so the page cannot spill onto a second sheet.
    A line turned at any angle is a turned text box."""
    mark_text(P.work_all, P.upright + P.rotated)
    P.work_all.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE, graphics=pymupdf.PDF_REDACT_LINE_ART_NONE, text=pymupdf.PDF_REDACT_TEXT_REMOVE)
    for t in P.tbls:
        for l in P.upright:
            cell = next((c for c in t.cells if inside(l.bbox, c["bbox"], 1.0)), None)
            if cell:
                cell["items"].append(l)
    tables = P.tbls + P.aligned_tables()
    for t in P.tbls:
        art = P.table_art(t)
        if art is None:
            for c in t.cells:
                c["fill"], c["borders"] = None, {}
        for rect in art or []:
            P.work_all.add_redact_annot(pymupdf.Rect(rect), fill=False)
    if P.work_all.first_annot:
        P.work_all.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE, graphics=pymupdf.PDF_REDACT_LINE_ART_REMOVE_IF_COVERED, text=pymupdf.PDF_REDACT_TEXT_NONE)
    B = Builder(out, P, meter, lists)
    B.placed = True
    floats = ""
    dpi = min(HI_DPI, int(72 * math.sqrt(25e6 / (P.w * P.h))))           # a poster-sized sheet stays under about 25 megapixels
    data = P.render_clip((0.0, 0.0, P.w, P.h), dpi=dpi, from_keep=False)
    if data:
        floats = B.picture_xml(Fig((0.0, 0.0, P.w, P.h), data[0], data[1], floating=True), floating=True, name="Picture")
    held = {id(l) for t in tables for c in t.cells for l in c["items"]}
    body, boxes = B.text_boxes([l for l in P.upright if id(l) not in held], tables)
    floats += boxes + "".join(B.turned_text_box(l) for l in P.rotated)
    closing, sect = close_page(page_props(P.w, P.h, (0.0, 0.0, 0.0, 0.0)), floats, pno, n_pages, 0)
    return body + closing, sect

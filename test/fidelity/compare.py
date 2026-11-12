# SPDX-License-Identifier: AGPL-3.0-or-later
"""How closely does a converted document match the original? Both are PDFs here (the converted DOCX is printed
back to PDF first), so words, fonts, links, images and drawn shapes can be compared exactly, not eyeballed.

usage: python compare.py <original.pdf> <rendered.pdf> [png-dir tag]    prints one JSON object
       python compare.py --docx-words <original.pdf> <converted.docx>   prints how many source words the DOCX holds,
                                                                        and how editable it is (text boxes, tables, headings)

Words are matched in reading order; for every matched pair the position, font family, size, bold/italic and colour
are compared. Numbers are fractions 0..1 unless the key says otherwise. "check" is the summary of what a user sees
when the DOCX is printed: pages, how many printed words come from the source (recall), whether they come in the
same order, and how alike the pages look.
"""
import difflib
import io
import json
import os
import re
import sys
import warnings
import xml.etree.ElementTree as ET
import zipfile
from collections import Counter

warnings.filterwarnings("ignore")
import pymupdf  # noqa: E402

STYLE_TAIL = re.compile(r"[-,_ ]?(BoldItalic|BoldOblique|Bold|Italic|Oblique|Regular|Roman|Semibold|Medium|MT|PS)+$", re.I)
SYNONYM = {"helvetica": "arial", "liberationsans": "arial", "liberationserif": "timesnewroman", "times": "timesnewroman",
           "liberationmono": "couriernew", "courier": "couriernew", "dejavusans": "arial"}


def family(name):
    base = re.sub(r"^[A-Z]{6}\+", "", name or "")
    for _ in range(3):
        new = STYLE_TAIL.sub("", base)
        if new == base or not new:
            break
        base = new
    key = re.sub(r"[^a-z0-9]", "", base.lower())
    return SYNONYM.get(key, key)


def norm(word):
    return (word.replace(" ", " ").replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
            .replace("–", "-").replace("—", "-").replace("•", "*").replace("", "*").replace("●", "*").replace("−", "-"))


def words_of(doc):
    out = []
    for pno, page in enumerate(doc):
        for block in page.get_text("rawdict")["blocks"]:
            for line in block.get("lines", []):
                for span in line["spans"]:
                    # position = where the word starts on its baseline: that is what a reader sees, and unlike the
                    # box around the glyphs it does not depend on the font's declared ascent
                    cur, box = "", None
                    for ch in span["chars"]:
                        c = ch["c"]
                        if c.isspace():
                            if cur:
                                out.append((cur, box, span, pno))
                            cur, box = "", None
                            continue
                        cur += c
                        o = ch["origin"]
                        box = [o[0], o[1], o[0], o[1]] if box is None else [box[0], box[1], o[0], o[1]]
                    if cur:
                        out.append((cur, box, span, pno))
    return out


def rgb(c):
    return ((c >> 16) & 255, (c >> 8) & 255, c & 255)


def colour_close(a, b):
    ra, rb = rgb(a), rgb(b)
    return sum(abs(x - y) for x, y in zip(ra, rb)) <= 60


def iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def text_metrics(da, db):
    wa, wb = words_of(da), words_of(db)
    ta = [norm(w[0]) for w in wa]
    tb = [norm(w[0]) for w in wb]
    sm = difflib.SequenceMatcher(None, ta, tb, autojunk=False)
    pairs = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            pairs += [(wa[i1 + k], wb[j1 + k]) for k in range(i2 - i1)]
    n = max(1, len(pairs))
    dist, fam, size, bold, ital, col = [], 0, 0, 0, 0, 0
    sdx, sdy = [], []
    for a, b in pairs:
        pa = pymupdf.Point(a[1][0], a[1][1])
        pb = pymupdf.Point(b[1][0], b[1][1])
        sdx.append(b[1][0] - a[1][0])
        sdy.append(b[1][1] - a[1][1])
        dist.append(abs(a[3] - b[3]) * 10000 + pa.distance_to(pb))
        sa, sb = a[2], b[2]
        fam += family(sa["font"]) == family(sb["font"])
        size += abs(sa["size"] - sb["size"]) <= 0.4
        bold += bool(sa["flags"] & 16) == bool(sb["flags"] & 16) or ("bold" in sa["font"].lower()) == ("bold" in sb["font"].lower())
        ital += bool(sa["flags"] & 2) == bool(sb["flags"] & 2) or ("italic" in sa["font"].lower() or "oblique" in sa["font"].lower()) == ("italic" in sb["font"].lower() or "oblique" in sb["font"].lower())
        col += colour_close(sa["color"], sb["color"])
    dist.sort()
    miss = [" ".join(ta[i1:i2]) for tag, i1, i2, j1, j2 in sm.get_opcodes() if tag in ("delete", "replace")]
    extra = [" ".join(tb[j1:j2]) for tag, i1, i2, j1, j2 in sm.get_opcodes() if tag in ("insert", "replace")]
    return {
        "words": [len(ta), len(tb)],
        "text": round(sm.ratio(), 4),
        "pos_1pt": round(sum(d <= 1.5 for d in dist) / n, 4),
        "pos_4pt": round(sum(d <= 4 for d in dist) / n, 4),
        "pos_median_pt": round(dist[len(dist) // 2], 2) if dist else None,
        "dx_median": round(sorted(sdx)[len(sdx) // 2], 2) if sdx else None,
        "dy_median": round(sorted(sdy)[len(sdy) // 2], 2) if sdy else None,
        "pos_p90_pt": round(dist[int(len(dist) * 0.9)], 2) if dist else None,
        "font_family": round(fam / n, 4), "font_size": round(size / n, 4), "bold": round(bold / n, 4), "italic": round(ital / n, 4), "colour": round(col / n, 4),
        "missing": miss[:10], "extra": extra[:10],
    }


def images(doc):
    out = []
    for pno, page in enumerate(doc):
        for info in page.get_image_info():
            b = info["bbox"]
            if (b[2] - b[0]) * (b[3] - b[1]) > 16:
                out.append((pno, list(b)))
    return out


def image_metrics(da, db):
    ia, ib = images(da), images(db)
    used, scores = set(), []
    for pno, b in ia:
        best, bi = 0.0, None
        for k, (qno, c) in enumerate(ib):
            if k in used or qno != pno:
                continue
            s = iou(b, c)
            if s > best:
                best, bi = s, k
        if bi is not None:
            used.add(bi)
        scores.append(best)
    return {"count": [len(ia), len(ib)], "placement_iou": round(sum(scores) / len(scores), 3) if scores else None}


def link_metrics(da, db):
    def uris(d):
        out = []
        for page in d:
            for lk in page.get_links():
                if lk.get("uri"):
                    out.append(lk["uri"].rstrip("/").lower())
        return out
    a, b = uris(da), uris(db)
    kept = sum(1 for u in set(a) if u in set(b))
    return {"count": [len(a), len(b)], "kept": round(kept / len(set(a)), 3) if a else None}


def drawing_metrics(da, db):
    def shapes(d):
        lines = fills = 0
        for page in d:
            for dr in page.get_drawings():
                r = dr["rect"]
                if dr["type"] in ("f", "fs") and r.width * r.height > 4 and tuple((dr.get("fill") or (1, 1, 1))[:3]) != (1.0, 1.0, 1.0):
                    fills += 1
                elif dr["type"] in ("s", "fs") or (dr["type"] == "f" and min(r.width, r.height) <= 2.5):
                    lines += 1
        return lines, fills
    la, fa = shapes(da)
    lb, fb = shapes(db)
    return {"rules_or_strokes": [la, lb], "filled_shapes": [fa, fb]}


def visual_metrics(da, db, png=None):
    scores, tile_bad = [], []
    for i in range(min(len(da), len(db))):
        pa = da[i].get_pixmap(dpi=40, colorspace=pymupdf.csGRAY)
        pb = db[i].get_pixmap(dpi=40, colorspace=pymupdf.csGRAY)
        if (pa.width, pa.height) != (pb.width, pb.height):
            scores.append(0.0)
            tile_bad.append(1.0)
            continue
        sa, sb = pa.samples, pb.samples
        scores.append(1 - sum(abs(x - y) for x, y in zip(sa, sb)) / (len(sa) * 255))
        w, h = pa.width, pa.height
        bad = total = 0
        for ty in range(0, h - 4, 4):
            for tx in range(0, w - 4, 4):
                ma = mb = 0
                for dy in range(4):
                    row = (ty + dy) * w + tx
                    ma += sum(sa[row:row + 4])
                    mb += sum(sb[row:row + 4])
                total += 1
                bad += abs(ma - mb) / 16 > 40
        tile_bad.append(bad / max(1, total))
    return {"similarity": round(sum(scores) / len(scores), 4) if scores else 0.0, "tiles_off": round(sum(tile_bad) / len(tile_bad), 4) if tile_bad else 1.0}


def plain_words(doc):
    out = []
    for page in doc:
        for w in page.get_text("words"):
            t = re.sub(r"\W+", "", w[4].lower())
            if t:
                out.append(t)
    return out


def grey_pages(da, db, dpi=36):
    for i in range(min(len(da), len(db))):
        pa, pb = (d[i].get_pixmap(dpi=dpi, colorspace=pymupdf.csGRAY) for d in (da, db))
        w, h = min(pa.width, pb.width), min(pa.height, pb.height)
        yield [b"".join(p.samples[y * p.width:y * p.width + w] for y in range(h)) for p in (pa, pb)]


def check_metrics(da, db):
    wa, wb = plain_words(da), plain_words(db)
    recall = order = None
    if wa:
        recall = round(sum((Counter(wa) & Counter(wb)).values()) / len(wa), 3)
        # the cap keeps the quadratic matcher fast on long documents
        order = round(difflib.SequenceMatcher(None, wa[:3000], wb[:3000], autojunk=False).ratio(), 3) if wb else 0.0
    sims = [1 - sum(abs(x - y) for x, y in zip(a, b)) / (255 * max(1, len(a))) for a, b in grey_pages(da, db)]
    pairs = list(zip(da, db))
    return {
        "recall": recall,
        "order": order,
        "visual": round(sum(sims) / len(sims), 3) if sims else 0.0,
        "size_ok": sum(abs(a.rect.width - b.rect.width) < 6 and abs(a.rect.height - b.rect.height) < 6 for a, b in pairs),
        "orientation_ok": sum((a.rect.width > a.rect.height) == (b.rect.width > b.rect.height) for a, b in pairs),
    }


def docx_text(path):
    """Text of the body, headers and footers. A tab or a line break separates words like a space does; the runs of
    one paragraph are joined as they are, because Word splits a word into runs wherever the formatting changes. A header
    or footer counts once for every page that shows it, a section that starts on a new sheet: a section without a reference of its own shows the one before, and a
    continuous section is on the sheet of the one before."""
    w = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"

    def text_of(data):
        out = []
        for event, el in ET.iterparse(io.BytesIO(data), events=("end",)):
            if el.tag == w + "t":
                out.append(el.text or "")
            elif el.tag in (w + "tab", w + "br", w + "cr", w + "p"):
                out.append(" ")
        return "".join(out)

    with zipfile.ZipFile(path) as z:
        body = z.read("word/document.xml")
        rels_part = "word/_rels/document.xml.rels"
        rels = {m.group(1): m.group(2) for m in re.finditer(r'<Relationship [^>]*?Id="([^"]+)"[^>]*?Target="([^"]+)"', z.read(rels_part).decode())} if rels_part in z.namelist() else {}
        shown = Counter()
        current = {"header": None, "footer": None}
        for sect in re.findall(r"<w:sectPr[ >].*?</w:sectPr>", body.decode(), re.S):
            for kind, rid in re.findall(r'<w:(header|footer)Reference [^>]*?r:id="([^"]+)"', sect):
                current[kind] = "word/" + rels[rid] if rid in rels else None
            if '<w:type w:val="continuous"/>' not in sect:
                shown.update(t for t in current.values() if t)
        parts = [n for n in z.namelist() if re.fullmatch(r"word/(header|footer)\d*\.xml", n)]
        texts = [text_of(body)]
        for n in parts:
            texts += [text_of(z.read(n))] * (shown[n] or 1)
    return "".join(texts)


def docx_editability(path):
    """How editable the body is: the share of its words inside text boxes, Word tables, heading paragraphs, and
    paragraphs with text whose line height is fixed. A paragraph holding a text box does not count the box's words."""
    w = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    with zipfile.ZipFile(path) as z:
        body = z.read("word/document.xml")
    stack, boxes = [], 0
    words = in_boxes = tables = headings = exact = 0
    for event, el in ET.iterparse(io.BytesIO(body), events=("start", "end")):
        tag = el.tag
        if event == "start":
            if tag == w + "p":
                stack.append({"text": [], "heading": False, "exact": False})
            elif tag == w + "txbxContent":
                boxes += 1
            elif tag == w + "pStyle" and stack:
                style = el.get(w + "val", "")
                stack[-1]["heading"] = bool(re.fullmatch(r"Heading[1-9]|Title", style))
            elif tag == w + "spacing" and stack and el.get(w + "lineRule") == "exact":
                stack[-1]["exact"] = True
            continue
        if tag == w + "t" and stack:
            stack[-1]["text"].append(el.text or "")
        elif tag in (w + "tab", w + "br", w + "cr") and stack:
            stack[-1]["text"].append(" ")
        elif tag == w + "tbl":
            tables += 1
        elif tag == w + "txbxContent":
            boxes -= 1
        elif tag == w + "p":
            para = stack.pop()
            n = len("".join(para["text"]).split())
            words += n
            in_boxes += n if boxes else 0
            headings += para["heading"]
            exact += bool(n and para["exact"])
    return {"tb": round(in_boxes / words, 3) if words else 0.0, "tables": tables, "headings": headings, "exact": exact}


def docx_words(pdf, docx):
    src = plain_words(pymupdf.open(pdf))
    have = [t for t in (re.sub(r"\W+", "", x.lower()) for x in docx_text(docx).split()) if t]
    lost = Counter(src) - Counter(have)
    return {"words": len(src), "recall": round(1 - sum(lost.values()) / len(src), 3) if src else None, "missing": sorted(lost)[:10],
            **docx_editability(docx)}


def main():
    if sys.argv[1] == "--docx-words":
        print(json.dumps(docx_words(sys.argv[2], sys.argv[3])))
        return
    orig, cand = sys.argv[1], sys.argv[2]
    da, db = pymupdf.open(orig), pymupdf.open(cand)
    res = {
        "pages": [len(da), len(db)],
        "page_size_pt": [[round(x) for x in da[0].rect[2:]], [round(x) for x in db[0].rect[2:]]],
        "text": text_metrics(da, db),
        "images": image_metrics(da, db),
        "links": link_metrics(da, db),
        "drawings": drawing_metrics(da, db),
        "visual": visual_metrics(da, db),
        "check": check_metrics(da, db),
    }
    if len(sys.argv) > 4:
        os.makedirs(sys.argv[3], exist_ok=True)
        for tag, d in (("orig", da), ("docx", db)):
            for i, page in enumerate(d):
                page.get_pixmap(dpi=80).save(os.path.join(sys.argv[3], f"{sys.argv[4]}_{tag}_p{i + 1}.png"))
    t = res["text"]
    # pictures are judged by how the page looks (a picture merged into the page background still looks right), so
    # the image count and placement are reported but not scored
    parts = [t["text"], t["pos_4pt"], (t["font_family"] + t["font_size"] + t["bold"] + t["italic"]) / 4, res["visual"]["similarity"], res["visual"]["similarity"]]
    if res["links"]["kept"] is not None:
        parts.append(res["links"]["kept"])
    res["score"] = round(sum(parts) / len(parts), 4)
    print(json.dumps(res))


main()

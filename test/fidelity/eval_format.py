# SPDX-License-Identifier: AGPL-3.0-or-later
"""Scores a PDF's conversion into a text-like or image format against the PDF itself.

usage: python eval_format.py <txt|md|html|epub|xlsx|png|jpg> <original.pdf> <output file or folder>   prints one JSON object

Words are compared as bags of lower-case word characters (so markup and punctuation choices do not count against a
converter): recall = how much of the PDF's text arrived, precision = how much of the output was in the PDF, order =
how well the sequence of words matches. Links, headings, list items, tables and pictures are counted on both sides.
"""
import difflib
import glob
import html as htmllib
import json
import os
import re
import sys
import warnings
import zipfile
from collections import Counter

warnings.filterwarnings("ignore")
import pymupdf  # noqa: E402

WORD = re.compile(r"\w+", re.U)
BULLETS = "•●▪◦·*-–—"


def words(text):
    return [w.lower() for w in WORD.findall(text)]


def reference(pdf):
    doc = pymupdf.open(pdf)
    text, links, imgs, tables, heads, bullets = [], [], 0, [], 0, 0
    sizes = []
    for page in doc:
        for b in page.get_text("dict")["blocks"]:
            for l in b.get("lines", []):
                for s in l["spans"]:
                    if s["text"].strip():
                        sizes += [s["size"]] * len(s["text"])
    body = sorted(sizes)[len(sizes) // 2] if sizes else 10
    for page in doc:
        text.append(page.get_text("text"))
        links += [l["uri"].rstrip("/").lower() for l in page.get_links() if l.get("uri")]
        imgs += sum(1 for i in page.get_image_info() if (i["bbox"][2] - i["bbox"][0]) * (i["bbox"][3] - i["bbox"][1]) > 400)
        try:
            for t in page.find_tables().tables:
                cells = [" ".join(c.split()) for row in t.extract() for c in row if c and c.strip()]
                if cells:
                    tables.append(cells)
        except Exception:
            pass
        for b in page.get_text("dict")["blocks"]:
            for l in b.get("lines", []):
                spans = [s for s in l["spans"] if s["text"].strip()]
                if not spans:
                    continue
                first = spans[0]["text"].strip()
                if first and first[0] in BULLETS and len(first) <= 2 or re.match(r"^\d{1,2}[.)]$", first):
                    bullets += 1
                elif max(s["size"] for s in spans) >= body * 1.25 and len(" ".join(s["text"] for s in spans)) < 90:
                    heads += 1
    return {"text": "\n".join(text), "links": links, "images": imgs, "tables": tables, "headings": heads, "bullets": bullets, "pages": len(doc)}


def strip_html(src):
    src = re.sub(r"(?is)<(script|style|head)[^>]*>.*?</\1>", " ", src)
    src = re.sub(r"(?s)<[^>]+>", " ", src)
    return htmllib.unescape(src)


def read_markup(fmt, path):
    """-> text, links, headings, list items, tables, images"""
    if fmt == "epub":
        z = zipfile.ZipFile(path)
        raw = "\n".join(z.read(n).decode("utf8", "replace") for n in z.namelist() if re.search(r"\.(x?html?)$", n) and "nav" not in os.path.basename(n).lower())
        fmt = "html"
    else:
        raw = open(path, encoding="utf8", errors="replace").read()
    if fmt == "html":
        links = [h.rstrip("/").lower() for h in re.findall(r'(?i)<a\s[^>]*href="([^"]+)"', raw)]
        return strip_html(raw), links, len(re.findall(r"(?i)<h[1-6][\s>]", raw)), len(re.findall(r"(?i)<li[\s>]", raw)), len(re.findall(r"(?i)<table[\s>]", raw)), len(re.findall(r"(?i)<img[\s>]", raw))
    if fmt == "md":
        links = [m.rstrip("/").lower() for m in re.findall(r"(?<!!)\[[^\]]*\]\(([^)\s]+)", raw)] + [m.rstrip("/").lower() for m in re.findall(r"<(https?://[^>]+)>", raw)]
        heads = len(re.findall(r"(?m)^#{1,6}\s", raw)) + len(re.findall(r"(?m)^\s*\*\*[^*\n]{2,80}\*\*\s*$", raw))
        lists = len(re.findall(r"(?m)^\s*([-*+]|\d+[.)])\s+", raw))
        tables = len(re.findall(r"(?m)^\|?\s*:?-{3,}", raw))
        imgs = len(re.findall(r"!\[[^\]]*\]\(", raw))
        body = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", raw)
        body = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", body)
        return body, links, heads, lists, tables, imgs
    return raw, [], 0, 0, 0, 0


def xlsx_text(path):
    z = zipfile.ZipFile(path)
    out = []
    for n in z.namelist():
        if n.endswith("sharedStrings.xml") or re.match(r"xl/worksheets/sheet\d+\.xml", n):
            x = z.read(n).decode("utf8", "replace")
            out += re.findall(r"<t[^>]*>([^<]*)</t>", x)
            if "worksheets" in n:
                out += re.findall(r"<v>([^<]*)</v>", x)
    sheets = len([n for n in z.namelist() if re.match(r"xl/worksheets/sheet\d+\.xml", n)])
    return htmllib.unescape(" ".join(out)), sheets


def bag_scores(ref_words, out_words):
    a, b = Counter(ref_words), Counter(out_words)
    hit = sum((a & b).values())
    recall = hit / max(1, sum(a.values()))
    precision = hit / max(1, sum(b.values()))
    order = difflib.SequenceMatcher(None, ref_words, out_words, autojunk=False).ratio() if len(ref_words) < 8000 else None
    missing = [w for w, c in (a - b).most_common(12)]
    extra = [w for w, c in (b - a).most_common(8)]
    return {"recall": round(recall, 4), "precision": round(precision, 4), "order": round(order, 4) if order is not None else None, "missing": missing, "extra": extra}


def main():
    fmt, pdf, out = sys.argv[1], sys.argv[2], sys.argv[3]
    ref = reference(pdf)
    rw = words(ref["text"])
    res = {"format": fmt, "pdf_words": len(rw), "pdf_links": len(ref["links"]), "pdf_images": ref["images"], "pdf_tables": len(ref["tables"]), "pdf_headings": ref["headings"], "pdf_bullets": ref["bullets"], "pages": ref["pages"]}
    if fmt in ("txt", "md", "html", "epub"):
        if fmt == "txt":
            text, links, heads, lists, tables, imgs = open(out, encoding="utf8", errors="replace").read(), [], 0, 0, 0, 0
        else:
            text, links, heads, lists, tables, imgs = read_markup(fmt, out)
        ow = words(text)
        res.update(bag_scores(rw, ow))
        res["out_words"] = len(ow)
        res["links"] = {"pdf": len(ref["links"]), "out": len(links), "kept": round(sum(1 for u in set(ref["links"]) if any(u == v or u in v or v in u for v in links)) / max(1, len(set(ref["links"]))), 3) if ref["links"] else None}
        res["structure"] = {"headings": heads, "list_items": lists, "tables": tables, "images": imgs}
    elif fmt == "xlsx":
        text, sheets = xlsx_text(out)
        ow = Counter(words(text))
        cells = [c for t in ref["tables"] for c in t]
        got = sum(1 for c in cells if all(ow[w] > 0 for w in words(c))) if cells else None
        res.update(bag_scores(rw, list(ow.elements())))
        res["tables_in_pdf"] = len(ref["tables"])
        res["sheets"] = sheets
        res["table_cells"] = {"pdf": len(cells), "found": got, "recall": round(got / len(cells), 3) if cells else None}
    elif fmt in ("png", "jpg"):
        files = sorted(glob.glob(os.path.join(out, "*"))) if os.path.isdir(out) else [out]
        doc = pymupdf.open(pdf)
        sims = []
        for i, f in enumerate(files[: len(doc)]):
            got = pymupdf.Pixmap(f)
            if got.alpha:
                got = pymupdf.Pixmap(got, 0)
            got = pymupdf.Pixmap(pymupdf.csGRAY, got)
            scale = got.width / doc[i].rect.width            # draw the PDF page at the output's own resolution
            ref_pix = pymupdf.Pixmap(pymupdf.csGRAY, doc[i].get_pixmap(matrix=pymupdf.Matrix(scale, scale)))
            if abs(ref_pix.width - got.width) > 2 or abs(ref_pix.height - got.height) > 2:
                sims.append(0.0)
                continue
            w, h = min(ref_pix.width, got.width), min(ref_pix.height, got.height)
            sa, sb = ref_pix.samples, got.samples
            total = diff = 0
            for y in range(0, h, 3):                      # every third row and column: plenty for a look-alike score
                ra, rb = y * ref_pix.width, y * got.width
                for x in range(0, w, 3):
                    diff += abs(sa[ra + x] - sb[rb + x])
                    total += 255
            sims.append(1 - diff / max(1, total))
        first = pymupdf.Pixmap(files[0]) if files else None
        res.update({"files": len(files), "pages_expected": len(doc), "look": round(sum(sims) / len(sims), 4) if sims else 0.0,
                    "first_size_px": [first.width, first.height] if first else None, "page_size_pt": [round(doc[0].rect.width), round(doc[0].rect.height)]})
    print(json.dumps(res, ensure_ascii=False))


main()

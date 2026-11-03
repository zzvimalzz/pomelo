# SPDX-License-Identifier: AGPL-3.0-or-later
"""Pomelo helper: find the tables in a PDF with PyMuPDF and write them as JSON for the Excel writer.

usage: python pdf_tables_run.py <input.pdf> <output.json>
Output: [{"page": 1, "index": 1, "kind": "table" | "text", "rows": [["cell", ...], ...]}, ...]

Ruled tables are read as they are drawn. A page with no ruled table gets its aligned rows read as one when they really
form a grid (three or more rows, two or more columns, short cells, and the cells hold exactly the page's text in that
box). A PDF with no table at all still gives something useful: each page's text lines, split into cells at wide gaps.
Prints POMELO_PROGRESS lines while it works.
"""
import json
import os
import re
import sys
import warnings
from collections import Counter

warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    import pymupdf
except Exception as e:
    sys.stderr.write("PyMuPDF is not available: %s\n" % e)
    sys.exit(2)
import pdf_common  # noqa: E402

WORD = re.compile(r"\w+", re.U)


def read_cells(page, table):
    # table.extract() joins characters by position and drops spaces in some fonts; read each cell's text
    # through the page text layer instead, which keeps the real spacing.
    rows = []
    for row in table.rows:
        cells = []
        for cell in row.cells:
            if cell is None:
                cells.append("")
                continue
            text = page.get_text("text", clip=pymupdf.Rect(cell))
            cells.append(" ".join(text.split()))
        rows.append(cells)
    return rows


def holds_the_text(page, table, rows):
    """The cells hold what the page shows inside the table's box: nothing lost, nothing made up."""
    inside = Counter(WORD.findall(page.get_text("text", clip=pymupdf.Rect(table.bbox)).lower()))
    cells = Counter(w for r in rows for c in r for w in WORD.findall(c.lower()))
    hit = sum((inside & cells).values())
    return bool(inside) and hit / sum(inside.values()) >= 0.92 and hit / max(1, sum(cells.values())) >= 0.92


def grid_like(rows, width, page_width):
    if len(rows) < 3 or width < 0.4 * page_width:
        return False
    if max(len(r) for r in rows) < 2 or max(len(r) for r in rows) > 12:
        return False
    if sum(1 for r in rows if sum(1 for c in r if c) >= 2) < 0.7 * len(rows):
        return False
    cells = [c for r in rows for c in r if c]
    return bool(cells) and sum(len(c) for c in cells) / len(cells) < 40


def text_rows(page):
    """Every line of the page as a row; the pieces of a line become cells where the gap is wider than a word space."""
    rows = []
    for block in page.get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            spans = [s for s in line["spans"] if s["text"].strip()]
            if not spans:
                continue
            cells, cur, prev = [], "", None
            for s in sorted(spans, key=lambda s: s["bbox"][0]):
                if prev is not None and s["bbox"][0] - prev["bbox"][2] > 1.5 * s["size"]:
                    cells.append(cur.strip())
                    cur = ""
                cur += s["text"]
                prev = s
            cells.append(cur.strip())
            rows.append((line["bbox"][1], line["bbox"][0], cells))
    rows.sort(key=lambda r: (round(r[0] / 3), r[1]))
    return [r[2] for r in rows]


src, dst = sys.argv[1], sys.argv[2]
found = []
temp = None


def progress(f):
    print("POMELO_PROGRESS %.3f" % min(0.99, f), flush=True)


try:
    path, temp, share = pdf_common.open_for_work(src, progress)
    doc = pymupdf.open(path)
    for pno, page in enumerate(doc):
        progress(share + (1 - share) * 0.95 * pno / len(doc))
        made = 0
        try:
            tables = page.find_tables().tables
        except Exception:
            tables = []
        for table in tables:
            rows = read_cells(page, table)
            if any(any(c for c in row) for row in rows):
                made += 1
                found.append({"page": pno + 1, "index": made, "kind": "table", "rows": rows})
        if made:
            continue
        try:
            guesses = page.find_tables(strategy="text").tables
        except Exception:
            guesses = []
        for table in guesses:
            rows = [r for r in read_cells(page, table) if any(r)]
            if grid_like(rows, table.bbox[2] - table.bbox[0], page.rect.width) and holds_the_text(page, table, rows):
                made += 1
                found.append({"page": pno + 1, "index": made, "kind": "table", "rows": rows})
    if not found:
        for pno, page in enumerate(doc):
            rows = text_rows(page)
            if rows:
                found.append({"page": pno + 1, "index": 1, "kind": "text", "rows": rows})
except SystemExit:
    raise
except Exception as e:
    pdf_common.cleanup(temp)
    pdf_common.fail(e)
pdf_common.cleanup(temp)
if not found:
    sys.stderr.write("This PDF has no text to put in a spreadsheet\n")
    sys.exit(3)

with open(dst, "w", encoding="utf-8") as f:
    json.dump(found, f, ensure_ascii=False)
print("OK")

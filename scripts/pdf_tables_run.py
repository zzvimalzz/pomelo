# SPDX-License-Identifier: AGPL-3.0-or-later
"""Pomelo helper: find tables in a PDF with PyMuPDF and write them as JSON for the Excel writer.

usage: python pdf_tables_run.py <input.pdf> <output.json>
Output: [{"page": 1, "index": 1, "rows": [["cell", ...], ...]}, ...]
"""
import json
import sys
import warnings

warnings.filterwarnings("ignore")

try:
    import pymupdf
except Exception as e:
    sys.stderr.write("PyMuPDF is not available: %s\n" % e)
    sys.exit(2)

src, dst = sys.argv[1], sys.argv[2]
found = []
try:
    doc = pymupdf.open(src)
    for pno, page in enumerate(doc):
        try:
            tables = page.find_tables().tables
        except Exception:
            continue
        for ti, table in enumerate(tables):
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
            if any(any(c for c in row) for row in rows):
                found.append({"page": pno + 1, "index": ti + 1, "rows": rows})
except Exception as e:
    sys.stderr.write("table extraction failed: %s\n" % str(e).replace("\n", " ")[:300])
    sys.exit(1)

with open(dst, "w", encoding="utf-8") as f:
    json.dump(found, f, ensure_ascii=False)
print("OK")

# SPDX-License-Identifier: AGPL-3.0-or-later
"""Pomelo helper: reads a PDF page by page for the PowerPoint writer (PyMuPDF, run as a separate process).

usage: python pdf_pptx_export.py <input.pdf> <output folder>
Writes <folder>/layout.json (text with exact positions, fonts, sizes, colours and links) and one background picture per
page that has anything but text on it; prints POMELO_PROGRESS lines and OK.
"""
import json
import os
import sys
import warnings

warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    from pdf_fixed_layout import export_layout
except Exception as e:
    sys.stderr.write("PyMuPDF is not available: %s\n" % e)
    sys.exit(2)

src, outdir = sys.argv[1], sys.argv[2]
try:
    data = export_layout(src, outdir, lambda f: print("POMELO_PROGRESS %.3f" % f, flush=True))
    with open(os.path.join(outdir, "layout.json"), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
except Exception as e:
    sys.stderr.write("pdf to slides failed: %s\n" % str(e).replace("\n", " ")[:300])
    sys.exit(1)
print("OK")

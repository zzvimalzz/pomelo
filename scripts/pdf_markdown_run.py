# SPDX-License-Identifier: AGPL-3.0-or-later
"""Pomelo helper: PDF -> Markdown with headings, bold/italic, lists and tables (PyMuPDF4LLM, AGPL, separate process).

usage: python pdf_markdown_run.py <input.pdf> <output.md>
"""
import sys
import warnings

warnings.filterwarnings("ignore")

try:
    import pymupdf4llm
except Exception as e:
    sys.stderr.write("pymupdf4llm is not available: %s\n" % e)
    sys.exit(2)

src, dst = sys.argv[1], sys.argv[2]
try:
    text = pymupdf4llm.to_markdown(src, show_progress=False)
except Exception as e:
    sys.stderr.write("pdf to markdown failed: %s\n" % str(e).replace("\n", " ")[:300])
    sys.exit(1)
with open(dst, "w", encoding="utf-8", newline="\n") as f:
    f.write(text)
print("OK")

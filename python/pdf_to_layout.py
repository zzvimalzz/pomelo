# SPDX-License-Identifier: AGPL-3.0-or-later
"""Pomelo helper: reads a PDF page by page for the PowerPoint writer (PyMuPDF, run as a separate process). Scanned pages are read with OCR first.

usage: python pdf_to_layout.py <input.pdf> <output folder>
Writes <folder>/layout.json (text with exact positions, fonts, sizes, colours and links) and one background picture per
page that has anything but text on it; prints POMELO_PROGRESS lines and OK.
"""
import json
import os
import sys

import helper

helper.require("PyMuPDF", "pymupdf")
from pdf_layout import export_layout  # noqa: E402


def main(src, outdir):
    def work(path, progress):
        data = export_layout(path, outdir, progress)
        with open(os.path.join(outdir, "layout.json"), "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)

    helper.run_pdf_job(src, work)
    print("OK")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])

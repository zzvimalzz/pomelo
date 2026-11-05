# SPDX-License-Identifier: AGPL-3.0-or-later
"""Pomelo helper: PDF -> Markdown, HTML or plain text, keeping all of the text (PyMuPDF, run as a separate process).
The reading is in pdf_structure.py.

usage: python pdf_to_text.py <input.pdf> <output> <md|html|txt> [images folder, for md]
Prints POMELO_PROGRESS lines while it works and OK at the end (exit 1 failed, 2 not installed, 3 no text).
"""
import os
import sys

import helper

helper.require("PyMuPDF", "pymupdf")
import pdf_structure  # noqa: E402


def main(src, dst, fmt, images_dir=None):
    blocks, doc_title = helper.run_pdf_job(src, pdf_structure.read)
    if not any(b["type"] in ("para", "heading", "item", "table", "code") for b in blocks):
        helper.exit_no_text("This PDF has no text to convert")
    title = doc_title or os.path.splitext(os.path.basename(src))[0]
    if fmt == "md":
        text = pdf_structure.write_md(blocks, images_dir)
    elif fmt == "html":
        text = pdf_structure.write_html(blocks, title)
    else:
        text = pdf_structure.write_txt(blocks)
    with open(dst, "w", encoding="utf-8", newline=chr(10)) as f:
        f.write(text)
    print("OK")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] if len(sys.argv) > 4 else None)

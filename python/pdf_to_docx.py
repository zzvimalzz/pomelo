# SPDX-License-Identifier: AGPL-3.0-or-later
"""Pomelo helper: PDF -> editable DOCX (PyMuPDF and python-docx, run as a separate process). Scanned pages are read with OCR first.

usage: python pdf_to_docx.py <input.pdf> <output.docx>
Prints POMELO_PROGRESS lines and OK on success; a one-line reason on stderr otherwise
(exit 1 failed, 2 a component is not installed).
"""
import sys

import helper

helper.require("The PDF engine", "pymupdf", "docx")
import pdf_flow  # noqa: E402


def main(src, dst):
    helper.run_pdf_job(src, lambda path, progress: pdf_flow.convert(path, dst, progress, lambda m: sys.stderr.write(m + "\n")))
    print("OK")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])

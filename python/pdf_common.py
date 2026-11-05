# SPDX-License-Identifier: AGPL-3.0-or-later
"""What the PDF helper scripts share: opening a PDF (reading scans with OCR when needed), plain-language reasons for a
failure, and progress figures that add up when OCR is only the first part of the work."""
import os
import sys

import pdf_ocr


def reason(exc):
    """One short sentence a person can act on."""
    msg = str(exc).replace("\n", " ").strip()
    low = msg.lower()
    if isinstance(exc, pdf_ocr.OcrUnavailable):
        return msg
    if "password" in low or "encrypted" in low or "closed or encrypted" in low:
        return "This PDF is password-protected. Remove the password and try again"
    if "failed to open" in low or "cannot open" in low or "no such file" in low or "not a pdf" in low or "format error" in low or "xref" in low or "trailer" in low or "syntax error" in low:
        return "This file is damaged or is not a PDF"
    if "page tree" in low or "no pages" in low or "zero pages" in low:
        return "This PDF has no pages"
    return msg[:200] or "The PDF could not be converted"


def fail(exc, code=1):
    sys.stderr.write(reason(exc) + "\n")
    sys.exit(2 if isinstance(exc, pdf_ocr.OcrUnavailable) else code)


def open_for_work(src, progress):
    """-> (path to read, temporary copy to delete or None, share of the progress bar the OCR took). Scans are read with OCR first."""
    path, made = pdf_ocr.prepare(src, lambda f: progress(0.7 * f))
    return path, (path if made else None), (0.7 if made else 0.0)


def tail(progress, start):
    """Progress for the part after OCR: start..1."""
    return lambda f: progress(start + (1 - start) * f)


def cleanup(path):
    if path:
        try:
            os.remove(path)
        except OSError:
            pass

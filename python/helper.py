# SPDX-License-Identifier: AGPL-3.0-or-later
"""What Pomelo's Python helper scripts share: the start-up check that a package is installed, progress lines, and running a job
on a PDF (scans are read with OCR first, a failure gets a plain-language reason, and the temporary OCR copy is deleted).

Every entry point starts with `import helper` and calls helper.require() before it imports anything that needs a package.
Exit codes: 0 done, 1 failed, 2 a component is not installed, 3 the PDF has no text to convert (exit_no_text).
Output: POMELO_PROGRESS <0..1> lines while it works, OK at the end, a one-line reason on stderr when it fails.
"""
import gc
import importlib
import os
import sys
import time
import warnings

warnings.filterwarnings("ignore")


def require(what, *modules):
    """Exit 2 with a one-line reason when a package the script needs is not installed."""
    try:
        for module in modules:
            importlib.import_module(module)
    except Exception as e:
        sys.stderr.write("%s is not available: %s\n" % (what, e))
        sys.exit(2)


def progress(f):
    print("POMELO_PROGRESS %.3f" % min(0.99, f), flush=True)


def exit_no_text(message):
    sys.stderr.write(message + "\n")
    sys.exit(3)


def reason(exc):
    """One short sentence a person can act on."""
    from pdf_ocr import OcrUnavailable
    msg = str(exc).replace("\n", " ").strip()
    low = msg.lower()
    if isinstance(exc, OcrUnavailable):
        return msg
    if "password" in low or "encrypted" in low or "closed or encrypted" in low:
        return "This PDF is password-protected. Remove the password and try again"
    if "failed to open" in low or "cannot open" in low or "no such file" in low or "not a pdf" in low or "format error" in low or "xref" in low or "trailer" in low or "syntax error" in low:
        return "This file is damaged or is not a PDF"
    if "page tree" in low or "no pages" in low or "zero pages" in low:
        return "This PDF has no pages"
    return msg[:200] or "The PDF could not be converted"


def _remove(path):
    """Delete a temporary file. A document that is still open holds it on Windows, so unreferenced ones are collected first, and a
    scanner that has it for a moment is waited out."""
    for attempt in range(6):
        try:
            os.remove(path)
            return
        except OSError:
            gc.collect()
            time.sleep(0.2)


def run_pdf_job(src, work):
    """work(path, progress) -> result, run on the PDF to read. A scanned PDF is read with OCR first (that is the first 70 % of the
    progress bar) and `path` is then a temporary copy of it. `work` must close every document it opens before it returns: the copy
    is deleted afterwards. A failure becomes a one-line reason on stderr and exit 1 (2 when OCR is needed but not installed)."""
    from pdf_ocr import OcrUnavailable, prepare
    temp = None
    failure = None
    try:
        path, made = prepare(src, lambda f: progress(0.7 * f))
        temp = path if made else None
        share = 0.7 if made else 0.0
        return work(path, lambda f: progress(share + (1 - share) * f))
    except SystemExit:
        raise
    except Exception as e:
        failure = (reason(e), 2 if isinstance(e, OcrUnavailable) else 1)       # strings only: the exception would keep its documents open
    finally:
        if temp:
            _remove(temp)
    sys.stderr.write(failure[0] + "\n")
    sys.exit(failure[1])

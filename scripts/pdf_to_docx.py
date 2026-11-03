# SPDX-License-Identifier: AGPL-3.0-or-later
"""Pomelo helper: PDF -> editable DOCX (PyMuPDF and python-docx, run as a separate process). Scanned pages are read with OCR first.

usage: python pdf_to_docx.py <input.pdf> <output.docx>
Prints POMELO_PROGRESS lines and OK on success; a one-line reason on stderr otherwise
(exit 1 failed, 2 a component is not installed).
"""
import os
import sys
import warnings

warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    import pymupdf  # noqa: F401
    import docx  # noqa: F401
except Exception as e:
    sys.stderr.write("The PDF engine is not available: %s\n" % e)
    sys.exit(2)

import pdf_common  # noqa: E402
import pdf_flow  # noqa: E402


def progress(f):
    print("POMELO_PROGRESS %.3f" % min(0.99, f), flush=True)


if __name__ == "__main__":
    src, dst = sys.argv[1], sys.argv[2]
    temp = None
    try:
        path, temp, share = pdf_common.open_for_work(src, progress)
        pdf_flow.convert(path, dst, pdf_common.tail(progress, share), lambda m: sys.stderr.write(m + "\n"))
    except SystemExit:
        raise
    except Exception as e:
        pdf_common.fail(e)
    finally:
        pdf_common.cleanup(temp)
    print("OK")

# SPDX-License-Identifier: AGPL-3.0-or-later
"""Pomelo helper: loads the OCR engine once, so its models are downloaded while the PDF engine is being installed
(and everything after that works offline). Prints OK; a reason on stderr and exit 1 when the models could not be fetched."""
import os
import sys
import warnings

warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    import pdf_ocr
    pdf_ocr.engine()
except Exception as e:
    sys.stderr.write("%s\n" % str(e).replace("\n", " ")[:200])
    sys.exit(1)
print("OK")

# SPDX-License-Identifier: AGPL-3.0-or-later
"""Pomelo helper: loads the OCR engine once, so its models are downloaded while the PDF engine is being installed
(and everything after that works offline). Prints OK; a reason on stderr and exit 1 when the models could not be fetched."""
import sys

import helper  # noqa: F401  (importing it silences warnings)

def main():
    try:
        import pdf_ocr
        pdf_ocr.engine()
    except Exception as e:
        sys.stderr.write("%s\n" % str(e).replace("\n", " ")[:200])
        sys.exit(1)
    print("OK")


if __name__ == "__main__":
    main()

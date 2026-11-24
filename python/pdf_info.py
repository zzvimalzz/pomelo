# SPDX-License-Identifier: AGPL-3.0-or-later
"""Pomelo helper: facts about a PDF as JSON (PyMuPDF, run as a separate process).

usage: python pdf_info.py <in.pdf> <out.json> properties
properties: the page count and sizes, the PDF version, the document information, whether it is tagged, and its encryption and what
the permissions allow. The first line of standard input, when there is one, is a JSON object with the password ({"password": "..."}).
Exit codes: 0 done, 1 failed (one line on stderr), 2 the PDF engine is not installed.
"""
import json
import sys

import helper

helper.require("The PDF engine", "pymupdf")
import pymupdf  # noqa: E402
import pdf_ops  # noqa: E402

PERMISSIONS = {
    "print": pymupdf.PDF_PERM_PRINT, "printHighQuality": pymupdf.PDF_PERM_PRINT_HQ, "modify": pymupdf.PDF_PERM_MODIFY,
    "copy": pymupdf.PDF_PERM_COPY, "annotate": pymupdf.PDF_PERM_ANNOTATE, "fillForms": pymupdf.PDF_PERM_FORM,
    "accessibility": pymupdf.PDF_PERM_ACCESSIBILITY, "assemble": pymupdf.PDF_PERM_ASSEMBLE,
}
INFORMATION = ("title", "author", "subject", "keywords", "creator", "producer", "creationDate", "modDate")


def properties(doc):
    meta = doc.metadata
    marked = doc.xref_get_key(doc.pdf_catalog(), "MarkInfo/Marked")[1] == "true"
    return {
        "pageCount": doc.page_count,
        "pages": [{"width": page.rect.width, "height": page.rect.height, "rotation": page.rotation} for page in doc],
        "version": meta.get("format"),
        "information": {key: meta.get(key) or "" for key in INFORMATION},
        "tagged": marked,
        "encryption": meta.get("encryption"),
        "permissions": {name: bool(doc.permissions & flag) for name, flag in PERMISSIONS.items()},
    }


def main(src, dst, what):
    secrets = {}
    try:
        secrets = pdf_ops.read_secrets()
        if what != "properties":
            raise ValueError("unknown request %s" % json.dumps(what)[:40])
        doc = pdf_ops.open_doc(src, secrets.get("password"))
        try:
            text = json.dumps(properties(doc), ensure_ascii=False)
        finally:
            doc.close()
        with open(dst, "w", encoding="utf-8") as f:
            f.write(text)
    except SystemExit:
        raise
    except Exception as e:
        pdf_ops.fail(e, secrets)
    print("OK")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3])

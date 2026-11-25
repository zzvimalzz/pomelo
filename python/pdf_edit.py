# SPDX-License-Identifier: AGPL-3.0-or-later
"""Pomelo helper: applies a list of changes to a PDF and writes the next version (PyMuPDF, run as a separate process).

usage: python pdf_edit.py <in.pdf> <out.pdf> <ops.json>
The first line of standard input, when there is one, is a JSON object with the password of <in.pdf> ({"password": "..."}).
<in.pdf> is never changed. When every change only adds to the file or edits an object in place, <out.pdf> is <in.pdf> with the
changes appended; otherwise it is written whole. Prints {"saved": "incremental"} or {"saved": "full"}, then {"pages": n} with the
number of pages <in.pdf> has, then OK. Nothing is left at <out.pdf> when it fails. Exit codes: 0 done, 1 failed (one line on stderr),
2 the PDF engine is not installed.
"""
import json
import os
import shutil
import sys

import helper

helper.require("The PDF engine", "pymupdf")
import pdf_ops  # noqa: E402


def edit(src, dst, ops, password):
    doc = pdf_ops.open_doc(src, password)
    try:
        in_place = pdf_ops.incremental(ops) and doc.can_save_incrementally()
        if in_place:
            doc.close()
            shutil.copyfile(src, dst)
            doc = pdf_ops.open_doc(dst, password)
        pages = doc.page_count
        pdf_ops.apply(doc, ops, helper.progress)
        pdf_ops.save(doc, dst, in_place)
        return in_place, pages
    finally:
        if not doc.is_closed:
            doc.close()


def main(src, dst, ops_file):
    secrets = {}
    try:
        secrets = pdf_ops.read_secrets()
        in_place, pages = edit(src, dst, pdf_ops.load(ops_file), secrets.get("password"))
    except SystemExit:
        raise
    except Exception as e:
        if os.path.exists(dst):
            helper._remove(dst)
        pdf_ops.fail(e, secrets)
    print(json.dumps({"saved": "incremental" if in_place else "full"}))
    print(json.dumps({"pages": pages}))
    print("OK")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3])

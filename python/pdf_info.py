# SPDX-License-Identifier: AGPL-3.0-or-later
"""Pomelo helper: facts about a PDF as JSON (PyMuPDF, run as a separate process).

usage: python pdf_info.py <in.pdf> <out.json> properties
properties: the page count and sizes, the PDF version, the document information, whether it is tagged, its encryption and what the
permissions allow, its fonts, and the signature fields with what the file says about them. Nothing is checked cryptographically.
The first line of standard input, when there is one, is a JSON object with the password ({"password": "..."}).
Exit codes: 0 done, 1 failed (one line on stderr), 2 the PDF engine is not installed.
"""
import json
import os
import re
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
INFORMATION = ("title", "author", "subject", "keywords", "creator", "producer")
MAX_FIELDS = 100000
REF = re.compile(r"(\d+) 0 R")


def iso_date(text):
    """A PDF date (D:20260303094200+08'00') as 2026-03-03T09:42:00+08:00, or None when it is not one. No offset stays without one."""
    m = re.match(r"D:(\d{4})(\d\d)?(\d\d)?(\d\d)?(\d\d)?(\d\d)?(?:([+-])(\d\d)'?(\d\d)?'?|(Z))?", text or "")
    if not m:
        return None
    y, mo, d, h, mi, s = (int(g or default) for g, default in zip(m.groups()[:6], (0, 1, 1, 0, 0, 0)))
    zone = "" if not (m.group(7) or m.group(10)) else "+00:00" if m.group(10) else "%s%s:%s" % (m.group(7), m.group(8), m.group(9) or "00")
    return "%04d-%02d-%02dT%02d:%02d:%02d%s" % (y, mo, d, h, mi, s, zone)


def fonts(doc):
    """Each font once, by name without its subset prefix. Standard fonts and a font nothing in the file carries are not embedded."""
    found = {}
    for number in range(doc.page_count):
        for _xref, ext, kind, name, shown, _encoding in doc.get_page_fonts(number):
            label = re.sub(r"^[A-Z]{6}\+", "", name or shown or "")
            found[label] = found.get(label, False) or ext != "n/a" or kind == "Type3"
    return [{"name": name, "embedded": embedded} for name, embedded in sorted(found.items())]


def text_of(doc, xref, key):
    kind, value = doc.xref_get_key(xref, key)
    return value if kind == "string" else None


def signature_fields(doc):
    """The terminal signature fields of the form, found by walking the field tree; a file with no form has none."""
    kind, raw = doc.xref_get_key(doc.pdf_catalog(), "AcroForm/Fields")
    found, seen = [], set()

    def walk(refs, inherited):
        for xref in (int(n) for n in REF.findall(refs)):
            if xref in seen or len(seen) >= MAX_FIELDS:
                continue
            seen.add(xref)
            own = doc.xref_get_key(xref, "FT")[1]
            kids = doc.xref_get_key(xref, "Kids")
            fieldtype = inherited if own == "null" else own
            if fieldtype != "/Sig":
                if kids[0] == "array":
                    walk(kids[1], fieldtype)
            elif own != "null" or kids[0] != "array":
                found.append(xref)
            else:
                walk(kids[1], fieldtype)

    if kind == "array":
        walk(raw, "null")
    return found


def signatures(doc, src):
    size = os.path.getsize(src)
    fields, ends = [], []
    with open(src, "rb") as f:
        for xref in signature_fields(doc):
            kind, value = doc.xref_get_key(xref, "V")
            row = {"name": text_of(doc, xref, "T") or "", "signed": kind == "xref"}
            action = doc.xref_get_key(xref, "Lock/Action")[1]
            if action != "null":
                row["lock"] = {"action": action.lstrip("/"), "fields": re.findall(r"\(([^)]*)\)", doc.xref_get_key(xref, "Lock/Fields")[1])}
            if row["signed"]:
                sig = int(value.split()[0])
                numbers = [int(n) for n in re.findall(r"\d+", doc.xref_get_key(sig, "ByteRange")[1])]
                end = numbers[2] + numbers[3] if len(numbers) == 4 else 0
                f.seek(max(0, end - 8))
                row["intact"] = len(numbers) == 4 and numbers[0] == 0 and numbers[1] <= numbers[2] <= end <= size and b"%%EOF" in f.read(8)
                row["signer"] = text_of(doc, sig, "Name")
                row["time"] = iso_date(text_of(doc, sig, "M"))
                row["filter"] = doc.xref_get_key(sig, "SubFilter")[1].lstrip("/")
                ends.append(end)
            fields.append(row)
    certified = doc.xref_get_key(doc.pdf_catalog(), "Perms/DocMDP")
    level = None
    if certified[0] == "xref":
        given = re.search(r"/TransformParams<<[^>]*?/P (\d)", doc.xref_get_key(int(certified[1].split()[0]), "Reference")[1])
        level = int(given.group(1)) if given else 2
    return {"fields": fields, "changedAfterSigning": bool(ends) and size > max(ends), "certification": level}


def properties(doc, src, password):
    meta = doc.metadata
    marked = doc.xref_get_key(doc.pdf_catalog(), "MarkInfo/Marked")[1] == "true"
    return {
        "pageCount": doc.page_count,
        "pages": [{"width": page.rect.width, "height": page.rect.height, "rotation": page.rotation} for page in doc],
        "version": meta.get("format"),
        "information": {**{key: meta.get(key) or "" for key in INFORMATION}, "created": iso_date(meta.get("creationDate")), "modified": iso_date(meta.get("modDate"))},
        "tagged": marked,
        "encryption": meta.get("encryption"),
        "needsPassword": bool(password),
        "permissions": {name: bool(doc.permissions & flag) for name, flag in PERMISSIONS.items()},
        "fonts": fonts(doc),
        "signatures": signatures(doc, src),
    }


def main(src, dst, what):
    secrets = {}
    try:
        secrets = pdf_ops.read_secrets()
        if what != "properties":
            raise ValueError("unknown request %s" % json.dumps(what)[:40])
        doc = pdf_ops.open_doc(src, secrets.get("password"))
        try:
            text = json.dumps(properties(doc, src, secrets.get("password")), ensure_ascii=False)
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

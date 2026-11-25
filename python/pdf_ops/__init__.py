# SPDX-License-Identifier: AGPL-3.0-or-later
"""What pdf_edit.py and pdf_info.py share: the one line of secrets on standard input, opening a document with its password, the table
of operations with the way each is saved, and the one place that writes a file.

A password never comes in an argument, the environment or a file, and every reason printed has it replaced by ***.
"""
import inspect
import json
import sys

import pymupdf

import helper
from . import meta, pages

SECRET_KEYS = ("password",)
MAX_SECRETS = 64 * 1024
INCREMENTAL = ("fill", "annotate", "direct", "new")

OPS = {
    "meta.set": ("direct", meta.set_info),
    "pages.rotate": ("direct", pages.rotate),
    "pages.delete": ("rewrite", pages.delete),
    "pages.move": ("direct", pages.move),
    "pages.insert": ("new", pages.insert),
    "pages.blank": ("new", pages.blank),
    "pages.extract": ("output", pages.extract),
    "pages.merge": ("output", pages.merge),
}


def read_secrets():
    """The first line of standard input as a dict, unless a person is typing at it. A caller that has no secret sends {} or nothing."""
    if sys.stdin is None or sys.stdin.isatty():
        return {}
    line = sys.stdin.buffer.readline(MAX_SECRETS + 1)
    if len(line) > MAX_SECRETS:
        raise ValueError("the request is too large")
    if not line.strip():
        return {}
    try:
        secrets = json.loads(line.decode("utf-8"))
    except ValueError:
        raise ValueError("the request is not valid")
    if not isinstance(secrets, dict) or any(k not in SECRET_KEYS or not isinstance(v, str) for k, v in secrets.items() if k != "sources"):
        raise ValueError("the request is not valid")
    if "sources" in secrets and (not isinstance(secrets["sources"], dict) or any(not isinstance(v, str) for v in secrets["sources"].values())):
        raise ValueError("the request is not valid")
    return secrets


def fail(exc, secrets):
    reason = helper.reason(exc)
    for value in [v for k, v in secrets.items() if k != "sources"] + list(secrets.get("sources", {}).values()):
        if value:
            reason = reason.replace(value, "***")
    sys.stderr.write(reason + "\n")
    sys.exit(1)


def open_doc(path, password):
    doc = pymupdf.open(path)
    if doc.needs_pass and not (password and doc.authenticate(password)):
        doc.close()
        raise ValueError("this PDF is password-protected")
    return doc


def load(path):
    """The operations of an ops.json file, checked: known names, only the keys each takes, all of them present."""
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict) or set(data) != {"version", "ops"} or data["version"] != 1 or not isinstance(data["ops"], list) or not data["ops"]:
        raise ValueError("the list of changes is not valid")
    for op in data["ops"]:
        name = op.get("op") if isinstance(op, dict) else None
        if name not in OPS:
            raise ValueError("unknown change %s" % json.dumps(name)[:40])
        takes = set(inspect.signature(OPS[name][1]).parameters) - {"doc", "secrets"}
        if set(op) - {"op"} != takes:
            raise ValueError("%s takes %s" % (name, ", ".join(sorted(takes))))
    return data["ops"]


def incremental(ops):
    return all(OPS[op["op"]][0] in INCREMENTAL for op in ops)


def apply(doc, ops, progress, secrets):
    """Makes each change in turn and returns how many pages each one added."""
    added = []
    for i, op in enumerate(ops):
        run = OPS[op["op"]][1]
        arguments = {k: v for k, v in op.items() if k != "op"}
        if "secrets" in inspect.signature(run).parameters:
            arguments["secrets"] = secrets
        try:
            added.append(run(doc, **arguments) or 0)
        except ValueError as e:
            raise ValueError("%s: %s" % (op["op"], e))
        progress((i + 1) / len(ops))
    return added


def save(doc, dst, in_place):
    """in_place: `doc` was opened from `dst` and its changes are appended. Otherwise the whole file is written to `dst`. PyMuPDF's
    save() decrypts unless told to keep the encryption, so a protected file would come out open; this refuses to leave one like that.
    garbage=1 drops what nothing refers to any more, which is what a deleted page needs, and leaves every other page alone."""
    was_encrypted = doc.is_encrypted
    if in_place:
        doc.saveIncr()
    else:
        doc.save(dst, garbage=1, encryption=pymupdf.PDF_ENCRYPT_KEEP)
    doc.close()
    if was_encrypted:
        with pymupdf.open(dst) as saved:
            if not saved.is_encrypted:
                raise ValueError("the changed file would have lost its password")

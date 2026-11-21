# SPDX-License-Identifier: AGPL-3.0-or-later
"""Pomelo helper: opens a password-protected PDF or Office file (PyMuPDF and msoffcrypto-tool, run as a separate process).

usage: python unlock.py probe <input>              prints LOCKED or OPEN (the Office files made before 2007 cannot be told apart by their first bytes)
       python unlock.py open <input> [<output>]    the password is the first line of standard input; writes the file without it to <output>,
                                                   or only checks the password when there is no <output>
Exit codes: 0 done, 1 failed, 2 a component is not installed, 4 wrong password (stderr says POMELO_LOCK wrong),
5 a protection that cannot be opened here, or a damaged file.
"""
import sys

import helper

helper.require("Opening protected files", "pymupdf", "msoffcrypto")
import msoffcrypto  # noqa: E402
import pymupdf  # noqa: E402
from msoffcrypto.exceptions import InvalidKeyError  # noqa: E402

WRONG = 4
CANNOT = 5


def fail(code, message):
    sys.stderr.write(message + "\n")
    sys.exit(code)


def is_pdf(path):
    with open(path, "rb") as f:
        return b"%PDF" in f.read(1024)


def probe(src):
    try:
        with open(src, "rb") as f:
            print("LOCKED" if msoffcrypto.OfficeFile(f).is_encrypted() else "OPEN")
    except Exception:
        print("OPEN")


def open_pdf(src, dst, password):
    doc = pymupdf.open(src)
    if doc.needs_pass and not doc.authenticate(password):
        fail(WRONG, "POMELO_LOCK wrong")
    if dst:
        doc.save(dst, encryption=pymupdf.PDF_ENCRYPT_NONE)


def open_office(src, dst, password):
    with open(src, "rb") as f:
        office = msoffcrypto.OfficeFile(f)
        office.load_key(password=password, verify_password=True)
        if dst:
            with open(dst, "wb") as out:
                office.decrypt(out)


def main(src, dst):
    password = sys.stdin.buffer.readline().decode("utf-8", "replace").rstrip("\r\n")
    try:
        (open_pdf if is_pdf(src) else open_office)(src, dst, password)
    except InvalidKeyError:
        fail(WRONG, "POMELO_LOCK wrong")
    except Exception as e:
        fail(CANNOT, "This file is damaged or its protection is not supported: %s" % str(e).replace("\n", " ")[:120])
    print("OK")


if __name__ == "__main__":
    if sys.argv[1] == "probe":
        probe(sys.argv[2])
    else:
        main(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)

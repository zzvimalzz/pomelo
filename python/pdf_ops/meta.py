# SPDX-License-Identifier: AGPL-3.0-or-later
"""The document information that a person edits: title, author, subject and keywords. An empty text removes the entry."""

LONGEST = 1000


def set_info(doc, title, author, subject, keywords):
    values = {"title": title, "author": author, "subject": subject, "keywords": keywords}
    for key, value in values.items():
        if not isinstance(value, str) or len(value) > LONGEST or "\0" in value:
            raise ValueError("%s is text of at most %d characters" % (key, LONGEST))
    doc.set_metadata(values)

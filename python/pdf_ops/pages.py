# SPDX-License-Identifier: AGPL-3.0-or-later
"""Operations on whole pages. Page numbers start at 1 and are counted in the document as the earlier operations of the list left it."""


def pick(doc, pages):
    if not isinstance(pages, list) or not pages or any(type(p) is not int for p in pages) or len(set(pages)) != len(pages):
        raise ValueError("pages must be a list of different page numbers")
    for p in pages:
        if not 1 <= p <= doc.page_count:
            raise ValueError("this PDF has no page %d" % p)
    return [p - 1 for p in pages]


def rotate(doc, pages, by):
    if type(by) is not int or by not in (90, 180, 270):
        raise ValueError("a page turns by 90, 180 or 270 degrees")
    for i in pick(doc, pages):
        page = doc[i]
        page.set_rotation((page.rotation + by) % 360)


def delete(doc, pages):
    gone = pick(doc, pages)
    if len(gone) == doc.page_count:
        raise ValueError("a PDF needs at least one page")
    doc.delete_pages(gone)

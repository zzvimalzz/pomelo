# SPDX-License-Identifier: AGPL-3.0-or-later
"""Operations on whole pages. Page numbers start at 1 and are counted in the document as the earlier operations of the list left it.
An operation that adds pages returns how many."""
import os

import pymupdf

MAX_SOURCES = 50
PICTURE_PT = 842


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


def move(doc, pages, before):
    """The pages keep their order and go in front of page `before`, counted before the move; one past the last page puts them at the end."""
    moved = sorted(pick(doc, pages))
    gone = set(moved)
    if type(before) is not int or not 1 <= before <= doc.page_count + 1:
        raise ValueError("there is no such place to move pages to")
    # Each page goes in front of the same page, the first one from `before` on that is not moving, so they land side by side in order.
    stay = next((i for i in range(before - 1, doc.page_count) if i not in gone), None)
    order = list(range(doc.page_count))
    for page in moved:
        doc.move_page(order.index(page), -1 if stay is None else order.index(stay))
        order.remove(page)
        order.insert(len(order) if stay is None else order.index(stay), page)


def place(doc, before):
    if type(before) is not int or not 1 <= before <= doc.page_count + 1:
        raise ValueError("there is no such place to put pages")
    return before - 1


def blank(doc, before):
    """A page the size of the one before it, or of the first page when it goes at the start."""
    at = place(doc, before)
    shown = doc[max(at - 1, 0)].rect
    doc.new_page(at, width=shown.width, height=shown.height)
    return 1


def picture(file):
    """A one-page document holding the picture at the size its file gives it, but no longer than A4's long side."""
    with pymupdf.open(file) as image:
        width, height = image[0].rect.width, image[0].rect.height
    scale = min(1, PICTURE_PT / max(width, height))
    sheet = pymupdf.open()
    sheet.new_page(width=width * scale, height=height * scale).insert_image(pymupdf.Rect(0, 0, width * scale, height * scale), filename=file)
    return sheet


def insert(doc, before, sources, secrets):
    """Each source is {"id", "file", "kind"}: a PDF, which is opened with the password in secrets["sources"][id] when it has one, or a picture."""
    at = place(doc, before)
    if not isinstance(sources, list) or not 0 < len(sources) <= MAX_SOURCES:
        raise ValueError("there are no files to insert")
    added = 0
    for source in sources:
        if not isinstance(source, dict) or set(source) != {"id", "file", "kind"} or source["kind"] not in ("pdf", "image") or not os.path.isfile(source["file"]):
            raise ValueError("a file to insert is not there")
        if source["kind"] == "image":
            part = picture(source["file"])
        else:
            part = pymupdf.open(source["file"])
            if part.needs_pass and not part.authenticate(secrets.get("sources", {}).get(source["id"], "")):
                part.close()
                raise ValueError("a PDF to insert is password-protected")
        with part:
            doc.insert_pdf(part, start_at=at + added)
            added += part.page_count
    return added


def extract(doc, pages):
    """Keeps only these pages, in their order. The caller saves the result as a new file."""
    doc.select(sorted(pick(doc, pages)))

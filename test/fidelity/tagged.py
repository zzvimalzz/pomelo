# SPDX-License-Identifier: AGPL-3.0-or-later
"""How well PDF to Word finds paragraphs, headings and tables, scored on tagged PDFs. The tags that Word, Google Docs and most office programs write say where every
paragraph, heading and table is, so any folder of such PDFs is a test set the converter was never tuned on. Each file is converted twice: as it is, and with its tags
taken out, which scores the guessing that untagged PDFs (LaTeX, scans, most printers) get.

usage: vendor\\pyenv\\Scripts\\python.exe test/fidelity/tagged.py <folder or pdf>...

Per file and in total, for both runs: paragraphs (the share of tagged paragraphs that are one Word paragraph with the same text), headings (the share of tagged headings
that are such a paragraph with a heading style) and tables (the share of tagged tables of two rows and two columns or more whose cells are in one Word table).
"""
import glob
import os
import re
import sys
import tempfile
import zipfile
from collections import Counter
from types import SimpleNamespace

import pymupdf

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "python"))
import pdf_flow  # noqa: E402
from pdf_flow.lines import HEADINGS, para_tag  # noqa: E402
from pdf_spans import TEXT_FLAGS  # noqa: E402

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


LABEL = re.compile(r"^\s*(\(?\d{1,3}[.)]|\(?[a-zA-Z][.)]|\([ivx]{1,4}\)|[^\w\s(])\s+")       # the number or bullet of a list item, which Word numbers itself


def squash(text):
    return re.sub(r"\W+", "", text).lower()


def truth(doc):
    """-> (paragraph texts, heading texts, tables as lists of cell texts) from the tags."""
    paras, kinds, cells = {}, {}, {}

    def walk(blocks, path):
        for b in blocks:
            if b["type"] == 2:
                walk(b.get("blocks", ()), path + (((page.number, b["number"]), b.get("std") or b.get("raw") or ""),))
            elif b["type"] == 0 and path:
                text = "".join(s["text"] for ln in b["lines"] for s in ln["spans"])
                tag = para_tag(SimpleNamespace(tags=path))
                if tag:
                    paras[tag[0]] = paras.get(tag[0], "") + text
                    kinds[tag[0]] = tag[1]
                k = max((k for k, t in enumerate(path) if t[1] == "Table"), default=None)
                row = next((t[0] for t in path[k:] if t[1] == "TR"), None) if k is not None else None
                cell = next((t[0] for t in path[k:] if t[1] in ("TD", "TH")), None) if row else None
                if cell:
                    table = cells.setdefault(path[k][0], {}).setdefault(row, {})
                    table[cell] = table.get(cell, "") + text

    for page in doc:
        walk(page.get_text("dict", flags=TEXT_FLAGS | pymupdf.TEXT_COLLECT_STRUCTURE)["blocks"], ())
    texts = {k: squash(LABEL.sub("", t, 1) if kinds[k] == "LI" else t) for k, t in paras.items()}
    texts = {k: t for k, t in texts.items() if len(t) >= 3}
    tables = [[squash(t) for r in rows.values() for t in r.values() if squash(t)] for rows in cells.values() if len(rows) >= 2 and max(map(len, rows.values())) >= 2]
    return list(texts.values()), [t for k, t in texts.items() if kinds[k] in HEADINGS], [t for t in tables if t]


def written(docx):
    """-> (paragraph texts, heading texts, the cell texts of each table of two rows and two columns or more) of a converted DOCX."""
    from lxml import etree
    root = etree.fromstring(zipfile.ZipFile(docx).read("word/document.xml"))
    text = lambda el: squash("".join(t.text or "" for t in el.iter(W + "t")))
    paras, heads = [], []
    for p in root.iter(W + "p"):
        style = p.find(f"{W}pPr/{W}pStyle")
        paras.append(text(p))
        if style is not None and re.match(r"Heading|Title", style.get(W + "val")):
            heads.append(text(p))
    tables = [[text(c) for c in t.iter(W + "tc")] for t in root.iter(W + "tbl") if len(t.findall(W + "tr")) >= 2 and max(len(r.findall(W + "tc")) for r in t.findall(W + "tr")) >= 2]
    return paras, heads, tables


def score(ref, got):
    """-> [found, out of] for paragraphs, headings and tables."""
    found = []
    for want, have in zip(ref[:2], got[:2]):
        found.append([sum((Counter(want) & Counter(have)).values()), len(want)])
    hit = sum(any(sum(c in set(t) for c in table) >= 0.6 * len(table) for t in got[2]) for table in ref[2])
    return found + [[hit, len(ref[2])]]


def main(paths):
    files = [f for p in paths for f in (sorted(glob.glob(os.path.join(p, "*.pdf"))) if os.path.isdir(p) else [p])]
    total = [[[0, 0] for _ in range(3)] for _ in range(2)]
    pct = lambda f: f"{100 * f[0] / f[1]:5.1f}" if f[1] else "    -"
    print(f"{'file':40} {'paras':>6} {'heads':>6} {'tables':>6}   tagged: P H T       untagged: P H T")
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        for n, f in enumerate(files):
            doc = pymupdf.open(f)
            if doc.xref_get_key(doc.pdf_catalog(), "StructTreeRoot")[0] == "null":
                continue
            ref = truth(doc)
            bare = os.path.join(tmp, f"{n}.pdf")
            doc.xref_set_key(doc.pdf_catalog(), "StructTreeRoot", "null")
            doc.save(bare)
            doc.close()
            row = []
            for k, src in enumerate((f, bare)):
                out = os.path.join(tmp, f"{n}_{k}.docx")
                try:
                    pdf_flow.convert(src, out)
                    s = score(ref, written(out))
                except Exception as e:
                    print(f"{os.path.basename(f)[:40]:40} failed: {e}")
                    break
                for t, v in zip(total[k], s):
                    t[0] += v[0]
                    t[1] += v[1]
                row.append(" ".join(pct(v) for v in s))
            else:
                print(f"{os.path.basename(f)[:40]:40} {len(ref[0]):6} {len(ref[1]):6} {len(ref[2]):6}   {row[0]}   {row[1]}", flush=True)
    print(f"{'total':40} {total[0][0][1]:6} {total[0][1][1]:6} {total[0][2][1]:6}   {' '.join(pct(v) for v in total[0])}   {' '.join(pct(v) for v in total[1])}")


if __name__ == "__main__":
    main(sys.argv[1:])

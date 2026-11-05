# SPDX-License-Identifier: AGPL-3.0-or-later
"""Helpers every part of the converter uses: units, escaping, geometry of boxes, grouping of coordinates."""

import re

from docx.oxml.ns import nsdecls

from pdf_spans import BAD_XML


TW = 20                                   # twips per point


NS = nsdecls("w", "wp", "a", "pic", "r")




BULLETS = set("•●▪◦·‣⁃■○✓✔❖➢–—-*►▸➤□◆◇▫") | {"", "", "", "", "", "", "", "", "o"}


NUMBER = re.compile(r"^(\(?\d{1,3}[.)]|\(?[a-z][.)]|\([ivx]{1,4}\))$")


HI_DPI = 200


def tw(v):
    return int(round(v * TW))


def esc(s):
    return BAD_XML.sub("", s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def rgb_hex(rgb):
    return "%02X%02X%02X" % tuple(max(0, min(255, round(v * 255))) for v in rgb[:3])


def is_white(rgb, tol=0.04):
    return rgb is None or all(v >= 1 - tol for v in rgb[:3])


def overlap(a, b):
    """Area of the overlap of two (x0, y0, x1, y1) boxes."""
    return max(0.0, min(a[2], b[2]) - max(a[0], b[0])) * max(0.0, min(a[3], b[3]) - max(a[1], b[1]))


def area(b):
    return max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])


def inside(b, outer, slack=1.0):
    cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
    return outer[0] - slack <= cx <= outer[2] + slack and outer[1] - slack <= cy <= outer[3] + slack


def cluster(values, tol=1.6):
    values = sorted(values)
    out = []
    for v in values:
        if out and v - out[-1][-1] <= tol:
            out[-1].append(v)
        else:
            out.append([v])
    return [sum(c) / len(c) for c in out]


def nearest(xs, v):
    return min(range(len(xs)), key=lambda i: abs(xs[i] - v))

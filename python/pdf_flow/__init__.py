# SPDX-License-Identifier: AGPL-3.0-or-later
"""Editable PDF -> DOCX. Every page is rebuilt as the Word document someone would have typed: real paragraphs with their
indents, alignment and spacing, real lists, real tables (ruled ones, and side-by-side blocks as borderless tables),
shaded boxes, hyperlinks, underline and highlight. Only what is a picture in the PDF stays a picture.

How a page is read (PyMuPDF, run as a separate process, never linked into the app):
  * lines of text come from the text layer; pieces on one row are joined, bullets and numbers are split off as list markers
  * ruled tables come from PyMuPDF's table finder; shaded or outlined boxes that hold text become one-cell tables
  * the rest is cut the way a typesetter would: columns where a vertical gap runs the whole height, bands where a
    horizontal gap separates differently built parts (a title above two columns); what cannot be cut is a stack of
    paragraphs, grouped from the spacing, the left edge and the line lengths
  * everything that is not text and not one of the above (pictures, charts, logos, shapes, gradients) is found by
    drawing the page without its text and looking for what is left: it is cut out as a picture, in line with the text
    or behind it when text sits on top
  * vertical positions are kept by computing the space before each paragraph, so a page comes out where it went in
"""
from .convert import convert

__all__ = ["convert"]

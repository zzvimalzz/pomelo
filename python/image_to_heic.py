# SPDX-License-Identifier: AGPL-3.0-or-later
"""Pomelo helper: write HEIC (HEVC in HEIF) with pillow-heif, which bundles libheif and the x265 encoder.

usage: python image_to_heic.py <input image> <output.heic>
Prints OK; a one-line reason on stderr otherwise (exit 1 failed, 2 pillow-heif is not installed).
"""
import sys

import helper

helper.require("pillow-heif", "pillow_heif", "PIL")
import pillow_heif  # noqa: E402
from PIL import Image, ImageOps  # noqa: E402


def main(src, dst):
    pillow_heif.register_heif_opener()
    try:
        im = Image.open(src)
        im = ImageOps.exif_transpose(im)          # keep phone photos upright
        if im.mode not in ("RGB", "RGBA"):
            im = im.convert("RGBA" if "A" in im.getbands() else "RGB")
        im.save(dst, format="HEIF", quality=85)
    except Exception as e:
        sys.stderr.write("HEIC encode failed: %s\n" % str(e).replace("\n", " ")[:300])
        sys.exit(1)
    print("OK")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])

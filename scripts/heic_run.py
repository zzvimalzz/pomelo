# SPDX-License-Identifier: AGPL-3.0-or-later
"""Pomelo helper: write HEIC (HEVC in HEIF) with pillow-heif, which bundles libheif and the x265 encoder.

usage: python heic_run.py <input image> <output.heic>
"""
import sys
import warnings

warnings.filterwarnings("ignore")

try:
    import pillow_heif
    from PIL import Image, ImageOps
except Exception as e:
    sys.stderr.write("pillow-heif is not available: %s\n" % e)
    sys.exit(2)

pillow_heif.register_heif_opener()
src, dst = sys.argv[1], sys.argv[2]
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

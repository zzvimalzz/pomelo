# SPDX-License-Identifier: AGPL-3.0-or-later
"""Dev tool: list the licence of every package installed in the PDF/HEIC Python environment.
   vendor/pyenv/Scripts/python.exe tools/py-licenses.py
"""
import re
from importlib import metadata

rows = []
for dist in sorted(metadata.distributions(), key=lambda d: (d.metadata["Name"] or "").lower()):
    meta = dist.metadata
    name = meta["Name"]
    lic = (meta.get("License-Expression") or meta.get("License") or "").strip().replace("\n", " ")
    classifiers = [c.split("::")[-1].strip() for c in (meta.get_all("Classifier") or []) if c.startswith("License ::")]
    if len(lic) > 70 or not lic:
        lic = "; ".join(classifiers) or (lic[:70] + "…" if lic else "(none stated)")
    rows.append((name, dist.version, lic))

width = max(len(r[0]) for r in rows)
for name, version, lic in rows:
    print(f"{name:<{width}}  {version:<12} {lic}")

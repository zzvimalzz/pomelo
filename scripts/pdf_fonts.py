# SPDX-License-Identifier: AGPL-3.0-or-later
"""PostScript font names -> the family names Word knows (Cambria-Bold -> Cambria, ArialMT -> Arial, ...)."""
import re

KNOWN = {
    "TIMESNEWROMAN": "Times New Roman", "TIMESNEWROMANPS": "Times New Roman", "TIMESNEWROMANPSMT": "Times New Roman",
    "ARIAL": "Arial", "ARIALMT": "Arial", "ARIALNARROW": "Arial Narrow", "ARIALBLACK": "Arial Black",
    "COURIERNEW": "Courier New", "COURIERNEWPS": "Courier New", "COURIERNEWPSMT": "Courier New",
    "TAHOMA": "Tahoma", "VERDANA": "Verdana", "GEORGIA": "Georgia", "TREBUCHETMS": "Trebuchet MS",
    "SEGOEUI": "Segoe UI", "CALIBRILIGHT": "Calibri Light", "CAMBRIAMATH": "Cambria Math",
    "LIBERATIONSERIF": "Liberation Serif", "LIBERATIONSANS": "Liberation Sans", "LIBERATIONMONO": "Liberation Mono",
    "HELVETICA": "Arial", "HELVETICANEUE": "Helvetica Neue", "TIMES": "Times New Roman", "COURIER": "Courier New",
}
STYLE_TAIL = re.compile(r"[-,_ ]?(BoldItalic|BoldOblique|Bold|Italic|Oblique|Regular|Roman|Semibold|Medium|BdIt|It|Bd|MT|PS)+$", re.I)


def word_family(name: str) -> str:
    base = (name or "").split("+")[-1].strip()
    if not base:
        return base
    key = re.sub(r"[^A-Za-z]", "", base).upper()
    stripped = base
    for _ in range(3):  # peel -Bold, -Italic, MT, PS ... repeatedly (TimesNewRomanPS-BoldItalicMT)
        new = STYLE_TAIL.sub("", stripped)
        if new == stripped or not new:
            break
        stripped = new
    skey = re.sub(r"[^A-Za-z]", "", stripped).upper()
    if skey in KNOWN:
        return KNOWN[skey]
    if key in KNOWN:
        return KNOWN[key]
    stripped = stripped.replace("-", " ").replace("_", " ")
    stripped = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", stripped) if " " not in stripped and len(stripped) > 14 else stripped
    return stripped.strip()

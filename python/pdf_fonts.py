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


SUBSTITUTES = {"serif": ("Cambria", "Times New Roman", "Georgia"), "sans": ("Calibri", "Arial", "Segoe UI"), "mono": ("Consolas", "Courier New")}
SAMPLE = "The quick brown fox jumps over the lazy dog 0123456789"
KINDS = (
    ("mono", re.compile(r"mono|courier|consolas|typewriter|code", re.I)),
    ("sans", re.compile(r"sans|arial|helvet|futura|gothic|calibri|segoe|verdana|tahoma|trebuchet|roboto|lato|montserrat|nunito|univers|frutiger|myriad|avenir|ubuntu", re.I)),
    ("serif", re.compile(r"serif|times|georgia|garamond|palatino|minion|cambria|baskerville|didot|playfair|lora|merriweather|caslon|bodoni|roman", re.I)),
)
FONTS_KEY = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts"
STYLE_WORDS = re.compile(r"\s+(Bold|Italic|Oblique|Regular)\b.*$", re.I)
_installed = None
_files = {}


def norm(family):
    return re.sub(r"[^a-z0-9]", "", family.lower())


def latin(text):
    return all(ord(c) < 0x250 for c in text)


def kind_of(font, flags):
    """Serif, sans or mono: from the name when it says, else from the font's own flags, which some producers set wrongly."""
    return next((k for k, rx in KINDS if rx.search(font)), "mono" if flags & 8 else "serif" if flags & 4 else "sans")


def installed():
    """{norm(family): (family as Windows names it, {(bold, italic): font file})} for the fonts Windows has, read once from the registry."""
    global _installed
    if _installed is not None:
        return _installed
    _installed = {}
    try:
        import os
        import winreg
        local = os.environ.get("LOCALAPPDATA")
        folders = [os.path.normcase(os.path.realpath(p)) for p in (os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts"), local and os.path.join(local, "Microsoft", "Windows", "Fonts")) if p]
        for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
            try:
                key = winreg.OpenKey(hive, FONTS_KEY)
            except OSError:
                continue
            for i in range(winreg.QueryInfoKey(key)[1]):
                try:
                    name, file, _ = winreg.EnumValue(key, i)
                    path = font_file(file, folders)
                    if not path:
                        continue
                    name = re.sub(r"\s*\((TrueType|OpenType|All res)\)$", "", name)
                    style = (bool(re.search(r"\bBold\b", name, re.I)), bool(re.search(r"\b(Italic|Oblique)\b", name, re.I)))
                    for part in name.split(" & "):
                        family = STYLE_WORDS.sub("", part).strip()
                        _installed.setdefault(norm(family), (family, {}))[1].setdefault(style, path)
                except (OSError, TypeError, ValueError):
                    continue
    except Exception:
        pass
    return _installed


def font_file(file, folders):
    """The font file a registry entry names, or None. The registry is writable by the user, so a name that leaves the Windows fonts folders (a full path elsewhere, `..`, a link) is ignored, and so is a relative name found in the working directory."""
    import os
    candidates = [file] if os.path.isabs(file) else [os.path.join(f, file) for f in folders]
    for p in candidates:
        real = os.path.normcase(os.path.realpath(p))
        try:
            held = any(os.path.commonpath([real, f]) == f for f in folders)
        except ValueError:
            held = False
        if held and os.path.isfile(real) and real.endswith((".ttf", ".otf", ".ttc")):
            return real
    return None


def installed_name(family):
    """The family as Windows names it, or None when Windows does not have it."""
    return installed().get(norm(family), (None,))[0]


def installed_font(family, bold, italic):
    """The pymupdf.Font of an installed family in the nearest style it has, or None."""
    styles = installed().get(norm(family), ("", {}))[1]
    path = styles.get((bold, italic)) or styles.get((bold, False)) or styles.get((False, False))
    if path not in _files:
        try:
            import pymupdf
            _files[path] = pymupdf.Font(fontfile=path) if path else None
        except Exception:
            _files[path] = None
    return _files[path]


def stand_in(font, flags, bold, italic, measured):
    """The family Word is told to use for a PDF font: its own when Windows has it, otherwise the installed serif, sans or mono family closest in width to `measured`, the font as the PDF embeds it, so Word does not pick for itself. A font that cannot be measured (Type 3) keeps its own name."""
    own = word_family(font) or "Arial"
    if installed_name(own):
        return installed_name(own)
    pool = {f: installed_font(f, bold, italic) for f in SUBSTITUTES[kind_of(font, flags)]}
    pool = {f: m for f, m in pool.items() if m}
    if not measured or not pool:
        return own
    try:
        want = measured.text_length(SAMPLE, fontsize=10)
        widths = {f: m.text_length(SAMPLE, fontsize=10) for f, m in pool.items()}
    except Exception:
        return own
    return min(pool, key=lambda f: abs(widths[f] - want))


def word_family(name: str) -> str:
    base = (name or "").split("+")[-1].strip()
    if not base:
        return base
    key = re.sub(r"[^A-Za-z]", "", base).upper()
    stripped = base
    for _ in range(3):  # peel -Bold, -Italic, MT, PS ... repeatedly (TimesNewRomanPS-BoldItalicMT), stopping at a known family
        new = STYLE_TAIL.sub("", stripped)
        if new == stripped or not new:
            break
        stripped = new
        if re.sub(r"[^A-Za-z]", "", stripped).upper() in KNOWN:
            break
    skey = re.sub(r"[^A-Za-z]", "", stripped).upper()
    if skey in KNOWN:
        return KNOWN[skey]
    if key in KNOWN:
        return KNOWN[key]
    stripped = stripped.replace("-", " ").replace("_", " ")
    stripped = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", stripped) if " " not in stripped and len(stripped) > 14 else stripped
    return stripped.strip()

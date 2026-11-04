#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Dev tool: render a .docx to page PNGs (LibreOffice -> PDF -> pdf.js) to eyeball conversion fidelity.
#   tools/render-docx.sh <file.docx> <outdir>      needs bash (Git Bash or WSL), not PowerShell or cmd
set -e
DOCX="$1"; OUT="$2"
mkdir -p "$OUT"
PROFILE="file:///$(cygpath -m "$TEMP")/pomelo-lo-render-profile"
"/c/Program Files/LibreOffice/program/soffice.exe" "-env:UserInstallation=$PROFILE" --headless --norestore --convert-to pdf --outdir "$OUT" "$DOCX" >/dev/null 2>&1
PDF="$OUT/$(basename "${DOCX%.*}").pdf"
node "$(dirname "$0")/pdf-inspect.mjs" "$PDF" --render "$OUT/png" | grep -E "^pages|^p[0-9]" | cut -c1-140

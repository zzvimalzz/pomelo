# SPDX-License-Identifier: AGPL-3.0-or-later
# Installs the high-fidelity PDF engine (pdf2docx, MIT) into vendor\pyenv. Needs Python 3.9+ on PATH.
#   npm run setup:pdf
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$env = Join-Path $root 'vendor\pyenv'
$py = Join-Path $env 'Scripts\python.exe'

if (-not (Test-Path $py)) {
    Write-Host 'Creating Python environment in vendor\pyenv ...'
    python -m venv $env
}
Write-Host 'Installing pdf2docx, pymupdf4llm (and PyMuPDF) and pillow-heif ...'
# pymupdf4llm is pinned below 1.0: newer releases depend on pymupdf-layout, which is licensed
# PolyForm Noncommercial / commercial and therefore is not open source.
& $py -m pip install --quiet --upgrade pip pdf2docx "pymupdf4llm==0.3.4" pillow-heif
& $py -W ignore -c "import pdf2docx, fitz, pymupdf4llm, pillow_heif; print('PDF and HEIC engines ready')"

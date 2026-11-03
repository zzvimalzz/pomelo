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
Write-Host 'Installing pdf2docx (with PyMuPDF) and pillow-heif ...'
& $py -m pip install --quiet --upgrade pip pdf2docx pillow-heif
& $py -W ignore -c "import pdf2docx, fitz, pillow_heif; print('PDF and HEIC engines ready')"

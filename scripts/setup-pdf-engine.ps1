# SPDX-License-Identifier: AGPL-3.0-or-later
# Installs the PDF engine (PyMuPDF, python-docx, RapidOCR) and HEIC export into vendor\pyenv. Needs Python 3.9+ on PATH.
#   npm run setup:pdf
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$env = Join-Path $root 'vendor\pyenv'
$py = Join-Path $env 'Scripts\python.exe'

if (-not (Test-Path $py)) {
    Write-Host 'Creating Python environment in vendor\pyenv ...'
    python -m venv $env
}
Write-Host 'Installing PyMuPDF, python-docx, RapidOCR and pillow-heif ...'
& $py -m pip install --quiet --upgrade pip 'pymupdf==1.28.2' python-docx pillow-heif 'rapidocr==3.10.0' onnxruntime
& $py -W ignore -c "import pymupdf, docx, pillow_heif, rapidocr; print('PDF, OCR and HEIC engines ready')"
& $py -W ignore (Join-Path $PSScriptRoot 'ocr_warmup.py')

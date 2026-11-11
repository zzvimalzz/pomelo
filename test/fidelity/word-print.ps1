# SPDX-License-Identifier: AGPL-3.0-or-later
# Prints a DOCX to PDF with Microsoft Word, for test/fidelity/run.js --word. It starts a Word of its own, tells the
# caller its process id on the first line, and closes only that one.
param([Parameter(Mandatory)][string]$Docx, [Parameter(Mandatory)][string]$Pdf)
$ErrorActionPreference = 'Stop'

function Fail($message) { [Console]::Error.WriteLine($message); exit 1 }

$before = @(Get-Process WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$word = New-Object -ComObject Word.Application
$mine = @(Get-Process WINWORD -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id })
# A Word that was already running can be handed out instead of a new one. Quitting it would close the user's documents.
if ($mine.Count -ne 1) {
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($word)
  Fail 'Word did not start a process of its own, so it was left alone.'
}
Write-Output "WORD_PID $($mine[0].Id)"

try {
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $word.AutomationSecurity = 3
  if ($word.Documents.Count -ne 0) { Fail 'Word started with documents open.' }
  $doc = $word.Documents.Open($Docx, $false, $true, $false)
  $doc.ExportAsFixedFormat($Pdf, 17)
  $doc.Close(0)
  Write-Output 'OK'
} catch {
  Fail $_.Exception.Message
} finally {
  try { $word.Quit(0) } catch { }
  if (-not $mine[0].WaitForExit(10000)) { Stop-Process -Id $mine[0].Id -Force }
}

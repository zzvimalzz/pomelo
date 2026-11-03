# SPDX-License-Identifier: AGPL-3.0-or-later
# Installs, updates and uninstalls the real installer, silently, and checks what a person would notice:
#   1. an older Pomelo installs, with its uninstall entry, and starts
#   2. the new Setup updates it in place: the running copy is stopped, the files and the version change, settings and the
#      conversion engines folder are kept
#   3. the uninstaller removes the program, its settings and the engines folder
# Needs Inno Setup 6.3+ (ISCC) and a packaged app (npm run package, then npm run build:installer for the new Setup).
#   pwsh tools/installer-e2e.ps1 [-New dist\installer\Pomelo-Setup-x64.exe]
param(
  [string]$New = (Join-Path $PSScriptRoot '..\dist\installer\Pomelo-Setup-x64.exe')
)
$ErrorActionPreference = 'Stop'
trap { Write-Host "::error title=installer test crashed::$($_.Exception.Message) at line $($_.InvocationInfo.ScriptLineNumber)"; exit 1 }
$root = Split-Path -Parent $PSScriptRoot
$new = (Resolve-Path $New).Path
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$work = Join-Path ([IO.Path]::GetTempPath()) "pomelo-e2e-$PID"
$dir = Join-Path $work 'Pomelo'
$appId = '{6F0C2E4A-3B1D-4D8E-9A57-C1E0B7F5A2D3}_is1'
$key = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$appId"
$appData = Join-Path $env:APPDATA 'Pomelo'
$engines = Join-Path $env:LOCALAPPDATA 'Pomelo\engines'
$failed = 0

function Check($name, $ok, $detail = '') {
  if ($ok) { Write-Host "  ok   $name" } else { Write-Host "  FAIL $name  $detail"; Write-Host "::error title=installer::$name $detail"; $script:failed++ }
}
function Run-Setup($exe, $log) {
  $p = Start-Process -FilePath $exe -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/TASKS=', "/DIR=`"$dir`"", "/LOG=`"$log`"") -Wait -PassThru
  return $p.ExitCode
}
function Installed-Version() { try { (Get-ItemProperty $key -ErrorAction Stop).DisplayVersion } catch { $null } }

New-Item -ItemType Directory -Force $work | Out-Null

# ---- an older Setup, built from the same files with another version number
$iscc = @("${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe", "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { throw 'Inno Setup 6 (ISCC.exe) was not found' }
& $iscc '/DAppVersion=0.0.1' '/DFastBuild' "/O$work" '/FPomelo-Setup-old' (Join-Path $root 'installer\pomelo.iss') | Out-Null
$old = Join-Path $work 'Pomelo-Setup-old.exe'
if (-not (Test-Path $old)) { throw 'The older Setup could not be built' }

Write-Host 'a clean machine: install'
Check 'Pomelo is not installed yet' ($null -eq (Installed-Version))
$code = Run-Setup $old (Join-Path $work 'old.log')
Check 'the older Setup exits with 0' ($code -eq 0) "exit $code"
Check 'Pomelo.exe is in the folder that was asked for' (Test-Path (Join-Path $dir 'Pomelo.exe'))
Check 'Windows lists it, as version 0.0.1' ((Installed-Version) -eq '0.0.1') "$(Installed-Version)"
Check 'the uninstaller is there' (Test-Path (Join-Path $dir 'unins000.exe'))

Write-Host 'something of the user'
New-Item -ItemType Directory -Force $appData, $engines | Out-Null
Set-Content (Join-Path $appData 'settings.json') '{"openAtLogin":false,"key":"alt"}'
Set-Content (Join-Path $engines 'manifest.json') '{"winget":[],"pyenv":false,"soffice":false}'
Set-Content (Join-Path $engines 'keep-me.txt') 'an engine file'

Write-Host 'the older Pomelo is running'
$proc = Start-Process -FilePath (Join-Path $dir 'Pomelo.exe') -ArgumentList '--hidden' -PassThru
Start-Sleep -Seconds 8
Check 'it started and stayed up' (-not $proc.HasExited)

Write-Host 'update to the new version'
$code = Run-Setup $new (Join-Path $work 'new.log')
Check 'the new Setup exits with 0' ($code -eq 0) "exit $code"
Check "Windows lists it as version $version" ((Installed-Version) -eq $version) "$(Installed-Version)"
Check 'the program files are the new version' (((Get-Item (Join-Path $dir 'Pomelo.exe')).VersionInfo.FileVersion) -like "$version*") "$((Get-Item (Join-Path $dir 'Pomelo.exe')).VersionInfo.FileVersion)"
Check 'the old copy was stopped (it would hold the files and answer for the new one)' ($proc.HasExited -or -not (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue))
Check 'it went into the same folder (one copy only)' ((Get-ChildItem $work -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'Pomelo.exe') }).Count -eq 1)
Check 'settings were kept' ((Get-Content (Join-Path $appData 'settings.json') -Raw) -match '"key":"alt"')
Check 'the conversion engines folder was kept' (Test-Path (Join-Path $engines 'keep-me.txt'))

Write-Host 'the new Pomelo starts'
$proc = Start-Process -FilePath (Join-Path $dir 'Pomelo.exe') -ArgumentList '--hidden' -PassThru
Start-Sleep -Seconds 8
Check 'it started and stayed up' (-not $proc.HasExited)

Write-Host 'uninstall'
$p = Start-Process -FilePath (Join-Path $dir 'unins000.exe') -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART') -Wait -PassThru
Check 'the uninstaller exits with 0' ($p.ExitCode -eq 0) "exit $($p.ExitCode)"
Start-Sleep -Seconds 3
Check 'Pomelo is not running' (-not (Get-Process -Name Pomelo -ErrorAction SilentlyContinue))
Check 'Windows no longer lists it' ($null -eq (Installed-Version))
Check 'the program folder is gone' (-not (Test-Path (Join-Path $dir 'Pomelo.exe')))
Check 'its settings are gone' (-not (Test-Path $appData))
Check 'the conversion engines folder is gone' (-not (Test-Path (Join-Path $engines 'keep-me.txt')))

Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
if ($failed) { Write-Host "`n$failed failed"; exit 1 }
Write-Host "`nall good"

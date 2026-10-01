# Nainstaluje Moje tapetu do %LOCALAPPDATA%\Programs\MojeTapeta i s vlastní kopií scén,
# spustí ji a nastaví spouštění po přihlášení. Nepotřebuje práva správce.
# Obrázek plochy se nemění: tapeta kreslí nad ním a po ukončení je vidět zase on.
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$project = Split-Path $here -Parent
$dest = Join-Path $env:LOCALAPPDATA 'Programs\MojeTapeta'
$run = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'

& (Join-Path $here 'build.ps1')
$built = Join-Path $here 'build\MojeTapeta'

if (Get-Process MojeTapeta -ErrorAction SilentlyContinue) {
    Write-Host 'Ukončuji běžící tapetu...'
    Start-Process (Join-Path $built 'MojeTapeta.exe') -ArgumentList '--quit' -Wait
    Start-Sleep -Seconds 2
    Get-Process MojeTapeta -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Milliseconds 500
}

if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item (Join-Path $built '*') $dest -Recurse -Force
Copy-Item (Join-Path $project 'scenes') $dest -Recurse -Force
Get-ChildItem (Join-Path $dest 'scenes') -Directory -Recurse -Filter tests | Remove-Item -Recurse -Force
Copy-Item (Join-Path $project 'LICENSE') $dest -Force

$exe = Join-Path $dest 'MojeTapeta.exe'
Set-ItemProperty -Path $run -Name 'MojeTapeta' -Value "`"$exe`""
Start-Process $exe
Write-Host "Moje tapeta nainstalována: $dest"
Write-Host 'Spustí se po každém přihlášení. Menu je v oznamovací oblasti (ikona se třemi hvězdičkami).'

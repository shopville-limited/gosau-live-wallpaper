# Ukončí a odebere Moje tapetu. Obrázek plochy instalace nikdy neměnila, ten pod ní zůstává váš.
$ErrorActionPreference = 'Stop'
$dest = Join-Path $env:LOCALAPPDATA 'Programs\MojeTapeta'
$exe = Join-Path $dest 'MojeTapeta.exe'

if (Get-Process MojeTapeta -ErrorAction SilentlyContinue) {
    if (Test-Path $exe) { Start-Process $exe -ArgumentList '--quit' -Wait }
    Start-Sleep -Seconds 2
    Get-Process MojeTapeta -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Milliseconds 500
}
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'MojeTapeta' -ErrorAction SilentlyContinue
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
Remove-Item 'HKCU:\Software\MojeTapeta' -Recurse -ErrorAction SilentlyContinue
$data = Join-Path $env:LOCALAPPDATA 'MojeTapeta'
if (Test-Path $data) { Remove-Item $data -Recurse -Force -ErrorAction SilentlyContinue }
Write-Host 'Moje tapeta odebrána.'

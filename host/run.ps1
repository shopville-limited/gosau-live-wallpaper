# Dočasné spuštění tapety přímo ze složky projektu. Scény se čtou odsud, takže úpravy
# se projeví po „Znovu načíst scénu“ v menu. Ukončení: Ctrl+C tady, nebo „Ukončit“ v menu.
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$project = Split-Path $here -Parent
& (Join-Path $here 'build.ps1')
$exe = Join-Path $here 'build\MojeTapeta\MojeTapeta.exe'

# Běží-li už nějaká tapeta (třeba nainstalovaná), nejdřív ji ukončí.
if (Get-Process MojeTapeta -ErrorAction SilentlyContinue) {
    Write-Host 'Ukončuji běžící tapetu...'
    Start-Process $exe -ArgumentList '--quit' -Wait
    Start-Sleep -Seconds 2
    Get-Process MojeTapeta -ErrorAction SilentlyContinue | Stop-Process -Force
}

$process = Start-Process $exe -ArgumentList '--root', "`"$project`"" -PassThru
Write-Host "Moje tapeta běží ze složky $project"
Write-Host 'Menu je v oznamovací oblasti (ikona se třemi hvězdičkami). Log: %TEMP%\moje-tapeta.log'
Write-Host 'Ukončíte ji klávesami Ctrl+C.'
try {
    $process.WaitForExit()
}
finally {
    if (-not $process.HasExited) {
        Start-Process $exe -ArgumentList '--quit' -Wait
        if (-not $process.WaitForExit(5000)) { $process.Kill() }
    }
    Write-Host 'Tapeta ukončena.'
}

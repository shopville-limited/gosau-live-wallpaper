# Samotest ve WebView2 (tom, ve kterém tapeta opravdu běží): vykreslí scénu v okně schovaném
# za obrázkem plochy, pošle falešný kurzor, spustí akce z menu a uloží PNG do host\tests\out\<scéna>. Projde všechny scény.
$ErrorActionPreference = 'Stop'
$host_ = Split-Path $PSScriptRoot -Parent
$project = Split-Path $host_ -Parent
$exe = Join-Path $host_ 'build\MojeTapeta\MojeTapeta.exe'
if (-not (Test-Path $exe)) { & (Join-Path $host_ 'build.ps1') }
$failed = 0
# Každá podsložka scenes/ s index.html je scéna; test projde všechny.
foreach ($scene in Get-ChildItem (Join-Path $project 'scenes') -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'index.html') }) {
    $out = Join-Path $PSScriptRoot "out\$($scene.Name)"
    # Staré snímky pryč (otevřený snímek smazat nejde, ten se jen přepíše).
    if (Test-Path $out) { Get-ChildItem $out -File | Remove-Item -Force -ErrorAction SilentlyContinue }
    $started = Get-Date
    $process = Start-Process $exe -ArgumentList '--test', "`"$out`"", '--scene', $scene.Name, '--root', "`"$project`"" -PassThru
    if (-not $process.WaitForExit(240000)) { $process.Kill(); throw "Test scény $($scene.Name) nedoběhl do 240 s." }
    $result = Join-Path $out 'vysledek.txt'
    if (-not (Test-Path $result) -or (Get-Item $result).LastWriteTime -lt $started) { throw "Test scény $($scene.Name) nezapsal výsledek." }
    Write-Host "=== $($scene.Name) ==="
    Get-Content $result -Encoding UTF8
    Write-Host "Snímky: $out"
    if ($process.ExitCode -ne 0) { $failed++ }
}
# Alpy ještě za soumraku (slunce pod obzorem): jiné větve kódu než ve dne (stíny, okna, mlha).
if (-not $env:MOJETAPETA_TEST_ADRESA) {
    $env:MOJETAPETA_TEST_ADRESA = 'hodina=19.5&mesic=10'
    $out = Join-Path (Join-Path $PSScriptRoot 'out') 'alpy-soumrak'
    if (Test-Path $out) { Get-ChildItem $out -File | Remove-Item -Force -ErrorAction SilentlyContinue }
    $started = Get-Date
    $process = Start-Process $exe -ArgumentList '--test', "`"$out`"", '--scene', 'alpy', '--root', "`"$project`"" -PassThru
    if (-not $process.WaitForExit(240000)) { $process.Kill(); throw 'Test Alp za soumraku nedoběhl do 240 s.' }
    Remove-Item Env:MOJETAPETA_TEST_ADRESA
    Write-Host '=== alpy za soumraku ==='
    Get-Content (Join-Path $out 'vysledek.txt') -Encoding UTF8
    if ($process.ExitCode -ne 0) { $failed++ }
}
exit $failed

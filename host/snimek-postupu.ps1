# Uloží snímek běžící tapety do složky postup/ jako další verzi a obnoví přehled
# (postup/README.md a postup/index.html). Tapeta musí běžet (run.cmd nebo instalace).
#
# Použití:  host\snimek-postupu.cmd "Krátký popis verze"
#           host\snimek-postupu.ps1 -Soubor obrazek.png -Popis "..." -Datum "2026-09-28 09:20"
#           (s -Soubor přidá hotový obrázek místo snímku tapety, třeba starší verzi)
#           host\snimek-postupu.ps1 -Nahradit 48 -Soubor obrazek.png -Popis "..."
#           (nahradí obrázek verze 48, třeba nevyrenderovaný; popis se doplní, datum zůstane)
param(
    [Parameter(Position = 0)][string]$Popis,
    [string]$Soubor,
    [string]$Datum,
    [int]$Nahradit = 0
)
if (-not $Popis -and -not $Nahradit) { throw 'Chybí popis verze.' }
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$project = Split-Path $PSScriptRoot -Parent
$folder = Join-Path $project 'postup'
New-Item -ItemType Directory -Force $folder | Out-Null

if (-not $Soubor) {
    $exe = Join-Path $PSScriptRoot 'build\MojeTapeta\MojeTapeta.exe'
    $png = Join-Path $env:TEMP 'moje-tapeta.png'
    $before = if (Test-Path $png) { (Get-Item $png).LastWriteTime } else { [datetime]::MinValue }
    # Dva snímky: první rozběhne zakrytou tapetu, aby se krajina stihla dopočítat.
    foreach ($i in 1..2) {
        # Aplikace je okenní program: na její konec se čeká přes Start-Process.
        $run = Start-Process $exe -ArgumentList '--snapshot' -Wait -PassThru
        if ($run.ExitCode -ne 0) { throw 'Tapeta neběží, spusťte ji (host\run.cmd).' }
        $deadline = (Get-Date).AddSeconds(40)
        while ((Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 500
            if ((Test-Path $png) -and (Get-Item $png).LastWriteTime -gt $before -and (Get-Item $png).Length -gt 0) { break }
        }
        $before = (Get-Item $png).LastWriteTime
        Start-Sleep -Seconds 6
    }
    $Soubor = $png
}
if (-not $Datum) { $Datum = (Get-Date).ToString('yyyy-MM-dd HH:mm') }

$list = Join-Path $folder 'verze.txt'
if ($Nahradit) {
    # Stávající verze: stejný soubor, popis doplněný o poznámku.
    $prefix = '{0:D2}-' -f $Nahradit
    $lines = Get-Content $list -Encoding UTF8
    $index = [Array]::FindIndex([string[]]$lines, [Predicate[string]] { param($l) $l.StartsWith($prefix) })
    if ($index -lt 0) { throw "Verze $Nahradit v verze.txt není." }
    $p = $lines[$index] -split '\s*\|\s*', 3
    $name = $p[0]
    if ($Popis) { $lines[$index] = "$($p[0]) | $($p[1]) | $Popis" }
    Set-Content -Path $list -Value $lines -Encoding UTF8
} else {
    $number = (Get-ChildItem $folder -Filter '*.jpg' | Measure-Object).Count + 1
    $slug = ($Popis.ToLowerInvariant().Normalize([Text.NormalizationForm]::FormD) -replace '\p{Mn}', '' -replace '[^a-z0-9]+', '-').Trim('-')
    if ($slug.Length -gt 40) { $slug = $slug.Substring(0, 40).Trim('-') }
    $name = '{0:D2}-{1}.jpg' -f $number, $slug
}

# JPG v kvalitě 88: v plném rozlišení asi 1 MB místo 6 MB PNG.
$image = [System.Drawing.Image]::FromFile((Resolve-Path $Soubor))
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object MimeType -eq 'image/jpeg'
$params = New-Object System.Drawing.Imaging.EncoderParameters 1
$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [long]88)
$image.Save((Join-Path $folder $name), $codec, $params)
$image.Dispose()

# Seznam verzí (popisy v verze.txt, jedna na řádek: soubor | datum | popis).
if (-not $Nahradit) { Add-Content -Path $list -Value "$name | $Datum | $Popis" -Encoding UTF8 }
$entries = Get-Content $list -Encoding UTF8 | Where-Object { $_.Trim() } | ForEach-Object {
    $p = $_ -split '\s*\|\s*', 3
    [pscustomobject]@{ File = $p[0]; Date = $p[1]; Text = $p[2] }
}

$md = @('# Postup práce na tapetě', '', 'Snímky jednotlivých verzí od nejstarší. Nové přidáte příkazem `host\snimek-postupu.cmd "popis"`.', '')
foreach ($e in $entries) { $md += "## $($e.File.Substring(0, 2)). $($e.Text)"; $md += ''; $md += "*$($e.Date)*"; $md += ''; $md += "![$($e.Text)]($($e.File))"; $md += '' }
Set-Content -Path (Join-Path $folder 'README.md') -Value $md -Encoding UTF8

$cards = foreach ($e in $entries) {
    $t = [System.Net.WebUtility]::HtmlEncode($e.Text)
    "<figure><a href=""$($e.File)""><img src=""$($e.File)"" loading=""lazy"" alt=""$t""></a><figcaption><b>$($e.File.Substring(0, 2)).</b> $t <span>$($e.Date)</span></figcaption></figure>"
}
$html = @"
<!doctype html>
<html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Postup tapety</title>
<style>
body { margin: 0; padding: 24px; background: #111318; color: #e6e8ee; font: 15px/1.5 system-ui, 'Segoe UI', sans-serif; }
h1 { font-weight: 600; margin: 0 0 20px; }
figure { margin: 0 0 32px; }
img { width: 100%; height: auto; display: block; border-radius: 8px; }
figcaption { margin-top: 8px; }
figcaption span { color: #8a90a0; margin-left: 8px; font-size: 13px; }
</style></head><body>
<h1>Postup práce na tapetě</h1>
$($cards -join "`n")
</body></html>
"@
Set-Content -Path (Join-Path $folder 'index.html') -Value $html -Encoding UTF8
Write-Host "Uloženo: postup\$name"

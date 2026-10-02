# Natočí záběry pro prezentační video: každý záběr otevře v samostatném okně Edge
# (1920 × 1080, vlastní profil), scéna se po dopočítání sama nahraje a pošle na server
# náhledu (node serve.mjs musí běžet). Nahrávky jsou v postup/video/zabery/*.webm.
#
# Použití: powershell -File tools\video\natocit.ps1 [-Jen nazev1,nazev2]
param([string[]]$Jen)
$ErrorActionPreference = 'Stop'
$project = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$out = Join-Path $project 'postup\video\zabery'
New-Item -ItemType Directory -Force $out | Out-Null
$profileDir = Join-Path $env:TEMP 'moje-tapeta-video-edge'

# název, sekundy nahrávky, parametry, scéna
$shots = @(
  @('01-uvod',      4, 'hodina=18.55&mesic=9&den=12&pocasi=nizka:15,vysoka:35,vitr:2', 'alpy'),
  @('02-den',       4, 'hodina=7.5&mesic=8&den=10&pocasi=nizka:25,vysoka:20,vitr:3&zrychleni=4000', 'alpy'),
  @('04-podzim',    4, 'hodina=9&mesic=10&den=18&pocasi=nizka:50,stredni:40,vitr:7,naraz:16&behem=listi', 'alpy'),
  @('05-zima',      4, 'hodina=13&mesic=1&den=20&pocasi=nizka:55,stredni:60,snih:1,srazky:1,teplota:-4,vitr:2', 'alpy'),
  @('06-bourka',    4, 'hodina=16.5&mesic=7&den=20&pocasi=nizka:80,stredni:90,srazky:5,teplota:18,vitr:9,naraz:20,kod:95&behem=boure', 'alpy'),
  @('09-noc',       4, 'hodina=3&mesic=4&den=17&pocasi=nizka:0,vitr:1&behem=meteor', 'alpy'),
  @('11-k-den',     4, 'hodina=11&mesic=8&den=15&pocasi=nizka:25,vysoka:20,vitr:3', 'krkonose'),
  @('12-k-inverze', 4, 'hodina=7.6&mesic=10&den=11&pocasi=nizka:0,vysoka:10,vitr:2,inverze:1,vrstva:1200&zrychleni=600', 'krkonose'),
  @('13-k-cepice',  4, 'hodina=14&mesic=9&den=12&pocasi=nizka:70,stredni:20,vitr:16,smer:260', 'krkonose'),
  @('14-k-zima',    4, 'hodina=12&mesic=1&den=24&pocasi=nizka:10,vysoka:20,teplota:-8,vitr:3', 'krkonose'),
  @('15-k-noc',     4, 'hodina=21.4&mesic=10&den=17&pocasi=nizka:0,vysoka:0,inverze:1,vrstva:1150', 'krkonose'),
  @('10-zaver',     4, 'hodina=18.7&mesic=9&den=12&pocasi=nizka:15,vysoka:35,vitr:2&behem=ptaci', 'alpy')
)

foreach ($s in $shots) {
  $name = $s[0]
  if ($Jen -and $Jen -notcontains $name) { continue }
  $file = Join-Path $out "$name.webm"
  if (Test-Path $file) { Remove-Item $file -Force }
  $url = "http://localhost:8080/scenes/$($s[3])/?$($s[2])&nahravat=$($s[1])&nazev=$name"
  Write-Host "Natáčím $name ..."
  $edge = Start-Process 'msedge' -PassThru -ArgumentList @(
    "--user-data-dir=`"$profileDir`"", '--no-first-run', '--no-default-browser-check',
    '--window-position=0,0', '--window-size=1920,1080', '--force-device-scale-factor=1',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling',
    "--app=$url")
  $deadline = (Get-Date).AddMinutes(4)
  while (-not (Test-Path $file) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
  Start-Sleep -Seconds 2
  Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
    Where-Object { $_.CommandLine -match [regex]::Escape($profileDir) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
  if (Test-Path $file) { Write-Host "  hotovo: $([math]::Round((Get-Item $file).Length / 1MB, 1)) MB" }
  else { Write-Host "  NEPODAŘILO SE (vypršel čas)" }
}

# Sestaví aplikaci Moje tapeta do host\build\MojeTapeta (MojeTapeta.exe, knihovny WebView2, bridge.js).
# Nic se neinstaluje: překládá se kompilátorem C#, který je součástí Windows (.NET Framework 4.8),
# a WebView2 SDK se jednou stáhne z nuget.org do host\build\packages.
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$version = '1.0.2903.40'
$packages = Join-Path $here 'build\packages'
$sdk = Join-Path $packages "Microsoft.Web.WebView2.$version"
$lib = Join-Path $sdk 'lib\net462'

if (-not (Test-Path (Join-Path $lib 'Microsoft.Web.WebView2.Core.dll'))) {
    New-Item -ItemType Directory -Force $packages | Out-Null
    $zip = Join-Path $packages "Microsoft.Web.WebView2.$version.zip"
    Write-Host "Stahuji WebView2 SDK $version z nuget.org..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest "https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/$version" -OutFile $zip -UseBasicParsing
    Expand-Archive $zip $sdk -Force
    Remove-Item $zip
}

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "Chybí kompilátor C# ($csc). Je potřeba .NET Framework 4.8." }

$out = Join-Path $here 'build\MojeTapeta'
New-Item -ItemType Directory -Force $out | Out-Null
Copy-Item (Join-Path $lib 'Microsoft.Web.WebView2.Core.dll'), (Join-Path $lib 'Microsoft.Web.WebView2.WinForms.dll') $out -Force
Copy-Item (Join-Path $sdk 'runtimes\win-x64\native\WebView2Loader.dll') $out -Force
Copy-Item (Join-Path $here 'src\bridge.js') $out -Force

$sources = Get-ChildItem (Join-Path $here 'src\*.cs') | ForEach-Object { $_.FullName }
& $csc /nologo /utf8output /codepage:65001 /target:winexe /platform:x64 /optimize+ `
    "/out:$(Join-Path $out 'MojeTapeta.exe')" "/win32manifest:$(Join-Path $here 'app.manifest')" `
    "/r:$(Join-Path $out 'Microsoft.Web.WebView2.Core.dll')" "/r:$(Join-Path $out 'Microsoft.Web.WebView2.WinForms.dll')" `
    /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll /r:System.Core.dll `
    $sources
if ($LASTEXITCODE -ne 0) { throw 'Překlad selhal.' }
Write-Host "Sestaveno: $out"

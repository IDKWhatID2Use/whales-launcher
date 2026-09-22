# ---------------------------------------------------------------------------
# publish-release.ps1 - build the shippable WhalesLauncher package.
#
# Produces, under artifacts\:
#     WhalesLauncher-<version>-win-x64.zip     the release asset
#
# Layout inside the zip (flat: the app sits at the archive root, so the user
# extracts once and double-clicks):
#     WhalesLauncher.exe        the application
#     <runtime files>           .NET + Windows App SDK, self-contained
#     bridge/server.cjs         the Node sidecar (version injected at build time)
#     WhalesLauncher.vbs/.bat   optional entry points
#     README-*.txt              Chinese getting-started notes
#
# WHY THE BRIDGE IS REBUILT HERE (2026-09 regression, fixed in v1.0.3):
#     dist\bridge\server.cjs carries the launcher version compiled in
#     (`--define:__WHALES_APP_VERSION__`, surfaced by app:version -> 关于页
#     "启动器版本" and by pack:export's launcherVersion). dist\ is gitignored,
#     so a bundle built before the version bump ships silently: the released
#     v1.0.2 asset reports "1.0.1" and v1.0.1's reports "1.0.0". This script
#     therefore rebuilds the bridge and then ASSERTS that the version compiled
#     into the bundled bridge equals package.json's version, refusing to ship
#     a mismatch instead of leaving it for the user to notice.
#
# WHY SELF-CONTAINED: the target machine must NOT need a .NET runtime
# installed. Verified by extracting the produced zip to a clean folder and
# launching the exe from there.
#
# WHY NOT SINGLE-FILE (PublishSingleFile=true):
#     Windows App SDK refuses it for unpackaged apps --
#       error : PublishSingleFile requires EnableMsixTooling for embedded
#               resources.pri generation
#     The two are mutually exclusive: single-file needs MSIX tooling, and
#     MSIX tooling is precisely what an unpackaged (WindowsPackageType=None)
#     app turns off. Setting EnableMsixTooling=true to satisfy it drags the
#     whole MSIX pipeline in, which is not what this project ships.
#     Hence the release asset is a zip. Measured, not guessed.
#
# PURE ASCII ON PURPOSE: PowerShell 5.1 reads a BOM-less .ps1 as ANSI
# (code page 936 here), so UTF-8 Chinese in a comment can decode into quote
# characters and break parsing. User-facing Chinese lives in the README file
# that gets packed, never in this script.
#
# EXIT CODES: 0 ok, 1 build failed, 2 staging failed, 3 zip failed,
#             4 bridge/version check failed
# ---------------------------------------------------------------------------
param(
    # Version label used in the file name. Defaults to package.json's version.
    [string]$Version,
    # Skip the build and reuse whatever is already in bin\x64\Release.
    [switch]$NoBuild,
    # Skip rebuilding dist\bridge\server.cjs. The version assertion STILL runs,
    # so this only saves time when the bundle is known to be current.
    [switch]$NoBridge
)

$ErrorActionPreference = 'Stop'

# Never force a diagnostics locale: either variable makes the XAML compiler
# hide real errors behind a misleading WMC9999 resource-lookup failure.
Remove-Item Env:DOTNET_CLI_UI_LANGUAGE -ErrorAction SilentlyContinue
Remove-Item Env:VSLANG -ErrorAction SilentlyContinue
$env:DOTNET_NOLOGO = '1'

$root = $PSScriptRoot | Split-Path -Parent
if ([string]::IsNullOrEmpty($root) -or -not (Test-Path -LiteralPath $root)) {
    Write-Host '[release] cannot determine the project root' -ForegroundColor Red
    exit 1
}

$csproj = Join-Path $root 'desktop\src\WhalesLauncher.App\WhalesLauncher.App.csproj'
$dotnet = 'C:\Program Files\dotnet\dotnet.exe'

if (-not (Test-Path -LiteralPath $dotnet)) {
    Write-Host "[release] dotnet not found at $dotnet" -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------- version
if ([string]::IsNullOrWhiteSpace($Version)) {
    $pkg = Join-Path $root 'package.json'
    if (Test-Path -LiteralPath $pkg) {
        $json = [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($pkg)) | ConvertFrom-Json
        $Version = [string]$json.version
    }
}
if ([string]::IsNullOrWhiteSpace($Version)) { $Version = '0.0.0' }

$artifacts = Join-Path $root 'artifacts'
$stage = Join-Path $artifacts 'release-staging'
$zip = Join-Path $artifacts ("WhalesLauncher-v$Version-win-x64.zip")
$releaseBin = Join-Path $root 'desktop\src\WhalesLauncher.App\bin\x64\Release\net10.0-windows10.0.26100.0\win-x64'

Write-Host "[release] version = $Version"

# ----------------------------------------------------------------- bridge
# The version compiled into dist\bridge\server.cjs comes from package.json at
# build time; a stale bundle is invisible until a user reads 关于页. Rebuild it
# and verify the compiled-in version before anything is packaged.
$bridgeRel = 'dist\bridge\server.cjs'
$bridgePath = Join-Path $root $bridgeRel
$buildBridge = Join-Path $root 'scripts\build-bridge.mjs'

if (-not $NoBridge) {
    if (-not (Test-Path -LiteralPath $buildBridge)) {
        Write-Host "[release] bridge build script not found: $buildBridge" -ForegroundColor Red
        exit 4
    }
    Write-Host '[release] rebuilding the Node sidecar (version is compiled in) ...' -ForegroundColor Cyan
    & node $buildBridge
    if ($LASTEXITCODE -ne 0) {
        Write-Host '[release] bridge build FAILED' -ForegroundColor Red
        exit 4
    }
}

if (-not (Test-Path -LiteralPath $bridgePath)) {
    Write-Host "[release] $bridgeRel not found - run: node scripts\build-bridge.mjs" -ForegroundColor Red
    exit 4
}

# The bundle carries: var BUILD_VERSION = true ? "1.0.3".trim() : "";
$bridgeText = [System.IO.File]::ReadAllText($bridgePath)
$m = [regex]::Match($bridgeText, 'BUILD_VERSION\s*=\s*[^"]*"([^"]+)"')
if (-not $m.Success) {
    Write-Host "[release] cannot find the compiled-in version in $bridgeRel" -ForegroundColor Red
    exit 4
}
$bridgeVersion = $m.Groups[1].Value
if ($bridgeVersion -ne $Version) {
    Write-Host "[release] VERSION MISMATCH: package.json = $Version but the sidecar was built with $bridgeVersion" -ForegroundColor Red
    Write-Host '[release] refusing to ship a package whose 关于页 would show the wrong version.' -ForegroundColor Red
    exit 4
}
Write-Host "[release] sidecar version check ok ($bridgeVersion)" -ForegroundColor Green

# ----------------------------------------------------------------- build
if (-not $NoBuild) {
    Write-Host '[release] building Release self-contained ...' -ForegroundColor Cyan
    & $dotnet build $csproj -c Release -p:Platform=x64 -p:RuntimeIdentifier=win-x64 -p:SelfContained=true -v:minimal
    if ($LASTEXITCODE -ne 0) {
        Write-Host '[release] build FAILED' -ForegroundColor Red
        exit 1
    }
}

if (-not (Test-Path -LiteralPath $releaseBin)) {
    Write-Host "[release] build output not found: $releaseBin" -ForegroundColor Red
    Write-Host '[release] run without -NoBuild first.' -ForegroundColor Red
    exit 1
}

# --------------------------------------------------------------- staging
Write-Host '[release] staging ...' -ForegroundColor Cyan
if (Test-Path -LiteralPath $stage) {
    Remove-Item -LiteralPath $stage -Recurse -Force
}
New-Item -ItemType Directory -Path $stage -Force | Out-Null

# Copy the whole self-contained output, excluding debug artefacts the build
# happens to leave behind (they must never ship).
& robocopy $releaseBin $stage /E /XF *.pdb crash.txt tabdiag.txt /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) {
    Write-Host "[release] robocopy failed with code $LASTEXITCODE" -ForegroundColor Red
    exit 2
}

# The app must be at the archive root: extract once, double-click.
if (-not (Test-Path -LiteralPath (Join-Path $stage 'WhalesLauncher.exe'))) {
    Write-Host '[release] staged package has no WhalesLauncher.exe at its root' -ForegroundColor Red
    exit 2
}

# The sidecar actually packed must carry this version too. This catches the
# -NoBuild path, where bin\x64\Release still holds a copy from an older build
# (csproj copies the bridge with PreserveNewest).
$stagedBridge = Join-Path $stage 'bridge\server.cjs'
if (-not (Test-Path -LiteralPath $stagedBridge)) {
    Write-Host '[release] staged package has no bridge\server.cjs' -ForegroundColor Red
    exit 2
}
$sm = [regex]::Match([System.IO.File]::ReadAllText($stagedBridge), 'BUILD_VERSION\s*=\s*[^"]*"([^"]+)"')
$stagedVersion = if ($sm.Success) { $sm.Groups[1].Value } else { '<not found>' }
if ($stagedVersion -ne $Version) {
    Write-Host "[release] staged sidecar version is $stagedVersion, expected $Version" -ForegroundColor Red
    Write-Host '[release] rebuild without -NoBuild (bin\x64\Release holds an older bridge copy).' -ForegroundColor Red
    exit 2
}
Write-Host "[release] staged sidecar version check ok ($stagedVersion)" -ForegroundColor Green

# ------------------------------------------------- user-facing extras
# Copied from desktop\release-assets\ rather than kept in the repo root: the
# root is a source tree and should not accumulate release-only files. A user
# who bought nothing but the zip needs these two, so their absence is fatal.
$assetsDir = Join-Path $root 'desktop\release-assets'
$readmeSrc = Get-ChildItem -LiteralPath $assetsDir -Filter 'README-*.txt' -ErrorAction SilentlyContinue | Select-Object -First 1
$batSrc = Get-ChildItem -LiteralPath $assetsDir -Filter '*.bat' -ErrorAction SilentlyContinue | Select-Object -First 1

if ($null -eq $readmeSrc -or $null -eq $batSrc) {
    Write-Host "[release] release assets missing under $assetsDir" -ForegroundColor Red
    Write-Host '[release] expected: a README-*.txt and a *.bat (double-click entry).' -ForegroundColor Red
    exit 2
}

Copy-Item -LiteralPath $readmeSrc.FullName -Destination $stage -Force
Copy-Item -LiteralPath $batSrc.FullName -Destination $stage -Force
Write-Host ("[release] packed notes: " + $readmeSrc.Name + " + " + $batSrc.Name)

# ------------------------------------------------------------------- zip
Write-Host '[release] zipping (this takes a while) ...' -ForegroundColor Cyan
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }

# tar -a picks the format from the extension and handles long paths that
# Compress-Archive chokes on. Both were tried; tar is the reliable one here.
& tar -a -c -f $zip -C $stage .
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $zip)) {
    Write-Host '[release] zip failed' -ForegroundColor Red
    exit 3
}

$z = Get-Item -LiteralPath $zip
$sha = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
$files = (Get-ChildItem -LiteralPath $stage -Recurse -File | Measure-Object)

Write-Host ''
Write-Host '[release] done' -ForegroundColor Green
Write-Host ("         asset   : " + $z.FullName)
Write-Host ("         bytes   : " + $z.Length + "  (" + [math]::Round($z.Length / 1MB, 2) + " MB)")
Write-Host ("         files   : " + $files.Count)
Write-Host ("         sha256  : " + $sha)
Write-Host ''
Write-Host '         Upload it with:'
Write-Host ("           gh release create v$Version `"$($z.FullName)`" --repo <owner>/<repo> --title `"WhalesLauncher v$Version`" --notes-file docs\release\v$Version-release-notes.md")

exit 0

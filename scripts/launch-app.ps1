# ---------------------------------------------------------------------------
# launch-app.ps1 - start the WhalesLauncher WinUI 3 desktop app.
#
# Shared implementation behind all three double-click entry points:
#   "WhalesLauncher.bat"  (visible console)  -> this script
#   "WhalesLauncher.vbs"  (windowless)       -> this script
#   the shortcut .bat in the root            -> makes shortcuts pointing at the .vbs
#
# WHY THIS FILE EXISTS (history):
#   The three entry points used to call scripts/launch.mjs, which started the
#   Electron shell. The front end was replaced by a native WinUI 3 app
#   (desktop/src/WhalesLauncher.App) and launch.mjs was deleted - but the
#   entry points kept calling it, so double-clicking was broken: the .vbs
#   popped "scripts\launch.mjs is missing" and the .bat failed with
#   "Cannot find module". This script is the replacement target.
#
# PURE ASCII ON PURPOSE (no BOM):
#   Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI (code page 936
#   here), so UTF-8 Chinese in a comment can decode into quote characters
#   and break parsing - the same trap already measured twice in this repo
#   (the old launcher .bat and .vbs both carry that story). Everything the
#   user sees is therefore English, and the console is switched to UTF-8
#   first so that UTF-8 text produced by the app itself still renders.
#
# EXIT CODES
#   0  app started (or -DryRun/-Check passed)
#   1  app not built yet (or engine of the start failed)
#   2  build requested with -Build but the build failed
# ---------------------------------------------------------------------------
param(
    # Build first, then launch. Off by default: a double-click should be
    # instant. On by default in the .bat? No - see README "Stale binary".
    [switch]$Build,
    # Find/validate the executable and print what would run, but do not start.
    [switch]$Check,
    # Do not detach: wait for the app to exit and propagate its exit code.
    # Used by tests and by anyone who wants the console to stay attached.
    [switch]$Wait,
    # Start with WHALES_LAUNCHER_ROOT pointing here (isolated data root).
    [string]$Root,
    # Start with WHALES_SMOKE_ROUTE set (QA deep link, see MainWindow.xaml.cs).
    [string]$Route
)

$ErrorActionPreference = 'Stop'

# The app writes UTF-8 diagnostics to stderr; make the console able to show
# them instead of printing mojibake. Harmless when there is no console (the
# .vbs path) - SetConsoleOutputCP simply fails and we ignore it.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
try { & chcp.com 65001 > $null 2>&1 } catch { }

# $PSScriptRoot is always set when PowerShell runs this with -File.
$root = $PSScriptRoot | Split-Path -Parent
if ([string]::IsNullOrEmpty($root) -or -not (Test-Path -LiteralPath $root)) {
    Write-Host '[launch] cannot determine the project root' -ForegroundColor Red
    exit 1
}

$appDir = Join-Path $root 'desktop\src\WhalesLauncher.App'
$csproj = Join-Path $appDir 'WhalesLauncher.App.csproj'
$buildScript = Join-Path $root 'desktop\build-app.ps1'

function Find-AppExe {
    <#
        Locate the newest WhalesLauncher.exe under the app's bin\ tree.
        Release wins over Debug only when both are present AND Release is at
        least as new; otherwise newest wins. Returns $null when nothing is
        built yet.
    #>
    $binDir = Join-Path $appDir 'bin'
    if (-not (Test-Path -LiteralPath $binDir)) { return $null }

    $candidates = @(Get-ChildItem -LiteralPath $binDir -Recurse -File -Filter 'WhalesLauncher.exe' -ErrorAction SilentlyContinue)
    if ($candidates.Count -eq 0) { return $null }

    # Exclude copies inside a publish\ subfolder only if a plain build output
    # exists, so a stale publish\ never shadows a fresh build.
    $plain = @($candidates | Where-Object { $_.DirectoryName -notmatch '\\publish' })
    if ($plain.Count -gt 0) { $candidates = $plain }

    return ($candidates | Sort-Object LastWriteTime -Descending | Select-Object -First 1)
}

function Invoke-AppBuild {
    if (-not (Test-Path -LiteralPath $buildScript)) {
        Write-Host "[launch] build script not found: $buildScript" -ForegroundColor Red
        return $false
    }
    Write-Host '[launch] building the app (desktop\build-app.ps1)...' -ForegroundColor Cyan
    # Pass through nothing: build-app.ps1 serialises itself with a named
    # Mutex, and -t:Rebuild must NOT be used on this project (it fails).
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $buildScript
    return ($LASTEXITCODE -eq 0)
}

# ------------------------------------------------------------------ pre-flight
$exe = Find-AppExe

if ($Build) {
    if (-not (Invoke-AppBuild)) {
        Write-Host '[launch] build failed; see the output above.' -ForegroundColor Red
        exit 2
    }
    $exe = Find-AppExe
}

if ($null -eq $exe) {
    Write-Host ''
    Write-Host '  WhalesLauncher is not built yet.' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '  Build it once with either of these (from the project root):'
    Write-Host '      npm run build'
    Write-Host '      powershell -NoProfile -ExecutionPolicy Bypass -File desktop\build-app.ps1'
    Write-Host ''
    Write-Host '  Or let this launcher do it - run the .bat launcher in the'
    Write-Host '  project root and pass --build (see README.md).'
    Write-Host ''
    if (Test-Path -LiteralPath $csproj) {
        Write-Host "  Project file: $csproj"
    }
    exit 1
}

$exePath = $exe.FullName
$sizeMb = [math]::Round($exe.Length / 1MB, 1)

if ($Check) {
    Write-Host '[launch] OK'
    Write-Host "         exe   : $exePath"
    Write-Host "         built : $($exe.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))"
    Write-Host "         bytes : $($exe.Length)  (${sizeMb} MB)"
    exit 0
}

# ------------------------------------------------------------------- start it
# The app resolves its data root from WHALES_LAUNCHER_ROOT (shared with the
# Node sidecar, see App.xaml.cs ResolveRootDirectory). Only set it when the
# caller asked for a specific root; otherwise inherit the environment.
if ($Root) {
    $env:WHALES_LAUNCHER_ROOT = (Resolve-Path -LiteralPath $Root).Path
}
if ($Route) {
    $env:WHALES_SMOKE_ROUTE = $Route
}

Write-Host "[launch] starting $exePath" -ForegroundColor Cyan

try {
    if ($Wait) {
        $proc = Start-Process -FilePath $exePath -WorkingDirectory $exe.DirectoryName -PassThru -Wait
        exit $proc.ExitCode
    }
    # Detached: the launcher should exit immediately so the console the .bat
    # opened can close instead of lingering behind the window.
    Start-Process -FilePath $exePath -WorkingDirectory $exe.DirectoryName | Out-Null
    Write-Host '[launch] started.' -ForegroundColor Green
    exit 0
} catch {
    Write-Host "[launch] failed to start: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

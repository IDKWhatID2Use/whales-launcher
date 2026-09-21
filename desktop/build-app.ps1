<#
.SYNOPSIS
    Build the WhalesLauncher WinUI 3 app, with cross-process serialization and retry.

.DESCRIPTION
    Solves three problems that repeatedly cost the team time:

      1. Concurrent builds of the same project collide on obj\ file locks, producing
         "CSC : error CS2012: Cannot open '...\WhalesLauncher.dll' for writing --
          The process cannot access the file because it is being used by another process."
         That is a LOCK CONFLICT, not a code error. This script serializes builds with a
         named Mutex, so N teammates can call it concurrently and each still gets a clean run.

      2. The XAML compiler hides real diagnostics behind a misleading
         "WMC9999 未能找到任何适合于指定的区域性或非特定区域性的资源" (resource lookup failure)
         unless DOTNET_CLI_UI_LANGUAGE is set. Setting VSLANG *also* breaks it.
         Verified by Lead: only "DOTNET_CLI_UI_LANGUAGE=en-US, VSLANG unset" shows real errors.
         This script sets that combination itself, so callers cannot get it wrong.

      3. XAML incremental compilation replays STALE errors for files already fixed.
         Use -Rebuild when an error's line number does not match the file's actual content.

    NOTE: ASCII-only by design. PowerShell 5.1 reads .ps1 files as ANSI, so non-ASCII
    characters in this file (Chinese comments, etc.) would be mis-decoded into syntax errors.

.PARAMETER Rebuild
    Pass -t:Rebuild to MSBuild. Clears the XAML incremental cache. Slower but authoritative.

.PARAMETER MaxAttempts
    How many times to retry when obj\ is locked by another build. Default 8.

.PARAMETER RetryWaitSeconds
    Seconds to wait between lock-contention retries. Default 20.

.EXAMPLE
    pwsh -File desktop\build-app.ps1 -Rebuild

.NOTES
    Exit codes: 0 = success, 1 = compile errors, 3 = could not acquire lock, 4 = gave up retrying.
#>
param(
    [switch]$Rebuild,
    [int]$MaxAttempts = 8,
    [int]$RetryWaitSeconds = 20
)

$ErrorActionPreference = 'Continue'

$project = Join-Path $PSScriptRoot 'src\WhalesLauncher.App\WhalesLauncher.App.csproj'
if (-not (Test-Path -LiteralPath $project)) {
    Write-Host "[build] project not found: $project"
    exit 2
}

$dotnet = 'C:\Program Files\dotnet\dotnet.exe'
if (-not (Test-Path -LiteralPath $dotnet)) {
    Write-Host "[build] dotnet not found at $dotnet"
    exit 2
}

# --- Diagnostics locale: DO NOT force one -------------------------------------
# History (this bit the team for several rounds, so it is documented here):
#   * Forcing DOTNET_CLI_UI_LANGUAGE=en-US made XamlCompiler fail to load its own
#     satellite error-message resources, which surfaced as the misleading
#     "WMC9999 未能找到任何适合于指定的区域性或非特定区域性的资源".
#   * NOT setting it (and clearing VSLANG) yields the real diagnostics.
#   * The deeper root cause of most WMC9999 sightings was CONCURRENT BUILDS:
#     another build deletes/rewrites obj\...\output.json and truncates the
#     generated *.g.cs files, so the compiler's OutputDeserializer fails and
#     reports a resource-lookup error that has nothing to do with the real cause.
#     That is exactly what the Mutex below prevents.
Remove-Item Env:DOTNET_CLI_UI_LANGUAGE -ErrorAction SilentlyContinue
Remove-Item Env:VSLANG -ErrorAction SilentlyContinue
$env:DOTNET_NOLOGO = '1'

$mutexName = 'Global\WhalesLauncherWinUI3Build'
$mutex = New-Object System.Threading.Mutex($false, $mutexName)
$acquired = $false
$exitCode = 1

try {
    Write-Host "[build] acquiring build lock (other agents may be building) ..."
    $acquired = $mutex.WaitOne([TimeSpan]::FromMinutes(20))
    if (-not $acquired) {
        Write-Host "[build] ERROR: could not acquire the build lock within 20 minutes"
        exit 3
    }
    Write-Host "[build] lock acquired"

    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        $buildArgs = @('build', $project, '-c', 'Debug')
        if ($Rebuild) { $buildArgs += '-t:Rebuild' }

        Write-Host "[build] attempt $attempt of $MaxAttempts $(if ($Rebuild) { '(full rebuild)' } else { '(incremental)' }) ..."
        $output = & $dotnet @buildArgs 2>&1
        $exitCode = $LASTEXITCODE
        $text = ($output | Out-String)

        # --- Problem 1: obj\ lock contention -> wait and retry -----------------
        if ($text -match 'being used by another process') {
            Write-Host "[build] obj\\ is locked by another build; waiting $RetryWaitSeconds s"
            Start-Sleep -Seconds $RetryWaitSeconds
            continue
        }

        $errors = $output | Select-String -Pattern ': error' | ForEach-Object { $_.Line.Trim() } | Select-Object -Unique
        if ($errors) {
            Write-Host ""
            Write-Host "[build] ---- ERRORS ----"
            $errors | ForEach-Object { Write-Host "  $_" }
            Write-Host ""
        }

        $summary = $output | Select-String -Pattern 'Error\(s\)|Warning\(s\)|Build succeeded'
        if ($summary) { $summary | ForEach-Object { Write-Host ("[build] " + $_.Line.Trim()) } }

        Write-Host "[build] done, exit=$exitCode"
        exit $exitCode
    }

    Write-Host "[build] gave up after $MaxAttempts attempts (persistent obj\\ lock contention)"
    exit 4
}
finally {
    if ($acquired) {
        try { $mutex.ReleaseMutex() } catch { }
    }
    $mutex.Dispose()
}

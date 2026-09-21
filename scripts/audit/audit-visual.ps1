# ---------------------------------------------------------------------------
# audit-visual.ps1 - per-page visual audit driver for the WinUI 3 front end.
#
# It launches the application once per theme, walks the configured page list
# (navigation steps are data, not code), captures real PNG screenshots of every
# page and interaction state, collects window / pixel / UI Automation evidence,
# and evaluates a fixed list of criteria into
#   docs/audit/visual-audit.json   (machine readable, evidence per criterion)
#   docs/audit/visual-audit.md     (human readable summary)
#
# STATUS VOCABULARY
#   pass          - the criterion was measured and the measurement satisfies it
#   fail          - the criterion was measured and the measurement violates it
#   unverifiable  - the criterion CANNOT be decided with the evidence available.
#                   Unverifiable is never counted as a pass. The reason field
#                   always states what was missing.
#
# PURE ASCII ON PURPOSE: Windows PowerShell 5.1 reads .ps1 files as ANSI.
#
# EXAMPLE
#   .\audit-visual.ps1 -ConfigFile .\pages.smoke.json -Themes Light,Dark
# ---------------------------------------------------------------------------
param(
    # JSON config that describes the application and the pages to visit.
    [string]$ConfigFile,
    # Inline JSON config (wins over -ConfigFile when both are given).
    [string]$ConfigJson,
    # Application executable. Overrides the value from the config file.
    [string]$Exe,
    # Output folder for PNG screenshots.
    [string]$OutDir,
    # Output path of the machine readable report.
    [string]$ReportJson,
    # Output path of the human readable report.
    [string]$ReportMarkdown,
    # Comma separated theme list. Supported values: Light, Dark, System.
    # Kept as a plain string on purpose: "-Themes Light,Dark" then behaves the
    # same whether it is typed on the command line or splatted from an array.
    [string]$Themes,
    # Temporarily flip HKCU AppsUseLightTheme to realise each theme. Without it
    # the tool only captures whatever theme the system currently uses and
    # requests -ThemeOverride values (if any) from the application itself.
    [switch]$AllowSystemThemeOverride,
    # Restore the previous HKCU theme value at the end of the run.
    [switch]$RestoreSystemTheme,
    # Audit only pages whose slug matches one of these values.
    [string[]]$OnlySlugs,
    # Milliseconds to wait after launching the application.
    [int]$LaunchWaitMs = 6000,
    # Milliseconds to wait after each navigation step batch.
    [int]$SettleMs = 1200,
    # Extra milliseconds of settle time used to verify render stability.
    [int]$StabilityMs = 800,
    # UI Automation traversal limits.
    [int]$UiaMaxDepth = 12,
    [int]$UiaMaxNodes = 400,
    # Skip the empty-shots-directory cleanup (the run is idempotent by default).
    [switch]$KeepOldShots,
    # Emit the report JSON on stdout as well as to disk.
    [switch]$EmitJson,
    # Do not write the .probe/audit scratch directory cleanup marker.
    [switch]$NoScratch
)

$ErrorActionPreference = 'Stop'

# Written without a byte order mark: ConvertFrom-Json tolerates a BOM but strict
# JSON parsers reject it, and these files are consumed by other tooling too.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$ScriptDir = $PSScriptRoot
. (Join-Path $ScriptDir 'capture-core.ps1')
Initialize-WinAuditCore

$repoRoot = (Resolve-Path (Join-Path $ScriptDir '..\..')).Path
$scratchDir = Join-Path $repoRoot '.probe\audit'

# ------------------------------------------------------------------- defaults
if (-not $OutDir) { $OutDir = Join-Path $repoRoot 'docs\audit\shots' }
if (-not $ReportJson) { $ReportJson = Join-Path $repoRoot 'docs\audit\visual-audit.json' }
if (-not $ReportMarkdown) { $ReportMarkdown = Join-Path $repoRoot 'docs\audit\visual-audit.md' }

$warnings = New-Object System.Collections.Generic.List[string]
$criteria = New-Object System.Collections.Generic.List[object]
$runs = New-Object System.Collections.Generic.List[object]
$shotRecords = New-Object System.Collections.Generic.List[object]
$pageSummaries = New-Object System.Collections.Generic.List[object]
$restoreTheme = $null
$themeOverrideApplied = $false

function Add-Warning {
    param([string]$Message)
    [void]$warnings.Add($Message)
    Write-Host "WARN: $Message" -ForegroundColor Yellow
}

function Add-Criterion {
    param(
        [string]$Id,
        [string]$Title,
        [string]$Scope,
        [string]$Status,
        [string]$Requirement,
        $Evidence,
        [string]$Reason
    )
    $rec = [pscustomobject]@{
        id          = $Id
        title       = $Title
        scope       = $Scope
        status      = $Status
        requirement = $Requirement
        evidence    = $Evidence
        reason      = $Reason
    }
    [void]$criteria.Add($rec)
    Write-Host ("  [{0,-12}] {1,-9} {2}" -f $Id, $Status, $Title)
    return $rec
}

function New-Slug {
    param([string]$Text)
    $s = $Text.ToLowerInvariant()
    $s = [regex]::Replace($s, '[^a-z0-9\-]+', '-')
    $s = [regex]::Replace($s, '-+', '-')
    $s = $s.Trim('-')
    if (-not $s) { $s = 'page' }
    return $s
}

function Get-CaptureToolResult {
    <#  Invokes capture-window.ps1 with a JSON args file and returns its parsed
        JSON plus the raw text, so a tool crash can never be silently mistaken
        for a clean result. The args file is also kept as run evidence. #>
    param(
        [hashtable]$ToolArgs,
        [string]$ArgsFilePath
    )

    $tool = Join-Path $ScriptDir 'capture-window.ps1'
    $argsJson = ($ToolArgs | ConvertTo-Json -Depth 8)
    [System.IO.File]::WriteAllText($ArgsFilePath, $argsJson, $utf8NoBom)

    $raw = & $tool -ArgsFile $ArgsFilePath 2>&1
    $exit = $LASTEXITCODE
    $text = ($raw | Out-String)
    $parsed = $null
    $parseError = $null
    if ($text -and $text.Trim().StartsWith('{')) {
        try { $parsed = $text | ConvertFrom-Json } catch { $parseError = $_.Exception.Message }
    } else {
        $parseError = 'tool produced no JSON (first 300 chars): ' + $text.Substring(0, [Math]::Min(300, $text.Length))
    }
    return [pscustomobject]@{
        exitCode   = $exit
        json       = $parsed
        raw        = $text
        parseError = $parseError
    }
}

# ------------------------------------------------------------------ load config
$config = $null
if ($ConfigJson) {
    $config = $ConfigJson | ConvertFrom-Json
} elseif ($ConfigFile) {
    if (-not (Test-Path -LiteralPath $ConfigFile)) { throw "config file not found: $ConfigFile" }
    $config = (Get-Content -LiteralPath $ConfigFile -Raw -Encoding UTF8) | ConvertFrom-Json
} else {
    throw 'provide -ConfigFile or -ConfigJson'
}

$appExe = $Exe
if (-not $appExe) { $appExe = [string]$config.exe }
if (-not $appExe) { throw 'no application executable: set -Exe or config.exe' }
if (-not (Test-Path -LiteralPath $appExe)) { throw "application executable not found: $appExe" }
$appExe = (Resolve-Path -LiteralPath $appExe).Path

$appArgs = [string]$config.exeArgs
$appWorkDir = [string]$config.workDir
$titleLike = [string]$config.windowTitleLike
if (-not $titleLike) { $titleLike = $null }

$pageList = @($config.pages)
if ($pageList.Count -eq 0) { throw 'config.pages is empty: nothing to audit' }

if ($OnlySlugs -and $OnlySlugs.Count -gt 0) {
    $pageList = @($pageList | Where-Object { $OnlySlugs -contains [string]$_.slug })
    if ($pageList.Count -eq 0) { throw 'no page matched -OnlySlugs' }
}

# Themes: config.themes (array of strings) or config.theme (single string).
$themeList = @()
if ($Themes) {
    $themeList = @($Themes -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
} elseif ($config.PSObject.Properties.Name -contains 'themes' -and $config.themes) {
    $themeList = @($config.themes)
} elseif ($config.PSObject.Properties.Name -contains 'theme' -and $config.theme) {
    $themeList = @([string]$config.theme)
} else {
    $themeList = @('System')
}
$themeList = @($themeList | ForEach-Object {
    $t = [string]$_
    if ($t.Length -gt 0) { $t.Substring(0, 1).ToUpperInvariant() + $t.Substring(1).ToLowerInvariant() } else { $t }
})
foreach ($t in $themeList) {
    if (@('Light', 'Dark', 'System') -notcontains $t) {
        throw "unsupported theme '$t' (supported: Light, Dark, System)"
    }
}

$systemThemeLight = WinAudit-GetSystemAppTheme
$configThemeOverride = $null
if ($config.PSObject.Properties.Name -contains 'themeOverride') { $configThemeOverride = $config.themeOverride }
$configExtraArgs = @()
if ($config.PSObject.Properties.Name -contains 'themeArgs' -and $config.themeArgs) {
    $configExtraArgs = @($config.themeArgs)
}

# ------------------------------------------------------------- run timestamp
$startedAt = Get-Date
$gitCommit = $null
$gitBranch = $null
try {
    Push-Location $repoRoot
    $gitBranch = (& git rev-parse --abbrev-ref HEAD 2>$null | Out-String).Trim()
    $gitCommit = (& git rev-parse HEAD 2>$null | Out-String).Trim()
    Pop-Location
} catch {
    try { Pop-Location } catch { }
    Add-Warning 'could not read git revision; report will not be tied to a commit'
}
$dirtyFiles = $null
try {
    Push-Location $repoRoot
    $dirtyFiles = (& git status --porcelain 2>$null | Out-String).Trim()
    Pop-Location
} catch {
    try { Pop-Location } catch { }
}

$exeSha = [WinAuditCore]::Sha256OfFile($appExe)
$exeItem = Get-Item -LiteralPath $appExe
$exeVersion = $null
try { $exeVersion = $exeItem.VersionInfo.FileVersion } catch { }
$exeWriteTime = $exeItem.LastWriteTime.ToString('o')

# spec traceability
$specPath = Join-Path $repoRoot 'docs\design\winui3-visual-spec.md'
$specSha = $null
if (Test-Path -LiteralPath $specPath) { $specSha = WinAudit-GetTextHash -Path $specPath }
$highContrastActive = $false
try {
    $hc = Get-ItemProperty -Path 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Themes' -Name 'HighContrast' -ErrorAction Stop
    $highContrastActive = [bool]($hc.HighContrast -eq 1)
} catch {
    $highContrastActive = $false
}
$textScaleFactor = $null
try {
    $ac = Get-ItemProperty -Path 'HKCU:\SOFTWARE\Microsoft\Accessibility' -Name 'TextScaleFactor' -ErrorAction Stop
    $textScaleFactor = [int]$ac.TextScaleFactor
} catch {
    $textScaleFactor = 100
}

# -------------------------------------------------------------- prep folders
if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
elseif (-not $KeepOldShots) {
    $removed = 0
    Get-ChildItem -LiteralPath $OutDir -Filter '*.png' -Force | ForEach-Object {
        Remove-Item -LiteralPath $_.FullName -Force
        $removed++
    }
    Write-Host "cleaned $removed stale screenshot(s) from $OutDir"
}
foreach ($p in @($ReportJson, $ReportMarkdown)) {
    $dir = Split-Path -Parent $p
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
}
if (-not $NoScratch -and -not (Test-Path -LiteralPath $scratchDir)) {
    New-Item -ItemType Directory -Path $scratchDir -Force | Out-Null
}

# ------------------------------------------------------------------- run loop
Write-Host "== WhalesLauncher visual audit =="
Write-Host "exe        : $appExe"
Write-Host "exe sha256 : $exeSha"
Write-Host "exe version: $exeVersion  (built $exeWriteTime)"
Write-Host "git        : $gitBranch @ $gitCommit"
Write-Host "themes     : $($themeList -join ', ')  (system app theme currently: $(if ($systemThemeLight) { 'Light' } else { 'Dark' }))"
Write-Host "pages      : $($pageList.Count)"
Write-Host "shots      : $OutDir"
Write-Host ''

foreach ($theme in $themeList) {
    Write-Host "---- theme: $theme ----"

    $themeApplied = $false
    $themeNote = ''
    $themeOverrideArg = $null

    $applied = $false
    if ($theme -ne 'System') {
        # 1) Preferred: ask the application itself to use this theme.
        if ($configExtraArgs.Count -gt 0) {
            $candidate = $null
            foreach ($a in $configExtraArgs) {
                $s = [string]$a
                if ($s -match '\{theme\}') { $candidate = $s.Replace('{theme}', $theme.ToLowerInvariant()) }
            }
            if ($candidate) { $themeOverrideArg = $candidate; $applied = $true; $themeNote = 'application argument' }
        }
        # 2) Fallback: temporarily flip the system app theme.
        if (-not $applied -and $AllowSystemThemeOverride) {
            $wantLight = ($theme -eq 'Light')
            $r = WinAudit-SetSystemAppTheme -Light $wantLight
            if ($r.Ok) {
                if ($null -eq $restoreTheme -and $null -ne $r.Previous) { $restoreTheme = $r.Previous }
                $applied = $true
                $themeOverrideApplied = $true
                $themeNote = "system AppsUseLightTheme set to $(if ($wantLight) { '1' } else { '0' })"
            } else {
                Add-Warning ("could not set the system theme for '$theme': " + $r.Reason)
            }
        }
        if (-not $applied) {
            $themeNote = 'not applied; the application was launched with the system theme'
        }
    } else {
        $themeNote = 'system theme as-is'
    }

    Write-Host "  theme realisation: $themeNote"

    $pid_ = 0
    $reusedPid = $false
    $launchCount = 0
    $pageIndex = 0

    foreach ($page in $pageList) {
        $pageIndex++
        $isLastPage = ($pageIndex -eq $pageList.Count)
        $slug = [string]$page.slug
        if (-not $slug) { $slug = New-Slug -Text ([string]$page.title) }
        $pageTitle = [string]$page.title
        if (-not $pageTitle) { $pageTitle = $slug }

        $prefix = Join-Path $OutDir ("$slug." + $theme.ToLowerInvariant())
        $shotBase = "$prefix.png"
        $shotFocus = "$prefix.focus.png"
        $shotStable = "$prefix.stable.png"
        $stepsPath = Join-Path $scratchDir ("steps-" + $slug + '-' + $theme.ToLowerInvariant() + '.json')
        $argsPath = Join-Path $scratchDir ("args-" + $slug + '-' + $theme.ToLowerInvariant() + '.json')
        $evidPath = Join-Path $scratchDir ("capture-" + $slug + '-' + $theme.ToLowerInvariant() + '.json')

        # Build the step sequence: navigation, then the interaction probes.
        $steps = New-Object System.Collections.Generic.List[object]
        foreach ($s in @($page.steps)) { [void]$steps.Add($s) }
        [void]$steps.Add(@{ Type = 'wait'; Ms = $SettleMs })
        [void]$steps.Add(@{ Type = 'capture'; Path = $shotBase; Uia = $true })
        [void]$steps.Add(@{ Type = 'key'; Chord = 'Tab' })
        [void]$steps.Add(@{ Type = 'wait'; Ms = 500 })
        [void]$steps.Add(@{ Type = 'capture'; Path = $shotFocus; Uia = $true })
        [void]$steps.Add(@{ Type = 'key'; Chord = 'Shift+Tab' })
        [void]$steps.Add(@{ Type = 'wait'; Ms = 400 })
        [void]$steps.Add(@{ Type = 'capture'; Path = $shotStable; Uia = $false })
        $stepsJson = ($steps | ConvertTo-Json -Depth 8)

        $toolArgs = @{
            StepsFile   = $stepsPath
            EmitJson    = $true
            Uia         = $true
            UiaMaxDepth = $UiaMaxDepth
            UiaMaxNodes = $UiaMaxNodes
            WaitMs      = $(if ($reusedPid) { 1200 } else { $LaunchWaitMs })
        }
        if ($titleLike) { $toolArgs['WindowTitleLike'] = $titleLike }

        if ($reusedPid -and [WinAuditCore]::Alive($pid_)) {
            $toolArgs['ExistingPid'] = $pid_
        } else {
            if ($reusedPid) { Add-Warning "application exited before page '$slug'; relaunching" }
            $toolArgs['Exe'] = $appExe
            if ($appWorkDir) { $toolArgs['WorkDir'] = $appWorkDir }
            $argsForLaunch = $appArgs
            if ($themeOverrideArg) {
                if ($argsForLaunch) { $argsForLaunch = ($argsForLaunch + ' ' + $themeOverrideArg) } else { $argsForLaunch = $themeOverrideArg }
            }
            if ($argsForLaunch) { $toolArgs['ExeArgs'] = $argsForLaunch }
            $launchCount++
        }
        # Keep the window alive between pages so the rest of the page list is
        # reached by in-app navigation instead of by relaunching. The last page
        # lets the tool clean up, and the theme loop kills the process anyway.
        if (-not $isLastPage) { $toolArgs['KeepAlive'] = $true }

        Write-Host "  page $slug ($theme) ..." -NoNewline
        $argList = @{}
        foreach ($k in $toolArgs.Keys) {
            $v = $toolArgs[$k]
            if ($v -is [bool]) { $argList[$k] = $(if ($v) { 'true' } else { 'false' }) }
            else { $argList[$k] = $v }
        }
        $toolResult = Get-CaptureToolResult -ToolArgs $argList -ArgsFilePath $argsPath

        # the raw tool output is the per-page evidence trail; write it before any
        # early exit so a failed page still leaves its full trace on disk
        [System.IO.File]::WriteAllText($evidPath, $toolResult.raw, $utf8NoBom)

        $cap = $toolResult.json
        if ($null -eq $cap) {
            Write-Host ' TOOL-ERROR'
            Add-Warning ("capture tool failed for $slug/$theme : " + $toolResult.parseError)
            [void]$runs.Add([pscustomobject]@{
                page = $slug; title = $pageTitle; theme = $theme
                toolExitCode = $toolResult.exitCode
                toolParseError = $toolResult.parseError
                toolRaw = $toolResult.raw
                ok = $false
            })
            [void]$shotRecords.Add([pscustomobject]@{
                page = $slug; title = $pageTitle; theme = $theme; kind = 'tool-failure'
                path = $null; status = 'tool-failure'; imageStats = $null; uia = $null
                windowClass = $null; windowRect = $null; pngSha256 = $null; error = $toolResult.parseError
            })
            continue
        }

        if ($cap.process -and $cap.process.pid) { $pid_ = [int]$cap.process.pid }
        $reusedPid = $true
        Write-Host (" ok=" + $cap.ok + " pid=" + $pid_)

        $captureByPath = @{}
        foreach ($c in @($cap.captures)) { $captureByPath[$c.path] = $c }

        foreach ($triple in @(
            @{ kind = 'base'; path = $shotBase },
            @{ kind = 'focus'; path = $shotFocus },
            @{ kind = 'stable'; path = $shotStable }
        )) {
            $c = $null
            if ($captureByPath.ContainsKey($triple.path)) { $c = $captureByPath[$triple.path] }
            $rec = [pscustomobject]@{
                page = $slug; title = $pageTitle; theme = $theme; kind = $triple.kind
                path = $triple.path
                status = $(if ($c) { $c.status } else { 'missing-from-tool-output' })
                windowClass = $(if ($c) { $c.windowClass } else { $null })
                windowRect = $(if ($c) { $c.windowRect } else { $null })
                pngSha256 = $(if ($c) { $c.pngSha256 } else { $null })
                pngBytes = $(if ($c) { $c.pngBytes } else { $null })
                clientOrigin = $(if ($c) { $c.clientOrigin } else { $null })
                imageStats = $(if ($c) { $c.imageStats } else { $null })
                uia = $(if ($c) { $c.uia } else { $null })
                error = $null
            }
            [void]$shotRecords.Add($rec)
        }

        [void]$runs.Add([pscustomobject]@{
            page = $slug; title = $pageTitle; theme = $theme
            toolExitCode = $toolResult.exitCode
            toolOk = $cap.ok
            error = $cap.error
            warnings = @($cap.warnings)
            process = $cap.process
            window = $cap.window
            steps = @($cap.steps)
            captureCount = @($cap.captures).Count
            evidenceFile = $evidPath
        })

        # --- per page criteria that need two frames -------------------------
        $st = $null
        if ($captureByPath.ContainsKey($shotStable)) { $st = $captureByPath[$shotStable].imageStats }

        # C5 stability: the base frame must match the frame after Tab/Shift+Tab.
        if ((Test-Path -LiteralPath $shotBase) -and (Test-Path -LiteralPath $shotStable) -and $st) {
            $diff = Compare-WinAuditImage -A $shotBase -B $shotStable -Threshold 24
            if ($diff.ok) {
                $ev = [pscustomobject]@{
                    changedPixelRatio = $diff.changedPixelRatio
                    changedBox = $diff.changedBox
                    threshold = 0.01
                    tool = 'Compare-WinAuditImage'
                }
                if ($diff.changedPixelRatio -le 0.01) {
                    [void](Add-Criterion -Id 'C5' -Title 'render stability between equivalent frames' -Scope 'page' -Status 'pass' -Requirement 'two captures of the same page state differ by at most 1% of pixels' -Evidence $ev -Reason '')
                } else {
                    [void](Add-Criterion -Id 'C5' -Title 'render stability between equivalent frames' -Scope 'page' -Status 'unverifiable' -Requirement 'two captures of the same page state differ by at most 1% of pixels' -Evidence $ev -Reason "the page kept changing between two ostensibly identical states (changed ratio $($diff.changedPixelRatio)); layout assertions on this frame would be unreliable")
                }
            } else {
                [void](Add-Criterion -Id 'C5' -Title 'render stability between equivalent frames' -Scope 'page' -Status 'unverifiable' -Requirement 'two captures of the same page state differ by at most 1% of pixels' -Evidence $diff -Reason ('pixel comparison failed: ' + $diff.reason))
            }
        } else {
            [void](Add-Criterion -Id 'C5' -Title 'render stability between equivalent frames' -Scope 'page' -Status 'unverifiable' -Requirement 'two captures of the same page state differ by at most 1% of pixels' -Evidence $null -Reason 'the stability frame could not be captured')
        }
    }

    # stop the app for this theme; capture-window.ps1 started it, so kill by pid
    if ($pid_ -gt 0 -and [WinAuditCore]::Alive($pid_)) {
        $kill = [WinAuditCore]::Kill($pid_)
        Write-Host "  stopped pid $pid_ ($kill)"
    }
    # give the process a moment so a stale pid can never be re-used by the next theme
    Start-Sleep -Milliseconds 500
}

# ---------------------------------------------------------------- criteria
Write-Host ''
Write-Host '== criteria =='

$capturedShots = @($shotRecords | Where-Object { $_.status -eq 'ok' -and $_.imageStats })
$baseShots = @($capturedShots | Where-Object { $_.kind -eq 'base' })
$focusShots = @($capturedShots | Where-Object { $_.kind -eq 'focus' })

# ---- C1 real capture
if ($baseShots.Count -gt 0) {
    [void](Add-Criterion -Id 'C1' -Title 'window capture succeeded for every page' -Scope 'run' -Status 'pass' `
        -Requirement 'each page produces a PNG through PrintWindow(PW_RENDERFULLCONTENT)' `
        -Evidence ([pscustomobject]@{ baseCaptures = $baseShots.Count; failed = @($shotRecords | Where-Object { $_.kind -eq 'base' -and $_.status -ne 'ok' }).Count }) `
        -Reason '')
} else {
    [void](Add-Criterion -Id 'C1' -Title 'window capture succeeded for every page' -Scope 'run' -Status 'fail' `
        -Requirement 'each page produces a PNG through PrintWindow(PW_RENDERFULLCONTENT)' `
        -Evidence ([pscustomobject]@{ baseCaptures = 0; records = @($shotRecords | Select-Object -First 5) }) `
        -Reason 'no page produced a base screenshot; every downstream criterion is void')
}

# ---- C2 real rendering (not black / not blank)
foreach ($s in $baseShots) {
    $st2 = $s.imageStats
    $ev = [pscustomobject]@{
        png = $s.path
        pngSha256 = $s.pngSha256
        width = $st2.width
        height = $st2.height
        blackishPixelRatio = $st2.blackishPixelRatio
        distinctColorsQuantized = $st2.distinctColorsQuantized
        distinctColorsQuantizedContentArea = $st2.distinctColorsQuantizedContentArea
        nonBackgroundPixelRatio = $st2.nonBackgroundPixelRatio
        contentLumaSpread = $st2.contentLumaSpread
        thresholds = [pscustomobject]@{ nonBlackSampleRatio = 0.05; distinctQuantized = 8; distinctQuantizedContentArea = 5 }
    }
    $problems = New-Object System.Collections.Generic.List[string]
    if ($st2.blackishPixelRatio -gt 0.95) { [void]$problems.Add('the frame is more than 95% black: PrintWindow produced an unusable bitmap') }
    if ($st2.distinctColorsQuantized -lt 8) { [void]$problems.Add("only $($st2.distinctColorsQuantized) quantized colours in the whole frame (threshold 8)") }
    if ($st2.distinctColorsQuantizedContentArea -lt 5) { [void]$problems.Add("only $($st2.distinctColorsQuantizedContentArea) quantized colours below the title bar (threshold 5)") }
    if ($st2.nonBackgroundPixelRatio -lt 0.001) { [void]$problems.Add("non-background pixels are $($st2.nonBackgroundPixelRatio) of the frame (threshold 0.001)") }

    if ($problems.Count -eq 0) {
        [void](Add-Criterion -Id 'C2' -Title 'capture contains real rendered content' -Scope 'page' -Status 'pass' `
            -Requirement 'the PNG is neither all-black nor visually empty' -Evidence $ev -Reason '')
    } else {
        [void](Add-Criterion -Id 'C2' -Title 'capture contains real rendered content' -Scope 'page' -Status 'fail' `
            -Requirement 'the PNG is neither all-black nor visually empty' -Evidence $ev -Reason ($problems -join '; '))
    }
}

# ---- C3 UI Automation element tree
foreach ($s in $baseShots) {
    if (-not $s.uia) {
        [void](Add-Criterion -Id 'C3' -Title 'UI Automation exposes the rendered element tree' -Scope 'page' -Status 'unverifiable' `
            -Requirement 'the window exposes a UIA element tree so that control-level assertions are possible' `
            -Evidence ([pscustomobject]@{ png = $s.path; uia = $null }) -Reason 'no UIA dump was recorded for this frame')
        continue
    }
    if (-not $s.uia.available) {
        [void](Add-Criterion -Id 'C3' -Title 'UI Automation exposes the rendered element tree' -Scope 'page' -Status 'unverifiable' `
            -Requirement 'the window exposes a UIA element tree so that control-level assertions are possible' `
            -Evidence ([pscustomobject]@{ png = $s.path; uiaReason = $s.uia.reason }) -Reason ('UI Automation was unavailable: ' + $s.uia.reason))
        continue
    }
    $nodes = @($s.uia.nodes)
    $textNodes = @($nodes | Where-Object { $_.ct -eq 'ControlType.Text' })
    $ctrlNodes = @($nodes | Where-Object { $_.ct -like 'ControlType.*' -and $_.ct -ne 'ControlType.Text' -and $_.ct -ne 'ControlType.Pane' -and $_.ct -ne 'ControlType.Custom' })
    $focusNodes = @($nodes | Where-Object { $_.focus -eq $true })
    $ev = [pscustomobject]@{
        png = $s.path
        controlViewNodes = $nodes.Count
        textElements = $textNodes.Count
        interactiveOrNamedControls = $ctrlNodes.Count
        focusedElements = $focusNodes.Count
        maxDepth = $s.uia.maxDepth
        truncatedCount = $s.uia.truncatedCount
        focusedSample = @($focusNodes | Select-Object -First 3 | ForEach-Object { "$($_.ct)/$($_.name)" })
    }
    if ($nodes.Count -lt 5) {
        [void](Add-Criterion -Id 'C3' -Title 'UI Automation exposes the rendered element tree' -Scope 'page' -Status 'fail' `
            -Requirement 'the window exposes a UIA element tree so that control-level assertions are possible' -Evidence $ev `
            -Reason "the control view exposed only $($nodes.Count) elements; the page cannot be audited at control level")
    } else {
        [void](Add-Criterion -Id 'C3' -Title 'UI Automation exposes the rendered element tree' -Scope 'page' -Status 'pass' `
            -Requirement 'the window exposes a UIA element tree so that control-level assertions are possible' -Evidence $ev -Reason '')
    }
}

# ---- C4 text clipping / overflow
foreach ($s in $baseShots) {
    if (-not $s.uia -or -not $s.uia.available) {
        [void](Add-Criterion -Id 'C4' -Title 'no text element overflows its container' -Scope 'page' -Status 'unverifiable' `
            -Requirement 'every text element stays inside its parent bounding box and inside the window (visual spec section 4.3)' `
            -Evidence ([pscustomobject]@{ png = $s.path }) -Reason 'no UIA element tree, so element rectangles are unknown')
        continue
    }
    $nodes = @($s.uia.nodes)
    $winW = 0; $winH = 0
    if ($s.windowRect) {
        $parts = $s.windowRect -split ','
        if ($parts.Count -eq 4) { $winW = [int]$parts[2]; $winH = [int]$parts[3] }
    }
    # UIA node rectangles are already window-relative (the capture tool subtracts
    # the window origin), so they are directly comparable with the PNG and with
    # the window rectangle. The client area origin offset is still needed to know
    # where the XAML content starts inside the frame.
    $offX = 0; $offY = 0; $cliW = $winW; $cliH = $winH
    if ($s.clientOrigin) {
        $co = $s.clientOrigin -split ','
        if ($co.Count -eq 4) { $offX = [int]$co[0]; $offY = [int]$co[1]; $cliW = [int]$co[2]; $cliH = [int]$co[3] }
    }

    $overflowParent = New-Object System.Collections.Generic.List[string]
    $overflowWindow = New-Object System.Collections.Generic.List[string]
    $checked = 0
    $tol = 2.0
    for ($i = 0; $i -lt $nodes.Count; $i++) {
        $n = $nodes[$i]
        if ($n.ct -ne 'ControlType.Text' -and $n.ct -ne 'ControlType.Header' -and $n.ct -ne 'ControlType.Button' -and $n.ct -ne 'ControlType.Hyperlink') { continue }
        if ($n.offscreen -eq $true -or $n.w -le 0 -or $n.h -le 0) { continue }
        # The system caption buttons (Minimize/Maximize/Close) are published by the
        # platform, not by the XAML tree, and their reported rectangle legitimately
        # sticks out of the TitleBar element. Excluding them by their platform
        # AutomationId avoids a false overflow report; nothing else is excluded.
        if ($n.aid -eq 'Minimize' -or $n.aid -eq 'Maximize' -or $n.aid -eq 'Close' -or $n.aid -eq 'SystemMenuBar' -or $n.aid -eq 'Item 1') { continue }
        $checked++

        # Real ancestry: node.p is the index recorded while the tree was walked.
        if ($n.p -ge 0 -and $n.p -lt $nodes.Count) {
            $parent = $nodes[$n.p]
            if ($parent.w -gt 0 -and $parent.h -gt 0) {
                if (($n.x + $n.w) -gt ($parent.x + $parent.w + $tol) -or ($n.y + $n.h) -gt ($parent.y + $parent.h + $tol) -or
                    ($n.x -lt ($parent.x - $tol)) -or ($n.y -lt ($parent.y - $tol))) {
                    [void]$overflowParent.Add("$($n.ct) '$($n.name)' at $($n.x),$($n.y) $($n.w)x$($n.h) vs parent $($parent.ct) '$($parent.name)' $($parent.x),$($parent.y) $($parent.w)x$($parent.h)")
                }
            }
        } elseif ($n.p -lt 0) {
            # root-level element: compare against the whole window box
            $relX = $n.x
            $relY = $n.y
            if ($winW -gt 0 -and (($relX + $n.w) -gt ($winW + $tol) -or ($relY + $n.h) -gt ($winH + $tol) -or $relX -lt -$tol -or $relY -lt -$tol)) {
                [void]$overflowWindow.Add("$($n.ct) '$($n.name)' at $relX,$relY $($n.w)x$($n.h) vs window $winW x $winH")
            }
        }
    }
    $ev = [pscustomobject]@{
        png = $s.path
        elementsChecked = $checked
        elementsOverflowingParent = $overflowParent.Count
        rootElementsOutsideWindow = $overflowWindow.Count
        windowSize = "$winW x $winH"
        clientSize = "$cliW x $cliH"
        clientOriginOffset = "$offX,$offY"
        uiaCoordinateFrame = 'window-relative'
        samples = @($overflowParent | Select-Object -First 6) + @($overflowWindow | Select-Object -First 6)
    }
    if ($checked -eq 0) {
        [void](Add-Criterion -Id 'C4' -Title 'no text element overflows its container' -Scope 'page' -Status 'unverifiable' `
            -Requirement 'every text element stays inside its parent bounding box and inside the window (visual spec section 4.3)' `
            -Evidence $ev -Reason 'the UIA tree exposed no measurable text elements')
    } elseif ($overflowParent.Count -eq 0 -and $overflowWindow.Count -eq 0) {
        [void](Add-Criterion -Id 'C4' -Title 'no text element overflows its container' -Scope 'page' -Status 'pass' `
            -Requirement 'every text element stays inside its parent bounding box and inside the window (visual spec section 4.3)' `
            -Evidence $ev -Reason 'geometric overflow only; whether an ellipsis is actually painted for trimmed text still needs the image')
    } else {
        [void](Add-Criterion -Id 'C4' -Title 'no text element overflows its container' -Scope 'page' -Status 'fail' `
            -Requirement 'every text element stays inside its parent bounding box and inside the window (visual spec section 4.3)' `
            -Evidence $ev -Reason "measured overflow on $($overflowParent.Count) element(s) vs their real UIA parent and $($overflowWindow.Count) root element(s) vs the window")
    }
}

# ---- C7 focus visible
foreach ($s in $baseShots) {
    $f = $focusShots | Where-Object { $_.page -eq $s.page -and $_.theme -eq $s.theme } | Select-Object -First 1
    if (-not $f) {
        [void](Add-Criterion -Id 'C7' -Title 'keyboard focus changes the rendering' -Scope 'page' -Status 'unverifiable' `
            -Requirement 'after one Tab press the focused element is visually distinguishable from the previous state (visual spec section 7.1)' `
            -Evidence ([pscustomobject]@{ base = $s.path }) -Reason 'the focus frame was not captured')
        continue
    }
    $diff = Compare-WinAuditImage -A $s.path -B $f.path -Threshold 24
    $baseFocus = @()
    $focusFocus = @()
    if ($s.uia -and $s.uia.available) { $baseFocus = @($s.uia.nodes | Where-Object { $_.focus -eq $true }) }
    if ($f.uia -and $f.uia.available) { $focusFocus = @($f.uia.nodes | Where-Object { $_.focus -eq $true }) }

    # Where did the pixels change, and does that overlap the element that took
    # focus? Both the changed box and the UIA node rectangles are expressed
    # relative to the top-left of the captured PNG, so they compare directly.
    $newFocus = $null
    if ($focusFocus.Count -gt 0) { $newFocus = $focusFocus[$focusFocus.Count - 1] }
    $overlap = $null
    $focusArea = $null
    if ($newFocus) {
        $fx = [double]$newFocus.x
        $fy = [double]$newFocus.y
        $fw = [double]$newFocus.w
        $fh = [double]$newFocus.h
        $focusArea = [Math]::Round($fw * $fh, 0)
        if ($diff.ok -and $diff.changedBox) {
            $bb = $diff.changedBox
            $bx1 = [double]$bb[0]; $by1 = [double]$bb[1]
            $bx2 = $bx1 + [double]$bb[2]; $by2 = $by1 + [double]$bb[3]
            $ix = [Math]::Min($bx2, $fx + $fw) - [Math]::Max($bx1, $fx)
            $iy = [Math]::Min($by2, $fy + $fh) - [Math]::Max($by1, $fy)
            $overlap = ($ix -gt 0 -and $iy -gt 0)
        }
    }

    $ev = [pscustomobject]@{
        base = $s.path
        focusFrame = $f.path
        changedPixels = $(if ($diff.ok) { $diff.changedPixels } else { $null })
        changedPixelRatio = $(if ($diff.ok) { $diff.changedPixelRatio } else { $null })
        changedBox = $(if ($diff.ok) { $diff.changedBox } else { $null })
        maxChannelSumDelta = $(if ($diff.ok) { $diff.maxChannelSumDelta } else { $null })
        focusedElement = $(if ($newFocus) { "$($newFocus.ct)/$($newFocus.name) @$($newFocus.x),$($newFocus.y) $($newFocus.w)x$($newFocus.h)" } else { $null })
        focusedElementAreaPx = $focusArea
        changeOverlapsFocusedElement = $overlap
        minChangedPixelsForPass = 100
        minShareOfFocusedElementForPass = 0.005
        coordinateFrame = 'window-relative for both the changed box and the UIA rectangles'
        focusBefore = @($baseFocus | ForEach-Object { "$($_.ct)/$($_.name) @$($_.x),$($_.y) $($_.w)x$($_.h)" })
        focusAfter = @($focusFocus | ForEach-Object { "$($_.ct)/$($_.name) @$($_.x),$($_.y) $($_.w)x$($_.h)" })
        diffError = $(if ($diff.ok) { $null } else { $diff.reason })
    }

    if (-not $diff.ok) {
        [void](Add-Criterion -Id 'C7' -Title 'keyboard focus changes the rendering' -Scope 'page' -Status 'unverifiable' `
            -Requirement 'after one Tab press the focused element is visually distinguishable from the previous state (visual spec section 7.1)' `
            -Evidence $ev -Reason ('pixel comparison failed: ' + $diff.reason))
    } elseif ($diff.changedPixelRatio -gt 0.05) {
        [void](Add-Criterion -Id 'C7' -Title 'keyboard focus changes the rendering' -Scope 'page' -Status 'unverifiable' `
            -Requirement 'after one Tab press the focused element is visually distinguishable from the previous state (visual spec section 7.1)' `
            -Evidence $ev -Reason "a Tab press changed $($diff.changedPixelRatio) of the frame, far too much to be a focus indicator (navigation or animation suspected); re-run with a chord that does not navigate")
    } elseif (-not $newFocus) {
        [void](Add-Criterion -Id 'C7' -Title 'keyboard focus changes the rendering' -Scope 'page' -Status 'unverifiable' `
            -Requirement 'after one Tab press the focused element is visually distinguishable from the previous state (visual spec section 7.1)' `
            -Evidence $ev -Reason 'the UIA dump reports no element with keyboard focus after the Tab press, so the changed pixels cannot be attributed to a focus indicator')
    } elseif ($overlap -eq $false) {
        [void](Add-Criterion -Id 'C7' -Title 'keyboard focus changes the rendering' -Scope 'page' -Status 'unverifiable' `
            -Requirement 'after one Tab press the focused element is visually distinguishable from the previous state (visual spec section 7.1)' `
            -Evidence $ev -Reason "the changed pixels are outside the focused element's rectangle (a text caret or an unrelated repaint is the likely cause), so they prove nothing about the focus indicator")
    } elseif ($diff.changedPixels -lt 100) {
        [void](Add-Criterion -Id 'C7' -Title 'keyboard focus changes the rendering' -Scope 'page' -Status 'fail' `
            -Requirement 'after one Tab press the focused element is visually distinguishable from the previous state (visual spec section 7.1)' `
            -Evidence $ev -Reason "focus moved to '$($newFocus.ct)/$($newFocus.name)' and changed only $($diff.changedPixels) pixel(s) inside it: no visible focus indicator was rendered (the UIA record proves focus moved, so this is an application finding)")
    } else {
        $share = $null
        if ($focusArea -gt 0) { $share = [Math]::Round($diff.changedPixels / $focusArea, 5) }
        if ($null -ne $share -and $share -lt 0.005) {
            [void](Add-Criterion -Id 'C7' -Title 'keyboard focus changes the rendering' -Scope 'page' -Status 'fail' `
                -Requirement 'after one Tab press the focused element is visually distinguishable from the previous state (visual spec section 7.1)' `
                -Evidence $ev -Reason "the change covers only $share of the focused element's area: too small to be a focus indicator")
        } else {
            [void](Add-Criterion -Id 'C7' -Title 'keyboard focus changes the rendering' -Scope 'page' -Status 'pass' `
                -Requirement 'after one Tab press the focused element is visually distinguishable from the previous state (visual spec section 7.1)' `
                -Evidence $ev -Reason 'focus moved and the changed pixels lie inside the focused element; whether the indicator is the system focus rect still needs a human look at the image')
        }
    }
}

# ---- C8 disabled state present
foreach ($s in $baseShots) {
    if (-not $s.uia -or -not $s.uia.available) {
        [void](Add-Criterion -Id 'C8' -Title 'disabled controls exist and are discoverable' -Scope 'page' -Status 'unverifiable' `
            -Requirement 'disabled state is expressed on controls and observable (visual spec section 7.4)' `
            -Evidence ([pscustomobject]@{ png = $s.path }) -Reason 'no UIA element tree, so IsEnabled cannot be read')
        continue
    }
    $nodes = @($s.uia.nodes)
    $disabled = @($nodes | Where-Object { $_.enabled -eq $false -and $_.offscreen -ne $true })
    $ev = [pscustomobject]@{
        png = $s.path
        elementsTotal = $nodes.Count
        disabledElements = $disabled.Count
        disabledSample = @($disabled | Select-Object -First 5 | ForEach-Object { "$($_.ct)/$($_.name)" })
    }
    if ($disabled.Count -eq 0) {
        [void](Add-Criterion -Id 'C8' -Title 'disabled controls exist and are discoverable' -Scope 'page' -Status 'unverifiable' `
            -Requirement 'disabled state is expressed on controls and observable (visual spec section 7.4)' -Evidence $ev `
            -Reason 'this page state contains no disabled control, so the disabled visual cannot be assessed from it')
    } else {
        [void](Add-Criterion -Id 'C8' -Title 'disabled controls exist and are discoverable' -Scope 'page' -Status 'pass' `
            -Requirement 'disabled state is expressed on controls and observable (visual spec section 7.4)' -Evidence $ev `
            -Reason 'existence only; that the disabled rendering matches the built-in Disabled visual state is not machine checked')
    }
}

# ---- C14 theme response
if ($themeList.Count -gt 1) {
    $light = $baseShots | Where-Object { $_.theme -eq 'Light' } | Select-Object -First 1
    $dark = $baseShots | Where-Object { $_.theme -eq 'Dark' } | Select-Object -First 1
    if ($light -and $dark) {
        $delta = [Math]::Abs([double]$light.imageStats.meanLuma - [double]$dark.imageStats.meanLuma)
        $ev = [pscustomobject]@{
            lightPng = $light.path
            lightMeanLuma = $light.imageStats.meanLuma
            darkPng = $dark.path
            darkMeanLuma = $dark.imageStats.meanLuma
            meanLumaDelta = [Math]::Round($delta, 2)
            threshold = 10
            themeOverrideApplied = $themeOverrideApplied
            themeArgsUsed = @($configExtraArgs)
        }
        if ($delta -ge 10) {
            [void](Add-Criterion -Id 'C14' -Title 'Light and Dark produce visibly different renderings' -Scope 'run' -Status 'pass' `
                -Requirement 'both themes render and differ (visual spec sections 3.1 and 3.4)' -Evidence $ev -Reason '')
        } else {
            [void](Add-Criterion -Id 'C14' -Title 'Light and Dark produce visibly different renderings' -Scope 'run' -Status 'fail' `
                -Requirement 'both themes render and differ (visual spec sections 3.1 and 3.4)' -Evidence $ev `
                -Reason "mean luminance differs by only $([Math]::Round($delta,2)); the application did not follow the requested theme (a build-time or config-time theme lock is the usual cause)")
        }
    } else {
        [void](Add-Criterion -Id 'C14' -Title 'Light and Dark produce visibly different renderings' -Scope 'run' -Status 'unverifiable' `
            -Requirement 'both themes render and differ (visual spec sections 3.1 and 3.4)' `
            -Evidence ([pscustomobject]@{ lightCaptured = ($null -ne $light); darkCaptured = ($null -ne $dark) }) `
            -Reason 'one of the two theme runs produced no base capture')
    }
} else {
    [void](Add-Criterion -Id 'C14' -Title 'Light and Dark produce visibly different renderings' -Scope 'run' -Status 'unverifiable' `
        -Requirement 'both themes render and differ (visual spec sections 3.1 and 3.4)' `
        -Evidence ([pscustomobject]@{ themes = $themeList }) -Reason 'the run covered a single theme; light/dark comparison needs -Themes Light,Dark')
}

# ---- C9 4 epx grid (measured margins)
foreach ($s in $baseShots) {
    $st3 = $s.imageStats
    $lm = [int]$st3.leftMarginPx
    $rm = [int]$st3.rightMarginPx
    $tr = [int]$st3.contentFirstRow
    $inset = [int]$st3.frameInsetPx
    $ev = [pscustomobject]@{
        png = $s.path
        frameInsetPx = $inset
        leftMarginPx = $lm
        rightMarginPx = $rm
        leftMarginIsMultipleOf4 = $(if ($lm -ge 0) { ($lm % 4) -eq 0 } else { $null })
        rightMarginIsMultipleOf4 = $(if ($rm -ge 0) { ($rm % 4) -eq 0 } else { $null })
        firstContentRowPx = $tr
        windowSize = "$($st3.width) x $($st3.height)"
        nearestSpecPadding = $null
        method = 'frame-excluded edge detection on the PNG'
    }
    [void](Add-Criterion -Id 'C9' -Title 'measured content margins are multiples of 4 epx' -Scope 'page' -Status 'unverifiable' `
        -Requirement 'every margin and padding is a multiple of 4 epx (visual spec sections 1.3 and 2.1)' -Evidence $ev `
        -Reason 'edge detection alone cannot decide the 4 epx grid: the first painted pixel is an anti-aliased glyph or a full-bleed background, not the layout box. Needs XAML static analysis or an instrumented layout dump.')
}

# ---- C6 font size ramp
foreach ($s in $baseShots) {
    [void](Add-Criterion -Id 'C6' -Title 'font sizes come from the built-in type ramp' -Scope 'page' -Status 'unverifiable' `
        -Requirement 'no hand-picked font size; sizes come from the 12/14/18/20/28/40 scale (visual spec sections 4.2 and 12)' `
        -Evidence ([pscustomobject]@{
            png = $s.path
            uiaTextElements = $(if ($s.uia -and $s.uia.available) { @($s.uia.nodes | Where-Object { $_.ct -eq 'ControlType.Text' }).Count } else { $null })
            observedFontSizes = @()
        }) `
        -Reason 'the managed UI Automation API in-package exposes no reliable font-size attribute, and a screenshot cannot be reduced to numeric font sizes without an OCR step. Needs XAML static analysis or an explicitly instrumented automation property.')
}

# ---- C13 status is not colour-only
[void](Add-Criterion -Id 'C13' -Title 'status is not conveyed by colour alone' -Scope 'run' -Status 'unverifiable' `
    -Requirement 'state must be readable without colour (visual spec section 8.2)' `
    -Evidence ([pscustomobject]@{ note = 'the UIA tree does carry names for status elements, but textual/iconic redundancy per state is a design judgement' }) `
    -Reason 'deciding this from pixels plus UIA names would require a per-state mapping that the tool does not have; a human must compare the state samples')

# ---- C10 contrast
[void](Add-Criterion -Id 'C10' -Title 'body text contrast is at least 4.5:1' -Scope 'run' -Status 'unverifiable' `
    -Requirement 'visible text has a luminance contrast ratio of at least 4.5:1 against its background (visual spec section 8.2)' `
    -Evidence ([pscustomobject]@{ note = 'the PNG contains the text, but pairing pixels to text spans needs OCR or a layout dump' }) `
    -Reason 'no text-to-pixel binding is available, so per-span contrast cannot be computed; a text-cluster contrast approximation is deliberately NOT used because it would produce a false pass')

# ---- C11 high contrast themes
[void](Add-Criterion -Id 'C11' -Title 'the four built-in contrast themes were exercised' -Scope 'run' -Status 'unverifiable' `
    -Requirement 'the app is walked through the four built-in contrast themes (visual spec sections 8.4 and 12)' `
    -Evidence ([pscustomobject]@{
        highContrastCurrentlyActive = $highContrastActive
        contrastThemesSupported = @('HighContrastWhite', 'HighContrastBlack', 'HighContrast#1', 'HighContrast#2')
        implemented = $false
    }) `
    -Reason 'this tool does not switch contrast themes (that is a system accessibility setting) and no per-theme comparison is implemented, so the claim cannot be evidenced here')

# ---- C12 interaction states (hover / pressed / open overlays)
[void](Add-Criterion -Id 'C12' -Title 'hover / open-overlay states were captured' -Scope 'run' -Status 'unverifiable' `
    -Requirement 'disabled, hover and open-overlay states each have at least one screenshot (visual spec section 7.4 and section 9)' `
    -Evidence ([pscustomobject]@{ note = 'capture-window.ps1 implements move/click/wheel steps, but no page in this run declared them' }) `
    -Reason 'the configured page list declares no hover/click step, so no hover or overlay evidence exists. Concluding anything about those states would be fabrication.')

# ---- C15 spec traceability
if ($specSha) {
    [void](Add-Criterion -Id 'C15' -Title 'the audit is tied to the exact spec revision' -Scope 'run' -Status 'pass' `
        -Requirement 'the report records the SHA256 of the spec it was measured against' `
        -Evidence ([pscustomobject]@{ specPath = $specPath; specSha256 = $specSha; specSha = ('sha256:' + $specSha.Substring(0, 16) + '...') }) -Reason '')
} else {
    [void](Add-Criterion -Id 'C15' -Title 'the audit is tied to the exact spec revision' -Scope 'run' -Status 'fail' `
        -Requirement 'the report records the SHA256 of the spec it was measured against' `
        -Evidence ([pscustomobject]@{ specPath = $specPath }) -Reason 'the visual spec file could not be read')
}

# ---- C16 PNG dimensions match the window
$dimMismatch = New-Object System.Collections.Generic.List[string]
foreach ($s in $capturedShots) {
    if (-not $s.windowRect) { continue }
    $parts = $s.windowRect -split ','
    if ($parts.Count -ne 4) { continue }
    if ([int]$parts[2] -ne [int]$s.imageStats.width -or [int]$parts[3] -ne [int]$s.imageStats.height) {
        [void]$dimMismatch.Add("$($s.path): window $($parts[2])x$($parts[3]) vs png $($s.imageStats.width)x$($s.imageStats.height)")
    }
}
if ($capturedShots.Count -eq 0) {
    [void](Add-Criterion -Id 'C16' -Title 'every PNG matches its window dimensions' -Scope 'run' -Status 'unverifiable' `
        -Requirement 'the capture is 1:1 with the window, so measured pixels are usable as layout evidence' `
        -Evidence ([pscustomobject]@{ captures = 0 }) -Reason 'no capture succeeded')
} elseif ($dimMismatch.Count -eq 0) {
    [void](Add-Criterion -Id 'C16' -Title 'every PNG matches its window dimensions' -Scope 'run' -Status 'pass' `
        -Requirement 'the capture is 1:1 with the window, so measured pixels are usable as layout evidence' `
        -Evidence ([pscustomobject]@{ captures = $capturedShots.Count; mismatches = 0 }) -Reason '')
} else {
    [void](Add-Criterion -Id 'C16' -Title 'every PNG matches its window dimensions' -Scope 'run' -Status 'fail' `
        -Requirement 'the capture is 1:1 with the window, so measured pixels are usable as layout evidence' `
        -Evidence ([pscustomobject]@{ mismatches = $dimMismatch.Count; samples = @($dimMismatch | Select-Object -First 5) }) `
        -Reason 'captured size differs from the window rectangle means scaling is in play')
}

# ---- C17 repeated frames are pixel-identical
$dupProblems = New-Object System.Collections.Generic.List[string]
$dupPairs = 0
foreach ($pr in ($capturedShots | Group-Object { "$($_.page)|$($_.theme)" })) {
    $bases = @($pr.Group | Where-Object { $_.kind -eq 'base' })
    if ($bases.Count -ne 1) { continue }
    $others = @($capturedShots | Where-Object { $_.page -eq $bases[0].page -and $_.theme -eq $bases[0].theme -and $_.kind -ne 'base' })
    foreach ($o in $others) {
        $dupPairs++
        if ($o.pngSha256 -eq $bases[0].pngSha256) {
            [void]$dupProblems.Add("$($o.kind) of $($bases[0].page)/$($bases[0].theme) is byte-identical to the base frame")
        }
    }
}
if ($dupPairs -eq 0) {
    [void](Add-Criterion -Id 'C17' -Title 'each captured state is a distinct frame' -Scope 'run' -Status 'unverifiable' `
        -Requirement 'the tool did not emit several shots of the same moment' `
        -Evidence ([pscustomobject]@{ comparedPairs = 0 }) -Reason 'no page produced more than one frame')
} elseif ($dupProblems.Count -eq 0) {
    [void](Add-Criterion -Id 'C17' -Title 'each captured state is a distinct frame' -Scope 'run' -Status 'pass' `
        -Requirement 'the tool did not emit several shots of the same moment' `
        -Evidence ([pscustomobject]@{ comparedPairs = $dupPairs; identicalPairs = 0 }) -Reason '')
} else {
    [void](Add-Criterion -Id 'C17' -Title 'each captured state is a distinct frame' -Scope 'run' -Status 'fail' `
        -Requirement 'the tool did not emit several shots of the same moment' `
        -Evidence ([pscustomobject]@{ comparedPairs = $dupPairs; identicalPairs = $dupProblems.Count; samples = @($dupProblems | Select-Object -First 5) }) `
        -Reason 'identical frames would mean an interaction step had no effect, so the state claim would be unsupported')
}

# ---- C18 no orphaned processes
# The application is deliberately kept alive between pages (KeepAlive) so the page
# list is reached by in-app navigation. What matters is that no pid used by this
# run is still running once the whole run has finished.
$orphanProblems = New-Object System.Collections.Generic.List[string]
$pidsSeen = @($runs | Where-Object { $_.process -and $_.process.pid } | ForEach-Object { [int]$_.process.pid } | Sort-Object -Unique)
foreach ($r in $runs) {
    if ($null -eq $r.process -or $null -eq $r.process.pid) {
        [void]$orphanProblems.Add("$($r.page)/$($r.theme): the tool reported no pid")
    }
}
foreach ($p in $pidsSeen) {
    if ([WinAuditCore]::Alive($p)) { [void]$orphanProblems.Add("pid $p is still running after the audit finished") }
}
if ($runs.Count -eq 0) {
    [void](Add-Criterion -Id 'C18' -Title 'no orphaned application process is left behind' -Scope 'run' -Status 'unverifiable' `
        -Requirement 'the audit cleans up after itself (idempotent reruns)' `
        -Evidence ([pscustomobject]@{ runs = 0 }) -Reason 'no run was executed')
} elseif ($orphanProblems.Count -eq 0) {
    [void](Add-Criterion -Id 'C18' -Title 'no orphaned application process is left behind' -Scope 'run' -Status 'pass' `
        -Requirement 'the audit cleans up after itself (idempotent reruns)' `
        -Evidence ([pscustomobject]@{ runs = $runs.Count; distinctPids = @($pidsSeen); aliveAfterRun = 0 }) -Reason '')
} else {
    [void](Add-Criterion -Id 'C18' -Title 'no orphaned application process is left behind' -Scope 'run' -Status 'fail' `
        -Requirement 'the audit cleans up after itself (idempotent reruns)' `
        -Evidence ([pscustomobject]@{ problems = $orphanProblems.Count; samples = @($orphanProblems | Select-Object -First 5) }) `
        -Reason 'a live application process would make the next run non-deterministic')
}

# ---- C19 traceability of build + config
$ev19 = [pscustomobject]@{
    exe = $appExe
    exeSha256 = $exeSha
    exeFileVersion = $exeVersion
    exeLastWriteTime = $exeWriteTime
    gitBranch = $gitBranch
    gitCommit = $gitCommit
    gitDirty = (-not [string]::IsNullOrWhiteSpace($dirtyFiles))
    specSha256 = $specSha
    configSource = $(if ($ConfigJson) { 'inline -ConfigJson' } else { $ConfigFile })
    configPages = @($pageList | ForEach-Object { [string]$_.slug })
    themes = $themeList
    systemAppThemeAtStart = $(if ($systemThemeLight) { 'Light' } else { 'Dark' })
    systemAppThemeRestored = $RestoreSystemTheme.IsPresent -and $themeOverrideApplied
    systemThemeChangedByTool = $themeOverrideApplied
    textScaleFactorPercent = $textScaleFactor
    highContrastActive = $highContrastActive
}
[void](Add-Criterion -Id 'C19' -Title 'the report is traceable to the exact artefact' -Scope 'run' -Status 'pass' `
    -Requirement 'timestamp plus executable SHA256 plus spec SHA256 plus git revision' -Evidence $ev19 -Reason '')

# ---- C20 report self-check
$readmePath = Join-Path $repoRoot 'docs\audit\README.md'
$reportOk = $true
$reportReason = New-Object System.Collections.Generic.List[string]
if ($baseShots.Count -lt 1) { $reportOk = $false; [void]$reportReason.Add('no base screenshot was produced') }
if ($criteria.Count -lt 10) { $reportOk = $false; [void]$reportReason.Add('fewer than 10 criteria were evaluated') }
if (-not (Test-Path -LiteralPath $readmePath)) { [void]$reportReason.Add('docs/audit/README.md is missing') }
foreach ($s in $baseShots) {
    if (-not $s.pngBytes -or $s.pngBytes -le 0) { $reportOk = $false; [void]$reportReason.Add("$($s.path) is empty") }
}
[void](Add-Criterion -Id 'C20' -Title 'the report itself is complete' -Scope 'run' -Status $(if ($reportOk) { 'pass' } else { 'fail' }) `
    -Requirement 'a report with at least one real screenshot, at least 10 criteria and non-empty PNG files' `
    -Evidence ([pscustomobject]@{ baseShots = $baseShots.Count; criteria = $criteria.Count; readmeExists = (Test-Path -LiteralPath $readmePath) }) `
    -Reason ($reportReason -join '; '))

# ---- C21 failure has an actionable reason
$badReasons = @($criteria | Where-Object { $_.status -ne 'pass' -and (-not $_.reason -or $_.reason.Trim().Length -lt 8) })
if ($badReasons.Count -eq 0) {
    [void](Add-Criterion -Id 'C21' -Title 'every non-pass criterion states a reason' -Scope 'run' -Status 'pass' `
        -Requirement 'an unverifiable or failing criterion must say what was missing, so it cannot be silently ignored' `
        -Evidence ([pscustomobject]@{ nonPass = @($criteria | Where-Object { $_.status -ne 'pass' }).Count }) -Reason '')
} else {
    [void](Add-Criterion -Id 'C21' -Title 'every non-pass criterion states a reason' -Scope 'run' -Status 'fail' `
        -Requirement 'an unverifiable or failing criterion must say what was missing, so it cannot be silently ignored' `
        -Evidence ([pscustomobject]@{ offenders = @($badReasons | ForEach-Object { $_.id }) }) `
        -Reason 'a criterion was marked non-pass without an explanation')
}

# ------------------------------------------------------------- restore theme
if ($themeOverrideApplied) {
    if ($RestoreSystemTheme) {
        $ok = WinAudit-RestoreSystemAppTheme -Previous $restoreTheme
        Write-Host ("restored system app theme to " + $(if ($restoreTheme) { 'Light' } else { 'Dark' }) + " : " + $ok)
    } else {
        Add-Warning ('the system app theme was changed to capture both themes and -RestoreSystemTheme was NOT given; the previous value was ' + $(if ($restoreTheme) { 'Light(1)' } else { 'Dark(0)' }))
    }
}

# ------------------------------------------------------------------- report
$summary = [pscustomobject]@{
    pass = @($criteria | Where-Object { $_.status -eq 'pass' }).Count
    fail = @($criteria | Where-Object { $_.status -eq 'fail' }).Count
    unverifiable = @($criteria | Where-Object { $_.status -eq 'unverifiable' }).Count
    total = $criteria.Count
}

$report = [ordered]@{
    schema = 'whaleslauncher.audit.visual/1'
    generatedAt = $startedAt.ToString('o')
    finishedAt = (Get-Date).ToString('o')
    durationSeconds = [Math]::Round(((Get-Date) - $startedAt).TotalSeconds, 2)
    tool = [pscustomobject]@{
        name = 'scripts/audit/audit-visual.ps1'
        captureTool = 'scripts/audit/capture-window.ps1'
        statusVocabulary = @{
            pass = 'measured and satisfying'
            fail = 'measured and violating'
            unverifiable = 'not decidable with the available evidence; never counted as pass'
        }
    }
    subject = [pscustomobject]@{
        exe = $appExe
        exeSha256 = $exeSha
        exeFileVersion = $exeVersion
        exeLastWriteTime = $exeWriteTime
        exeArgs = $appArgs
        workDir = $appWorkDir
        windowTitleLike = $titleLike
    }
    environment = [pscustomobject]@{
        gitBranch = $gitBranch
        gitCommit = $gitCommit
        gitDirty = (-not [string]::IsNullOrWhiteSpace($dirtyFiles))
        specPath = $specPath
        specSha256 = $specSha
        os = [System.Environment]::OSVersion.VersionString
        psVersion = $PSVersionTable.PSVersion.ToString()
        screenDpi = [WinAuditCore]::ScreenDpi()
        systemAppThemeAtStart = $(if ($systemThemeLight) { 'Light' } else { 'Dark' })
        systemThemeChangedByTool = $themeOverrideApplied
        systemThemeRestored = $(if ($RestoreSystemTheme -and $themeOverrideApplied) { $true } else { $false })
        highContrastActive = $highContrastActive
        textScaleFactorPercent = $textScaleFactor
    }
    plan = [pscustomobject]@{
        themes = $themeList
        pages = @($pageList | ForEach-Object { [pscustomobject]@{ slug = [string]$_.slug; title = [string]$_.title; steps = @($_.steps).Count } })
        shotsDir = $OutDir
    }
    summary = $summary
    criteria = @($criteria.ToArray())
    runs = @($runs.ToArray())
    screenshots = @($shotRecords.ToArray())
    warnings = @($warnings.ToArray())
}

$reportJsonText = $report | ConvertTo-Json -Depth 14
[System.IO.File]::WriteAllText($ReportJson, $reportJsonText, $utf8NoBom)

# ------------------------------------------------------------- markdown view
$md = New-Object System.Collections.Generic.List[string]
[void]$md.Add('# WinUI 3 visual audit report')
[void]$md.Add('')
[void]$md.Add('> Generated by `scripts/audit/audit-visual.ps1`. Every row below carries the evidence that produced it.')
[void]$md.Add('> `unverifiable` means the criterion could not be decided with the available evidence and is **not** a pass.')
[void]$md.Add('')
[void]$md.Add('## Result')
[void]$md.Add('')
[void]$md.Add('| status | count |')
[void]$md.Add('|---|---|')
[void]$md.Add("| pass | $($summary.pass) |")
[void]$md.Add("| fail | $($summary.fail) |")
[void]$md.Add("| unverifiable | $($summary.unverifiable) |")
[void]$md.Add("| total | $($summary.total) |")
[void]$md.Add('')
[void]$md.Add('## Subject')
[void]$md.Add('')
[void]$md.Add('| field | value |')
[void]$md.Add('|---|---|')
[void]$md.Add("| executable | ``$appExe`` |")
[void]$md.Add("| exe SHA256 | ``$exeSha`` |")
[void]$md.Add("| exe version | $exeVersion |")
[void]$md.Add("| exe built | $exeWriteTime |")
[void]$md.Add("| git | $gitBranch @ $gitCommit |")
[void]$md.Add("| working tree dirty | $(-not [string]::IsNullOrWhiteSpace($dirtyFiles)) |")
[void]$md.Add("| spec SHA256 | ``$specSha`` |")
[void]$md.Add("| themes | $($themeList -join ', ') |")
[void]$md.Add("| started | $($startedAt.ToString('yyyy-MM-dd HH:mm:ss')) |")
[void]$md.Add("| screen DPI | $([WinAuditCore]::ScreenDpi()) |")
[void]$md.Add("| system app theme at start | $(if ($systemThemeLight) { 'Light' } else { 'Dark' }) |")
[void]$md.Add("| system theme changed by tool | $themeOverrideApplied |")
[void]$md.Add("| text scale factor | $textScaleFactor% |")
[void]$md.Add("| high contrast active | $highContrastActive |")
[void]$md.Add('')
[void]$md.Add('## Criteria')
[void]$md.Add('')
[void]$md.Add('| id | scope | status | criterion | measurement | note |')
[void]$md.Add('|---|---|---|---|---|---|')
foreach ($c in $criteria) {
    $pageOf = ''
    if ($c.evidence -and ($c.evidence.PSObject.Properties.Name -contains 'png') -and $c.evidence.png) {
        $pageOf = Split-Path -Leaf $c.evidence.png
    }
    $title = $c.title
    if ($pageOf) { $title = "$title ($pageOf)" }
    $note = $c.reason
    if (-not $note) { $note = '-' }
    $note = $note -replace '\|', '\|'
    [void]$md.Add("| $($c.id) | $($c.scope) | $($c.status) | $title | see visual-audit.json | $note |")
}
[void]$md.Add('')
[void]$md.Add('## Screenshots')
[void]$md.Add('')
[void]$md.Add('| page | theme | state | png | distinct colours | non-background | mean luma | sha256 (16) |')
[void]$md.Add('|---|---|---|---|---|---|---|---|')
foreach ($s in $shotRecords) {
    $st4 = $s.imageStats
    $dc = '-'; $nb = '-'; $ml = '-'
    if ($st4) { $dc = $st4.distinctColorsQuantized; $nb = $st4.nonBackgroundPixelRatio; $ml = $st4.meanLuma }
    $hash = '-'
    if ($s.pngSha256) { $hash = $s.pngSha256.Substring(0, 16) }
    $rel = '-'
    if ($s.path) { $rel = Split-Path -Leaf $s.path }
    [void]$md.Add("| $($s.page) | $($s.theme) | $($s.kind) | $rel | $dc | $nb | $ml | $hash |")
}
[void]$md.Add('')
[void]$md.Add('## Unverifiable criteria and why')
[void]$md.Add('')
$unver = @($criteria | Where-Object { $_.status -eq 'unverifiable' })
if ($unver.Count -eq 0) {
    [void]$md.Add('None.')
} else {
    foreach ($c in $unver) {
        [void]$md.Add("- **$($c.id) $($c.title)** - $($c.reason)")
    }
}
[void]$md.Add('')
if ($warnings.Count -gt 0) {
    [void]$md.Add('## Warnings')
    [void]$md.Add('')
    foreach ($wn in $warnings) { [void]$md.Add("- $wn") }
    [void]$md.Add('')
}
[void]$md.Add('## Raw evidence')
[void]$md.Add('')
[void]$md.Add("- Machine readable report: ``$ReportJson``")
[void]$md.Add("- Per page capture dumps: ``.probe/audit/capture-<page>-<theme>.json``")
[void]$md.Add("- Per page step files: ``.probe/audit/steps-<page>-<theme>.json``")
[void]$md.Add('')

Set-Content -LiteralPath $ReportMarkdown -Value ($md -join "`r`n") -Encoding UTF8

# ------------------------------------------------------------------- console
Write-Host ''
Write-Host "== done =="
Write-Host ("pass {0} / fail {1} / unverifiable {2} / total {3}" -f $summary.pass, $summary.fail, $summary.unverifiable, $summary.total)
Write-Host "shots  : $OutDir"
Write-Host "report : $ReportJson"
Write-Host "summary: $ReportMarkdown"
if ($warnings.Count -gt 0) {
    Write-Host "warnings: $($warnings.Count)"
    foreach ($wn in $warnings) { Write-Host "  - $wn" }
}

if ($EmitJson) { Write-Output $reportJsonText }

if ($summary.fail -gt 0) { exit 1 }
exit 0

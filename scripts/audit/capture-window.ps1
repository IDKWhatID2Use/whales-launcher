# ---------------------------------------------------------------------------
# capture-window.ps1 - generalised window capture tool for WinUI 3 (W-AUDIT).
#
# Captures a WinUI 3 (or any HWND) window with PrintWindow(PW_RENDERFULLCONTENT)
# - the only approach verified to obtain DirectComposition content instead of a
# black bitmap - and emits structured JSON plus pixel statistics and an optional
# UI Automation element dump.
#
# PURE ASCII ON PURPOSE: Windows PowerShell 5.1 reads .ps1 files as ANSI, so any
# non-ASCII byte in this file would be mis-decoded into syntax errors.
#
# EXAMPLES
#   # launch, capture once, print the JSON result
#   .\capture-window.ps1 -Exe .\App.exe -OutPath .\shot.png -WaitMs 6000 -EmitJson
#
#   # capture two states of one run: write a steps file, then
#   .\capture-window.ps1 -Exe .\App.exe -StepsFile .\steps.json -EmitJson
#
#   # stop a process started by a previous run
#   .\capture-window.ps1 -Action stop -ExistingPid 12345 -EmitJson
# ---------------------------------------------------------------------------
param(
    # Path of the application executable.
    [string]$Exe,
    # Working directory for the launched process (defaults to the exe folder).
    [string]$WorkDir,
    # Extra command line arguments for the launched process.
    [string]$ExeArgs,
    # Single-shot output PNG. Used when neither -StepList nor -StepsFile is given.
    [string]$OutPath,
    # Milliseconds to wait after launch (and before the first implicit capture).
    [int]$WaitMs = 4000,
    # Case-insensitive substring that the window title must contain.
    [string]$WindowTitleLike,
    # Also emit a UIA element dump for every capture.
    [switch]$Uia,
    [int]$UiaMaxDepth = 12,
    [int]$UiaMaxNodes = 400,
    # launch | capture | stop.
    [string]$Action = 'launch',
    # Re-use an already running process id instead of starting a new one.
    [int]$ExistingPid = 0,
    # Keep the launched process running when the sequence finishes.
    [switch]$KeepAlive,
    # Launch the process but skip the implicit first capture.
    [switch]$SkipCapture,
    # Ordered "wait -> capture -> input -> capture" sequence, as JSON strings.
    [string[]]$StepList,
    # File containing a JSON array with the same shape as -StepList.
    [string]$StepsFile,
    # Emit the result JSON on stdout (diagnostics go to the verbose stream).
    [switch]$EmitJson,
    # Directory the caller wants emptied before the run (idempotency helper).
    [string]$CleanDir,
    # Create -CleanDir when it does not exist.
    [switch]$CreateCleanDir,
    # JSON file holding a parameter object. Used by audit-visual.ps1 instead of
    # command line splatting: PowerShell 5.1 binds a hashtable value as a single
    # argument, so a native $false or an array swallows the following "-Switch"
    # token and parameter binding fails in confusing ways. An args file has none
    # of that ambiguity and doubles as a record of exactly what was requested.
    [string]$ArgsFile
)

$ErrorActionPreference = 'Stop'

function ConvertTo-AuditBool {
    <#  Args files may legitimately carry booleans as JSON true/false or as
        strings. $false must never be silently dropped: an omitted KeepAlive
        would terminate a process the caller wanted to reuse. #>
    param($Value)
    if ($null -eq $Value) { return $false }
    if ($Value -is [bool]) { return [bool]$Value }
    $s = ([string]$Value).Trim().ToLowerInvariant()
    if ($s -eq 'true' -or $s -eq '1' -or $s -eq 'yes') { return $true }
    return $false
}

if ($ArgsFile) {
    if (-not (Test-Path -LiteralPath $ArgsFile)) {
        Write-Error "args file not found: $ArgsFile"
        exit 2
    }
    $a = (Get-Content -LiteralPath $ArgsFile -Raw -Encoding UTF8) | ConvertFrom-Json
    foreach ($p in $a.PSObject.Properties) {
        $name = $p.Name
        $val = $p.Value
        switch ($name) {
            'Exe'             { if ([string]$val) { $Exe = [string]$val } }
            'WorkDir'         { if ([string]$val) { $WorkDir = [string]$val } }
            'ExeArgs'         { if ([string]$val) { $ExeArgs = [string]$val } }
            'OutPath'         { if ([string]$val) { $OutPath = [string]$val } }
            'WaitMs'          { if ($null -ne $val) { $WaitMs = [int]$val } }
            'WindowTitleLike' { if ([string]$val) { $WindowTitleLike = [string]$val } }
            'Uia'             { $Uia = ConvertTo-AuditBool $val }
            'UiaMaxDepth'     { if ($null -ne $val) { $UiaMaxDepth = [int]$val } }
            'UiaMaxNodes'     { if ($null -ne $val) { $UiaMaxNodes = [int]$val } }
            'Action'          { if ([string]$val) { $Action = [string]$val } }
            'ExistingPid'     { if ($null -ne $val) { $ExistingPid = [int]$val } }
            'KeepAlive'       { $KeepAlive = ConvertTo-AuditBool $val }
            'SkipCapture'     { $SkipCapture = ConvertTo-AuditBool $val }
            'StepList'        { $StepList = @($val | ForEach-Object { [string]$_ }) }
            'StepsFile'       { if ([string]$val) { $StepsFile = [string]$val } }
            'EmitJson'        { $EmitJson = ConvertTo-AuditBool $val }
            'CleanDir'        { if ([string]$val) { $CleanDir = [string]$val } }
            'CreateCleanDir'  { $CreateCleanDir = ConvertTo-AuditBool $val }
            default           { Write-Verbose "args file: ignoring unknown key '$name'" }
        }
    }
}

. (Join-Path $PSScriptRoot 'capture-core.ps1')
Initialize-WinAuditCore

$auditWarnings = New-Object System.Collections.Generic.List[string]
$auditTrace = New-Object System.Collections.Generic.List[object]
$auditCaptures = New-Object System.Collections.Generic.List[object]
$auditStepResults = New-Object System.Collections.Generic.List[object]
$launchedHere = $false
$auditTimer = [System.Diagnostics.Stopwatch]::StartNew()

function Add-AuditWarning {
    param([string]$Message)
    [void]$auditWarnings.Add($Message)
    Write-Verbose "WARN: $Message"
}

function Add-AuditTrace {
    param([string]$Event, [string]$Detail)
    [void]$auditTrace.Add([pscustomobject]@{
        atMs   = $auditTimer.ElapsedMilliseconds
        event  = $Event
        detail = $Detail
    })
}

function Get-HwndForPid {
    param([int]$TargetPid)
    return [WinAuditCore]::FindWindow($TargetPid, $WindowTitleLike)
}

function Wait-ForWindow {
    param([int]$TargetPid, [int]$TimeoutMs = 30000)
    $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
    $lastError = 'no-window-found'
    while ((Get-Date) -lt $deadline) {
        if (-not [WinAuditCore]::Alive($TargetPid)) {
            return @{ Hwnd = [IntPtr]::Zero; Reason = 'process-exited-before-window-appeared' }
        }
        try {
            $h = Get-HwndForPid -TargetPid $TargetPid
            if ($h -ne [IntPtr]::Zero) { return @{ Hwnd = $h; Reason = 'ok' } }
        } catch {
            $lastError = 'find-window-threw: ' + $_.Exception.Message
        }
        Start-Sleep -Milliseconds 400
    }
    return @{ Hwnd = [IntPtr]::Zero; Reason = ('window-timeout: ' + $lastError) }
}

function Get-StepField {
    <#  Safe field read: returns $null when the field is absent. #>
    param($Step, [string]$Name)
    if ($null -eq $Step) { return $null }
    if ($Step.PSObject.Properties.Name -contains $Name) { return $Step.$Name }
    return $null
}

function Invoke-CaptureStep {
    param(
        $Step,
        [int]$TargetPid
    )

    $type = [string](Get-StepField -Step $Step -Name 'Type')
    if (-not $type) { $type = [string](Get-StepField -Step $Step -Name 'Kind') }
    $type = $type.ToLowerInvariant()

    switch ($type) {
        'wait' {
            $ms = 1000
            $v = Get-StepField -Step $Step -Name 'Ms'
            if ($null -ne $v) { $ms = [int]$v }
            Start-Sleep -Milliseconds $ms
            [void]$auditStepResults.Add([pscustomobject]@{ type = 'wait'; ok = $true; ms = $ms })
            Add-AuditTrace 'wait' "$ms ms"
            return $true
        }
        'focus' {
            $h = Get-HwndForPid -TargetPid $TargetPid
            if ($h -eq [IntPtr]::Zero) {
                [void]$auditStepResults.Add([pscustomobject]@{ type = 'focus'; ok = $false; error = 'no-window' })
                Add-AuditWarning 'focus step: no window for pid'
                return $false
            }
            $r = [WinAuditCore]::SetForeground($h)
            [void]$auditStepResults.Add([pscustomobject]@{ type = 'focus'; ok = ($r -eq 'ok'); result = $r })
            Add-AuditTrace 'focus' $r
            return $true
        }
        'key' {
            $chord = [string](Get-StepField -Step $Step -Name 'Chord')
            if (-not $chord) { $chord = [string](Get-StepField -Step $Step -Name 'Key') }
            $h = Get-HwndForPid -TargetPid $TargetPid
            if ($h -ne [IntPtr]::Zero) { [void][WinAuditCore]::SetForeground($h) }
            Start-Sleep -Milliseconds 150
            $r = [WinAuditCore]::Key($chord)
            [void]$auditStepResults.Add([pscustomobject]@{ type = 'key'; chord = $chord; ok = ($r -eq 'ok'); result = $r })
            Add-AuditTrace 'key' "$chord -> $r"
            if ($r -ne 'ok') { Add-AuditWarning "key step '$chord' returned '$r'" }
            return ($r -eq 'ok')
        }
        'text' {
            $val = [string](Get-StepField -Step $Step -Name 'Value')
            $h = Get-HwndForPid -TargetPid $TargetPid
            if ($h -ne [IntPtr]::Zero) { [void][WinAuditCore]::SetForeground($h) }
            Start-Sleep -Milliseconds 150
            $r = [WinAuditCore]::Text($val)
            [void]$auditStepResults.Add([pscustomobject]@{ type = 'text'; length = $val.Length; result = $r })
            Add-AuditTrace 'text' $r
            return $true
        }
        'move' {
            $x = 0; $y = 0
            $vx = Get-StepField -Step $Step -Name 'X'
            $vy = Get-StepField -Step $Step -Name 'Y'
            if ($null -ne $vx) { $x = [int]$vx }
            if ($null -ne $vy) { $y = [int]$vy }
            $h = Get-HwndForPid -TargetPid $TargetPid
            if ($h -eq [IntPtr]::Zero) {
                [void]$auditStepResults.Add([pscustomobject]@{ type = 'move'; ok = $false; error = 'no-window' })
                return $false
            }
            $r = [WinAuditCore]::MoveTo($h, $x, $y)
            [void]$auditStepResults.Add([pscustomobject]@{ type = 'move'; x = $x; y = $y; ok = ($r -eq 'ok'); result = $r })
            Add-AuditTrace 'move' "$x,$y -> $r"
            return ($r -eq 'ok')
        }
        'click' {
            $x = 0; $y = 0; $btn = 'left'
            $vx = Get-StepField -Step $Step -Name 'X'
            $vy = Get-StepField -Step $Step -Name 'Y'
            $vb = Get-StepField -Step $Step -Name 'Button'
            if ($null -ne $vx) { $x = [int]$vx }
            if ($null -ne $vy) { $y = [int]$vy }
            if ($vb) { $btn = [string]$vb }
            $h = Get-HwndForPid -TargetPid $TargetPid
            if ($h -eq [IntPtr]::Zero) {
                [void]$auditStepResults.Add([pscustomobject]@{ type = 'click'; ok = $false; error = 'no-window' })
                return $false
            }
            $r = [WinAuditCore]::Click($h, $x, $y, $btn)
            Add-AuditTrace 'click' "$btn $x,$y -> $r"
            Start-Sleep -Milliseconds 350
            [void]$auditStepResults.Add([pscustomobject]@{ type = 'click'; x = $x; y = $y; button = $btn; ok = ($r -eq 'ok'); result = $r })
            return ($r -eq 'ok')
        }
        'wheel' {
            $d = -120
            $vd = Get-StepField -Step $Step -Name 'Delta'
            if ($null -ne $vd) { $d = [int]$vd }
            $h = Get-HwndForPid -TargetPid $TargetPid
            if ($h -ne [IntPtr]::Zero) { [void][WinAuditCore]::SetForeground($h) }
            $r = [WinAuditCore]::Wheel($h, $d)
            [void]$auditStepResults.Add([pscustomobject]@{ type = 'wheel'; delta = $d; result = $r })
            Add-AuditTrace 'wheel' "$d"
            return $true
        }
        'capture' {
            $path = $OutPath
            $vp = Get-StepField -Step $Step -Name 'Path'
            if ($vp) { $path = [string]$vp }
            $wantUia = $Uia
            $vu = Get-StepField -Step $Step -Name 'Uia'
            if ($null -ne $vu) { $wantUia = [bool]$vu }
            $doCapture = $true
            $vc = Get-StepField -Step $Step -Name 'Capture'
            if ($null -ne $vc) { $doCapture = [bool]$vc }
            if (-not $path) {
                Add-AuditWarning 'capture step without a path was skipped'
                [void]$auditStepResults.Add([pscustomobject]@{ type = 'capture'; ok = $false; error = 'no-path' })
                return $false
            }
            if (-not $doCapture) {
                [void]$auditStepResults.Add([pscustomobject]@{ type = 'capture'; ok = $true; path = $path; skipped = $true })
                return $true
            }
            $h = Get-HwndForPid -TargetPid $TargetPid
            if ($h -eq [IntPtr]::Zero) {
                Add-AuditWarning "capture step '$path' failed: no window for pid $TargetPid"
                [void]$auditStepResults.Add([pscustomobject]@{ type = 'capture'; ok = $false; path = $path; error = 'no-window' })
                return $false
            }
            [void][WinAuditCore]::SetForeground($h)
            Start-Sleep -Milliseconds 250
            $res = [WinAuditCore]::CaptureToPng($h, $path)
            $rectStr = ([WinAuditCore]::RectOf($h) -join ',')
            $clientStr = ([WinAuditCore]::ClientOriginOffset($h) -join ',')
            $rec = [pscustomobject]@{
                path        = $path
                status      = $res
                windowRect  = $rectStr
                clientOrigin = $clientStr
                windowClass = [WinAuditCore]::ClassOf($h)
                windowTitle = [WinAuditCore]::TextOf($h)
                pngSha256   = $null
                pngBytes    = $null
                imageStats  = $null
                uia         = $null
            }
            if ($res -eq 'ok') {
                $rec.pngSha256 = [WinAuditCore]::Sha256OfFile($path)
                $rec.pngBytes = (Get-Item -LiteralPath $path).Length
                $rec.imageStats = ([WinAuditCore]::ImageStats($path) | ConvertFrom-Json)
                if ($wantUia) {
                    $rec.uia = ([WinAuditCore]::UiaDump($h, $UiaMaxDepth, $UiaMaxNodes) | ConvertFrom-Json)
                }
                Add-AuditTrace 'capture' "$path ok"
            } else {
                Add-AuditWarning "capture of '$path' returned '$res'"
                Add-AuditTrace 'capture' "$path failed: $res"
            }
            [void]$auditCaptures.Add($rec)
            [void]$auditStepResults.Add([pscustomobject]@{ type = 'capture'; ok = ($res -eq 'ok'); path = $path; status = $res })
            return ($res -eq 'ok')
        }
        default {
            Add-AuditWarning "unknown step type '$type' was ignored"
            [void]$auditStepResults.Add([pscustomobject]@{ type = $type; ok = $false; error = 'unknown-step-type' })
            return $false
        }
    }
}

# ------------------------------------------------------------------ pre-flight
$exeSha = $null
$exeVersion = $null
$exeExists = $false

if ($CleanDir) {
    if (Test-Path -LiteralPath $CleanDir) {
        Get-ChildItem -LiteralPath $CleanDir -Force | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
        Add-AuditTrace 'clean' "emptied $CleanDir"
    } elseif ($CreateCleanDir) {
        New-Item -ItemType Directory -Path $CleanDir -Force | Out-Null
        Add-AuditTrace 'clean' "created $CleanDir"
    }
}

if ($Exe) {
    $exeExists = Test-Path -LiteralPath $Exe
    if ($exeExists) {
        $exeSha = [WinAuditCore]::Sha256OfFile($Exe)
        try {
            $exeVersion = (Get-Item -LiteralPath $Exe).VersionInfo.FileVersion
        } catch {
            $exeVersion = $null
        }
    } else {
        Add-AuditWarning "executable not found: $Exe"
    }
}

$stepsList = New-Object System.Collections.Generic.List[object]

if ($StepsFile) {
    if (-not (Test-Path -LiteralPath $StepsFile)) {
        Add-AuditWarning "steps file not found: $StepsFile"
    } else {
        $parsed = (Get-Content -LiteralPath $StepsFile -Raw -Encoding UTF8) | ConvertFrom-Json
        foreach ($s in @($parsed)) { [void]$stepsList.Add($s) }
    }
}
foreach ($s in @($StepList)) {
    if ($s) {
        $parsed = $s | ConvertFrom-Json
        [void]$stepsList.Add($parsed)
    }
}

if ($stepsList.Count -eq 0 -and $OutPath -and -not $SkipCapture) {
    [void]$stepsList.Add([pscustomobject]@{ Type = 'capture'; Path = $OutPath })
}

# ----------------------------------------------------------------------- run
$result = [ordered]@{
    schema      = 'whaleslauncher.audit.capture/1'
    generatedAt = (Get-Date).ToString('o')
    invocation  = [pscustomobject]@{
        action          = $Action
        exe             = $Exe
        exeExists       = $exeExists
        exeSha256       = $exeSha
        exeFileVersion  = $exeVersion
        workDir         = $WorkDir
        exeArgs         = $ExeArgs
        waitMs          = $WaitMs
        windowTitleLike = $WindowTitleLike
        stepsCount      = $stepsList.Count
    }
    process     = [pscustomobject]@{
        pid            = $null
        launchedByTool = $false
        aliveAtEnd     = $null
        killedAtEnd    = $false
    }
    window      = $null
    captures    = @()
    steps       = @()
    warnings    = @()
    trace       = @()
    ok          = $false
    error       = $null
}

$targetPid = 0

try {
    if ($Action -eq 'stop') {
        if ($ExistingPid -le 0) {
            $result.error = 'stop requires -ExistingPid'
        } else {
            $targetPid = $ExistingPid
            $killResult = [WinAuditCore]::Kill($targetPid)
            $result.process.pid = $targetPid
            $result.process.killedAtEnd = $true
            Add-AuditTrace 'stop' "$targetPid -> $killResult"
            $result.ok = $true
        }
    } else {
        if ($ExistingPid -gt 0) {
            $targetPid = $ExistingPid
            if (-not [WinAuditCore]::Alive($targetPid)) {
                $result.error = "existing pid $targetPid is not running"
            } else {
                Add-AuditTrace 'attach' "pid $targetPid"
            }
        } elseif ($Exe -and $exeExists) {
            $proc = [WinAuditCore]::Launch($Exe, $WorkDir, $ExeArgs)
            $targetPid = $proc.Id
            $launchedHere = $true
            $result.process.launchedByTool = $true
            Add-AuditTrace 'launch' "pid $targetPid"
            if ($WaitMs -gt 0) { Start-Sleep -Milliseconds $WaitMs }
        } else {
            $result.error = 'nothing to do: provide -Exe or -ExistingPid (or -Action stop)'
        }

        if (-not $result.error) {
            $w = Wait-ForWindow -TargetPid $targetPid -TimeoutMs ([Math]::Max(15000, $WaitMs + 12000))
            if ($w.Hwnd -eq [IntPtr]::Zero) {
                $result.error = $w.Reason
                Add-AuditWarning ('window discovery failed: ' + $w.Reason)
            } else {
                $h = $w.Hwnd
                [void][WinAuditCore]::SetForeground($h)
                Start-Sleep -Milliseconds 900
                $rect = [WinAuditCore]::RectOf($h)
                $dpi = [WinAuditCore]::ScreenDpi()
                $result.window = [pscustomobject]@{
                    hwnd             = $h.ToInt64()
                    title            = [WinAuditCore]::TextOf($h)
                    className        = [WinAuditCore]::ClassOf($h)
                    left             = $rect[0]
                    top              = $rect[1]
                    width            = $rect[2]
                    height           = $rect[3]
                    screenDpi        = $dpi
                    devicePixelRatio = [Math]::Round($dpi / 96.0, 3)
                }
                Add-AuditTrace 'window' ('class=' + $result.window.className + ' ' + $rect[2] + 'x' + $rect[3])

                foreach ($step in $stepsList) {
                    [void](Invoke-CaptureStep -Step $step -TargetPid $targetPid)
                }
                $result.ok = $true
            }
        }
    }
} catch {
    $result.error = $_.Exception.Message
    Add-AuditWarning ('unhandled: ' + $_.Exception.Message)
} finally {
    if ($targetPid -gt 0) {
        $result.process.pid = $targetPid
        $result.process.aliveAtEnd = [WinAuditCore]::Alive($targetPid)
        if ($launchedHere -and -not $KeepAlive) {
            $k = [WinAuditCore]::Kill($targetPid)
            $result.process.killedAtEnd = $true
            Add-AuditTrace 'kill' "$targetPid -> $k"
            $result.process.aliveAtEnd = $false
        }
    }
    $result.captures = @($auditCaptures.ToArray())
    $result.steps = @($auditStepResults.ToArray())
    $result.warnings = @($auditWarnings.ToArray())
    $result.trace = @($auditTrace.ToArray())
}

$resultJson = $result | ConvertTo-Json -Depth 12

if ($EmitJson) {
    Write-Output $resultJson
} else {
    Write-Host $resultJson
}

if ($result.error) { exit 2 }
if (-not $result.ok) { exit 3 }
exit 0

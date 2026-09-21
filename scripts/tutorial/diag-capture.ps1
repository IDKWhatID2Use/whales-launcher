# ---------------------------------------------------------------------------
# Standalone probe for the screen-capture path (ASCII only).
# Runs ONLY the pieces that a hang could live in, printing a timestamp before
# and after each call so a stall is localised immediately.
# ---------------------------------------------------------------------------
param(
    [string]$PlanFile = 'F:\WhalesLauncher\scripts\tutorial\plan-probe.json',
    [string]$OutDir = 'F:\WhalesLauncher\.probe\tutorial-work\diag'
)

$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'scripts\audit\capture-core.ps1')
Initialize-WinAuditCore | Out-Null

function Say {
    param([string]$Text)
    Write-Host ("[{0:HH:mm:ss.fff}] {1}" -f (Get-Date), $Text)
}

# Load the helper type from tour.ps1 by extracting its here-string (keeps one
# definition of the C# code).
$tour = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'tour.ps1'))
$start = $tour.IndexOf('$tutHelperSource = @''')
$end = $tour.IndexOf("'@", $start)
$source = $tour.Substring($start + '$tutHelperSource = @'''.Length, $end - $start - '$tutHelperSource = @'''.Length)
Add-Type -TypeDefinition $source -ReferencedAssemblies 'System.Drawing', 'UIAutomationClient', 'UIAutomationTypes', 'WindowsBase', 'System.Core'

if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

$plan = (Get-Content -LiteralPath $PlanFile -Raw -Encoding UTF8) | ConvertFrom-Json
$env:WHALES_SMOKE_ROUTE = 'instances'
$env:WHALES_LAUNCHER_ROOT = [string]$plan.home

Say 'launch'
$proc = [WinAuditCore]::Launch([string]$plan.exe, '', '')
$appPid = $proc.Id
Start-Sleep -Milliseconds 8000

Say 'find window'
$hwnd = [WinAuditCore]::FindWindow($appPid, 'WhalesLauncher')
Say "hwnd=$($hwnd.ToInt64())"
[void][WinAuditCore]::SetForeground($hwnd)
Start-Sleep -Milliseconds 800

Say 'PrintWindow capture'
$a = Join-Path $OutDir 'pw-1.png'
Say ("  -> " + [WinAuditCore]::CaptureToPng($hwnd, $a))

Say 'capture union #1'
$b = Join-Path $OutDir 'union-1.png'
Say ("  -> " + [WinTutHelper]::CaptureUnion($appPid, $hwnd, $b))

Say 'capture union #2'
$c = Join-Path $OutDir 'union-2.png'
Say ("  -> " + [WinTutHelper]::CaptureUnion($appPid, $hwnd, $c))

Say 'PrintWindow capture #2'
$d = Join-Path $OutDir 'pw-2.png'
Say ("  -> " + [WinAuditCore]::CaptureToPng($hwnd, $d))

Say 'raw rect / visible rect'
Say ("  raw=" + ([WinAuditCore]::RectOf($hwnd) -join ','))
Say ("  vis=" + ([WinTutHelper]::VisibleRect($hwnd) -join ','))

Say 'uia dump main'
Say ("  nodes=" + (([WinAuditCore]::UiaDump($hwnd, 14, 900) | ConvertFrom-Json).nodeCount))

Say 'kill'
[void][WinAuditCore]::Kill($appPid)
Say 'done'

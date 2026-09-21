# ---------------------------------------------------------------------------
# Standalone probe for the "menu flyout open + screen capture" path (ASCII only).
# Every call prints a timestamp before and after, so a stall is localised.
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

$tour = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'tour.ps1'))
$start = $tour.IndexOf('$tutHelperSource = @''')
$end = $tour.IndexOf("'@", $start)
$source = $tour.Substring($start + '$tutHelperSource = @'''.Length, $end - $start - '$tutHelperSource = @'''.Length)
Add-Type -TypeDefinition $source -ReferencedAssemblies 'System.Drawing', 'UIAutomationClient', 'UIAutomationTypes', 'WindowsBase', 'System.Core'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

$plan = (Get-Content -LiteralPath $PlanFile -Raw -Encoding UTF8) | ConvertFrom-Json
$env:WHALES_SMOKE_ROUTE = 'instances'
$env:WHALES_LAUNCHER_ROOT = [string]$plan.home

Say 'launch'
$proc = [WinAuditCore]::Launch([string]$plan.exe, '', '')
$appPid = $proc.Id
Start-Sleep -Milliseconds 8000

$hwnd = [WinAuditCore]::FindWindow($appPid, 'WhalesLauncher')
Say "hwnd=$($hwnd.ToInt64())"
[void][WinAuditCore]::SetForeground($hwnd)
Start-Sleep -Milliseconds 800

Say 'uia: find MenuItem 文件'
$root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
$cond = New-Object System.Windows.Automation.AndCondition(
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::MenuItem)),
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, '文件'))
)
$found = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
Say "  matches=$($found.Count)"

Say 'uia: expand'
$pattern = $found[0].GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
$pattern.Expand()
Say '  expanded'

Start-Sleep -Milliseconds 1200

Say 'windows after expand'
Say ('  ' + [WinTutHelper]::ListWindows($appPid))

Say 'SetForeground (menu open)'
Say ('  -> ' + [WinAuditCore]::SetForeground($hwnd))

$b = Join-Path $OutDir 'menu-union-1.png'
Say 'CaptureUnion #1 (menu open)'
Say ('  -> ' + [WinTutHelper]::CaptureUnion($appPid, $hwnd, $b))

Start-Sleep -Milliseconds 700

Say 'SetForeground #2'
Say ('  -> ' + [WinAuditCore]::SetForeground($hwnd))

$c = Join-Path $OutDir 'menu-union-2.png'
Say 'CaptureUnion #2 (menu open)'
Say ('  -> ' + [WinTutHelper]::CaptureUnion($appPid, $hwnd, $c))

$d = Join-Path $OutDir 'menu-pw.png'
Say 'PrintWindow (menu open)'
Say ('  -> ' + [WinAuditCore]::CaptureToPng($hwnd, $d))

Say 'ImageDiff(union1, union2)'
Say ('  -> ' + [WinAuditCore]::ImageDiff($b, $c, 24))

Say 'ImageStats(union1)'
Say ('  -> ' + [WinAuditCore]::ImageStats($b))

Say 'kill'
[void][WinAuditCore]::Kill($appPid)
Say 'done'

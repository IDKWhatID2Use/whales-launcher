# ---------------------------------------------------------------------------
# UiDriver.psm1 - UI Automation driver for the WhalesLauncher WinUI 3 shell.
#
# WHY THIS EXISTS
#   The renderer layer (WinUI 3) had zero automated tests. Everything below is
#   built on the in-box UI Automation client (UIAutomationClient /
#   UIAutomationTypes) plus the already-production-proven capture helpers in
#   scripts/audit/capture-core.ps1. No FlaUI / Appium / WinAppDriver / Playwright
#   dependency is introduced: the UIA path is already used by the existing audit
#   tooling ([WinAuditCore]::UiaDump), it gives pixel-level evidence for free via
#   PrintWindow + ImageStats, and the maintainers only have to know one toolkit.
#
# PURE ASCII ON PURPOSE
#   Windows PowerShell 5.1 reads .ps1 files as ANSI. A single non-ASCII byte
#   (even inside a comment) gets mis-decoded and can turn into a syntax error.
#   ALL user-visible Chinese strings therefore live in the UTF-8 JSON context
#   file produced by scripts/test/run-ui-tests.mjs and are read into $Context.
#   Never paste a Chinese literal into this file.
#
# LOADING
#   Import-Module <repo>\scripts\test\UiDriver.psm1
#   The module dot-sources scripts/audit/capture-core.ps1 once, so
#   [WinAuditCore] (window discovery, PrintWindow capture, synthetic input,
#   image statistics) is available to every caller.
# ---------------------------------------------------------------------------

Set-StrictMode -Version 2.0

$script:CaptureCorePath = Join-Path (Split-Path -Parent $PSScriptRoot) 'audit\capture-core.ps1'
if (-not (Test-Path -LiteralPath $script:CaptureCorePath)) {
    throw "UiDriver: capture-core.ps1 not found at $script:CaptureCorePath"
}

. $script:CaptureCorePath
Initialize-WinAuditCore

$script:DefaultExe = 'F:\WhalesLauncher\desktop\src\WhalesLauncher.App\bin\Debug\net10.0-windows10.0.26100.0\win-x64\WhalesLauncher.exe'
$script:DefaultWindowTitleLike = 'WhalesLauncher'

# Module state. Declared explicitly because the module runs under StrictMode 2.0,
# where touching an undefined variable is a terminating error.
$script:LastPid = 0
$script:LastHwnd = [IntPtr]::Zero

# ---------------------------------------------------------------------------
# Native helper: launch with stdout/stderr redirected to FILES.
#
# Why not [WinAuditCore]::Launch: that helper does not redirect, so the child
# inherits the test runner's stdout pipe. The spawned WinUI process (and its
# bridge) then keep that pipe open, and the Node runner's stdout callback never
# completes even after the app is gone - the runner hangs with no output. That
# exact hang was observed while spiking this driver. Redirecting to files (which
# are drained asynchronously, so the child can never block on a full pipe) keeps
# the runner's stdio clean and gives us the app's own output as evidence.
# ---------------------------------------------------------------------------
$script:NativeSource = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;

public class UiDriverNative
{
    private static readonly Dictionary<int, StringBuilder> OutBuf = new Dictionary<int, StringBuilder>();
    private static readonly Dictionary<int, StringBuilder> ErrBuf = new Dictionary<int, StringBuilder>();

    public static Process LaunchRedirected(string exe, string workDir, string exeArgs)
    {
        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = exe;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = false;
        if (workDir != null && workDir.Length > 0) { psi.WorkingDirectory = workDir; }
        if (exeArgs != null && exeArgs.Length > 0) { psi.Arguments = exeArgs; }
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        Process p = Process.Start(psi);
        lock (OutBuf) { OutBuf[p.Id] = new StringBuilder(); ErrBuf[p.Id] = new StringBuilder(); }
        p.OutputDataReceived += new DataReceivedEventHandler(OnOut);
        p.ErrorDataReceived += new DataReceivedEventHandler(OnErr);
        p.BeginOutputReadLine();
        p.BeginErrorReadLine();
        return p;
    }

    private static void OnOut(object sender, DataReceivedEventArgs e)
    {
        if (e.Data == null) { return; }
        Process p = (Process)sender;
        lock (OutBuf) { StringBuilder sb; if (OutBuf.TryGetValue(p.Id, out sb)) { sb.AppendLine(e.Data); } }
    }

    private static void OnErr(object sender, DataReceivedEventArgs e)
    {
        if (e.Data == null) { return; }
        Process p = (Process)sender;
        lock (ErrBuf) { StringBuilder sb; if (ErrBuf.TryGetValue(p.Id, out sb)) { sb.AppendLine(e.Data); } }
    }

    /// <summary>Write whatever the app produced so far to two files and return their paths.</summary>
    public static string Drain(int pid, string outFile, string errFile)
    {
        string o = "";
        string r = "";
        lock (OutBuf)
        {
            StringBuilder sb;
            if (OutBuf.TryGetValue(pid, out sb)) { o = sb.ToString(); }
            if (ErrBuf.TryGetValue(pid, out sb)) { r = sb.ToString(); }
        }
        try { File.WriteAllText(outFile, o, new UTF8Encoding(false)); } catch (Exception) { }
        try { File.WriteAllText(errFile, r, new UTF8Encoding(false)); } catch (Exception) { }
        return outFile + "|" + errFile;
    }
}
'@

if (-not ('UiDriverNative' -as [type])) {
    Add-Type -TypeDefinition $script:NativeSource -ErrorAction Stop
}

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

# ARRAY CONTRACT (read this before touching any helper below)
#   Every function that can return more than one element returns a PLAIN
#   enumerable: `return $list.ToArray()` / `return $found`. Call sites wrap the
#   call in @(...), which is the only combination whose behaviour does not
#   depend on the element count:
#       $items = @(Get-UiDescendants -Scope $root)   # 0/1/N all behave the same
#   The tempting `return , $list.ToArray()` idiom was tried first and produced
#   an array nested one level too deep as soon as the caller also used @(...)
#   (Count reported 1 with a System.String[] inside). Do not reintroduce it.

function Resolve-UiRaw {
    <# Accept either a raw AutomationElement or one of this module's wrapper
       objects ($info returned by Find-*), so -Scope can be used with both
       without the caller having to know which one it holds. #>
    [CmdletBinding()]
    param($Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [System.Windows.Automation.AutomationElement]) { return $Value }
    if ($Value.PSObject.Properties.Match('Element').Count -gt 0) { return $Value.Element }
    return $Value
}

function Get-UiDescendants {
    <# All descendants of a scope as a flat array (never a single unwrapped
       element - PowerShell unrolls single-item collections, which silently
       turned an AutomationElementCollection into one element and broke
       .Item() calls during the spike).

       TWO strategies, on purpose:
         1. The provider-side FindAll(Descendants) is used when it yields
            anything. From the window root it is both cheap and *more complete*
            than a control-view walk: it also reaches the content of flyouts and
            menus, which live in a Microsoft.UI.Content.PopupWindowSiteBridge
            child rather than in the normal visual subtree.
         2. Inside an inner element WinUI's provider returns NOTHING for
            FindAll - verified by direct experiment (MenuItemsHost reported 0
            descendants while its ListItems were clearly present in a
            control-view walk). So sub-scopes fall back to an explicit
            TreeWalker.ControlViewWalker breadth-first walk, the same traversal
            the existing audit tooling uses.
       #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Scope,
        [int]$Max = 4000,
        # 'Control' (default) is the UIA control view. 'Raw' additionally reaches
        # two things this app genuinely needs:
        #   * controls marked AutomationProperties.AccessibilityView="Raw"
        #     (e.g. the YAML editor's line-number column 'Gutter'), and
        #   * children of a control that has no automation peer of its own -
        #     the instance-detail SelectorBar ('TabBar') is exactly that case:
        #     its SelectorBarItems exist ONLY in the raw view.
        [ValidateSet('Control', 'Raw')][string]$View = 'Control'
    )
    $raw = Resolve-UiRaw -Value $Scope
    $list = New-Object System.Collections.Generic.List[object]

    if ($View -eq 'Control') {
        $found = $raw.FindAll(
            [System.Windows.Automation.TreeScope]::Descendants,
            [System.Windows.Automation.Condition]::TrueCondition)
        if ($found.Count -gt 0) {
            for ($i = 0; $i -lt $found.Count -and $i -lt $Max; $i++) {
                $list.Add($found.Item($i))
            }
            return $list.ToArray()
        }
        # Inside an inner element WinUI's provider returns NOTHING for FindAll -
        # verified by direct experiment (MenuItemsHost reported 0 descendants
        # while its ListItems were clearly present). Fall through to a walk.
        $walk = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    } else {
        $walk = [System.Windows.Automation.TreeWalker]::RawViewWalker
    }

    $queue = New-Object System.Collections.Generic.Queue[object]
    $queue.Enqueue($raw)
    while ($queue.Count -gt 0 -and $list.Count -lt $Max) {
        $current = $queue.Dequeue()
        $child = $walk.GetFirstChild($current)
        $guard = 0
        while ($null -ne $child -and $guard -lt 500) {
            $guard++
            $list.Add($child)
            $queue.Enqueue($child)
            if ($list.Count -ge $Max) { break }
            $child = $walk.GetNextSibling($child)
        }
    }
    return $list.ToArray()
}

function Get-UiInfo {
    <# Snapshot one element into a plain object. Individual UIA property reads
       can throw when an element goes stale mid-walk, so every read is guarded. #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Element)
    $name = ''
    $aid = ''
    $ct = ''
    $cls = ''
    $enabled = $false
    $offscreen = $true
    $x = -1; $y = -1; $w = -1; $h = -1
    try {
        $c = $Element.Current
        $name = [string]$c.Name
        $aid = [string]$c.AutomationId
        if ($null -ne $c.ControlType) { $ct = [string]$c.ControlType.ProgrammaticName }
        $cls = [string]$c.ClassName
        $enabled = [bool]$c.IsEnabled
        $offscreen = [bool]$c.IsOffscreen
        $r = $c.BoundingRectangle
        # Offscreen elements report an empty rect, which surfaces as NaN/Infinity.
        if (-not ([double]::IsNaN($r.X) -or [double]::IsInfinity($r.X))) { $x = [math]::Round($r.X) }
        if (-not ([double]::IsNaN($r.Y) -or [double]::IsInfinity($r.Y))) { $y = [math]::Round($r.Y) }
        if (-not ([double]::IsNaN($r.Width) -or [double]::IsInfinity($r.Width))) { $w = [math]::Round($r.Width) }
        if (-not ([double]::IsNaN($r.Height) -or [double]::IsInfinity($r.Height))) { $h = [math]::Round($r.Height) }
    } catch {
        $name = '<stale>'
    }
    return [pscustomobject]@{
        Name         = $name
        AutomationId = $aid
        ControlType  = $ct
        ClassName    = $cls
        IsEnabled    = $enabled
        IsOffscreen  = $offscreen
        X            = $x
        Y            = $y
        Width        = $w
        Height       = $h
        Element      = $Element
    }
}

function Format-UiInventory {
    <# THE diagnostic that matters. When a UIA lookup fails, the expensive part
       is guessing what the control is actually called. Every failure below
       therefore prints the Name / AutomationId / ControlType of what *is*
       present in the searched scope. #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Scope,
        [int]$Max = 80
    )
    $lines = New-Object System.Collections.Generic.List[string]
    $items = Get-UiDescendants -Scope $Scope
    $shown = 0
    foreach ($el in $items) {
        if ($shown -ge $Max) {
            $lines.Add("      ... ($($items.Count) descendants total, list truncated at $Max)")
            break
        }
        $info = Get-UiInfo -Element $el
        if (-not $info.Name -and -not $info.AutomationId) { continue }
        $shown++
        $lines.Add(("      {0,-24} aid='{1}' name='{2}' enabled={3} offscreen={4}" -f `
            $info.ControlType, $info.AutomationId, $info.Name, $info.IsEnabled, $info.IsOffscreen))
    }
    if ($shown -eq 0) { $lines.Add('      <scope has no addressable descendants>') }
    return $lines.ToArray()
}

function New-UiLookupError {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$What,
        [Parameter(Mandatory = $true)][int]$TimeoutMs,
        [Parameter(Mandatory = $true)]$Scope
    )
    $inventory = Format-UiInventory -Scope $Scope
    $text = New-Object System.Collections.Generic.List[string]
    $text.Add("UI element not found: $What (polled for ${TimeoutMs}ms)")
    $text.Add('  Siblings / descendants actually present in the searched scope:')
    foreach ($line in $inventory) { $text.Add($line) }
    return ($text -join [Environment]::NewLine)
}

function Get-UiScope {
    <# Resolve the effective search scope: explicit -Scope wins, else the window
       root for -Hwnd, else the cached root from Start-WhalesApp. #>
    [CmdletBinding()]
    param($Scope, $Hwnd)
    if ($null -ne $Scope) { return (Resolve-UiRaw -Value $Scope) }
    if ($null -ne $Hwnd -and [IntPtr]$Hwnd -ne [IntPtr]::Zero) { return (Get-UiRoot -Hwnd $Hwnd) }
    if ($script:LastHwnd -ne [IntPtr]::Zero) { return (Get-UiRoot -Hwnd $script:LastHwnd) }
    throw 'UiDriver: no scope available. Pass -Scope/-Hwnd or call Start-WhalesApp first.'
}

function Test-UiMatch {
    <# NOTE: -Value must tolerate the empty string. Most UIA elements carry no
       AutomationId (only x:Named controls do), so an empty value is the common
       case, and a Mandatory [string] parameter rejects '' with a
       ParameterBindingValidationException in PowerShell 5.1 - which surfaced as
       a confusing "cannot bind argument" crash instead of a lookup miss. #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Pattern,
        [switch]$Exact
    )
    if ($Exact) { return ($Value -ceq $Pattern) }
    if ([string]::IsNullOrEmpty($Pattern)) { return $true }
    return ($Value.IndexOf($Pattern, [StringComparison]::OrdinalIgnoreCase) -ge 0)
}

function Invoke-UiFind {
    <# Shared, polling lookup. Returns the first match, or all matches with
       -All, or $null when -AllowMissing is set. Never does a one-shot read:
       WinUI renders asynchronously, so a lookup that happens "too early" is a
       normal race, not a failure. #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Kind,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value,
        $Scope,
        $Hwnd,
        [int]$TimeoutMs = 5000,
        [int]$IntervalMs = 200,
        [switch]$Exact,
        [switch]$All,
        [switch]$AllowMissing,
        [string]$ControlType,
        [string]$ClassNameLike = '',
        [ValidateSet('Control', 'Raw')][string]$View = 'Control'
    )
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
    $scopeEl = Get-UiScope -Scope $Scope -Hwnd $Hwnd
    $describe = "$Kind='$Value'" + $(if ($ControlType) { " controlType=$ControlType" } else { '' }) + $(if ($ClassNameLike) { " className~$ClassNameLike" } else { '' }) + " view=$View"

    while ($true) {
        $matches = New-Object System.Collections.Generic.List[object]
        $candidates = Get-UiDescendants -Scope $scopeEl -View $View
        foreach ($el in $candidates) {
            $info = Get-UiInfo -Element $el
            if ($ControlType -and $info.ControlType -notlike "*$ControlType*") { continue }
            if ($ClassNameLike -and $info.ClassName -notlike "*$ClassNameLike*") { continue }

            # NOTE: the match result is assigned inside the switch and tested
            # OUTSIDE it. `continue` inside a PowerShell switch applies to the
            # switch, not to the enclosing foreach - so an early
            # `if (-not match) { continue }` in a switch branch silently does
            # nothing and every element "matches". That bug made every lookup
            # return the first element of the tree.
            $hit = $false
            switch ($Kind) {
                'AutomationId' { $hit = Test-UiMatch -Value $info.AutomationId -Pattern $Value -Exact:$Exact }
                'Name' { $hit = Test-UiMatch -Value $info.Name -Pattern $Value -Exact:$Exact }
                'ControlType' {
                    # Control-type names are enum-like, so they are compared
                    # exactly (with an optional 'ControlType.' prefix):
                    # a substring test would make 'List' also match 'ListItem'.
                    $want = $Value
                    if ($want -notlike 'ControlType.*') { $want = "ControlType.$want" }
                    $hit = ($info.ControlType -ieq $want)
                }
                default { throw "UiDriver: unknown lookup kind '$Kind'" }
            }
            if (-not $hit) { continue }

            $matches.Add($info)
            if (-not $All) { break }
        }

        if ($matches.Count -gt 0) {
            if ($All) { return $matches.ToArray() }
            return $matches[0]
        }

        if ([DateTime]::UtcNow -ge $deadline) { break }
        Start-Sleep -Milliseconds $IntervalMs
        $scopeEl = Get-UiScope -Scope $Scope -Hwnd $Hwnd
    }

    if ($AllowMissing) { return $null }
    throw (New-UiLookupError -What $describe -TimeoutMs $TimeoutMs -Scope $scopeEl)
}

function Get-UiPattern {
    <# Fetch a UIA pattern, failing with the element identity plus the patterns
       that ARE available - "no InvokePattern on this button" is otherwise a
       long guessing game. #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Element,
        [Parameter(Mandatory = $true)]$Pattern,
        [Parameter(Mandatory = $true)][string]$PatternName
    )
    $Element = Resolve-UiRaw -Value $Element
    $obj = $null
    if ($Element.TryGetCurrentPattern($Pattern, [ref]$obj)) { return $obj }

    $info = Get-UiInfo -Element $Element
    $available = New-Object System.Collections.Generic.List[string]
    foreach ($p in @(
        [System.Windows.Automation.InvokePattern]::Pattern,
        [System.Windows.Automation.TogglePattern]::Pattern,
        [System.Windows.Automation.SelectionItemPattern]::Pattern,
        [System.Windows.Automation.ValuePattern]::Pattern,
        [System.Windows.Automation.ExpandCollapsePattern]::Pattern,
        [System.Windows.Automation.ScrollPattern]::Pattern,
        [System.Windows.Automation.SelectionPattern]::Pattern,
        [System.Windows.Automation.RangeValuePattern]::Pattern,
        [System.Windows.Automation.TextPattern]::Pattern
    )) {
        $tmp = $null
        if ($Element.TryGetCurrentPattern($p, [ref]$tmp)) { $available.Add($p.ProgrammaticName) }
    }
    throw ("UiDriver: element does not support $PatternName. " +
        "ct=$($info.ControlType) aid='$($info.AutomationId)' name='$($info.Name)' cls='$($info.ClassName)'. " +
        "Available patterns: " + $(if ($available.Count -eq 0) { '<none>' } else { $available -join ', ' }))
}

# ---------------------------------------------------------------------------
# Application lifecycle
# ---------------------------------------------------------------------------

function Start-WhalesApp {
    <#
    .SYNOPSIS
        Launch WhalesLauncher.exe against an isolated data root and wait for its window.
    .DESCRIPTION
        Sets WHALES_LAUNCHER_ROOT (the data root shared with the Node core) and
        WHALES_SMOKE_ROUTE (deep-link navigation) in the *current process*
        environment, then starts the exe with stdio redirected to files under
        -LogDir. The window is located by polling FindWindow, then the UIA root
        is confirmed reachable and an extra settle delay is applied.

        Never point -Root at the real repository root: the caller owns isolation
        (see scripts/test/lib/fixtures.mjs#assertHomeIsolated).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [string]$Route = '',
        [string]$Exe = '',
        [string]$LogDir = '',
        [int]$WindowTimeoutMs = 45000,
        [int]$SettleMs = 2500,
        [string]$WindowTitleLike = $script:DefaultWindowTitleLike
    )

    if (-not $Exe) { $Exe = $script:DefaultExe }
    if (-not (Test-Path -LiteralPath $Exe)) {
        throw "WhalesLauncher.exe not found at $Exe. Build it first: pwsh -File desktop\build-app.ps1"
    }
    if (-not (Test-Path -LiteralPath $Root)) {
        throw "Data root does not exist: $Root"
    }
    if (-not $LogDir) { $LogDir = Join-Path $Root '_uidriver' }
    if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }

    $env:WHALES_LAUNCHER_ROOT = $Root
    if ($Route) { $env:WHALES_SMOKE_ROUTE = $Route } else { Remove-Item Env:WHALES_SMOKE_ROUTE -ErrorAction SilentlyContinue }
    # A stale WHALES_ROOT from an earlier run would silently re-point the app at
    # another home; only WHALES_LAUNCHER_ROOT (which wins) is ever set here.
    Remove-Item Env:WHALES_ROOT -ErrorAction SilentlyContinue

    $proc = [UiDriverNative]::LaunchRedirected($Exe, (Split-Path -Parent $Exe), '')
    $script:LastPid = $proc.Id
    $script:LastHwnd = [IntPtr]::Zero

    $hwnd = [IntPtr]::Zero
    $deadline = [DateTime]::UtcNow.AddMilliseconds($WindowTimeoutMs)
    while ([DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 300
        if ($proc.HasExited) {
            throw "WhalesLauncher.exe (pid $($proc.Id)) exited with code $($proc.ExitCode) before a window appeared."
        }
        $hwnd = [WinAuditCore]::FindWindow($proc.Id, $WindowTitleLike)
        if ($hwnd -ne [IntPtr]::Zero) { break }
    }
    if ($hwnd -eq [IntPtr]::Zero) {
        [void][WinAuditCore]::Kill($proc.Id)
        throw "No visible window titled like '$WindowTitleLike' for pid $($proc.Id) within ${WindowTimeoutMs}ms."
    }

    # The HWND exists before WinUI has built its UIA tree; wait for the root.
    $rootOk = $false
    $rootDeadline = [DateTime]::UtcNow.AddMilliseconds(20000)
    while ([DateTime]::UtcNow -lt $rootDeadline) {
        try {
            $r = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
            if ($null -ne $r) { $rootOk = $true; break }
        } catch { }
        Start-Sleep -Milliseconds 400
    }
    if (-not $rootOk) {
        [void][WinAuditCore]::Kill($proc.Id)
        throw "Window $hwnd never exposed a UI Automation root."
    }

    Start-Sleep -Milliseconds $SettleMs
    $script:LastHwnd = $hwnd

    return [pscustomobject]@{
        Pid       = $proc.Id
        Hwnd      = $hwnd
        ClassName = [WinAuditCore]::ClassOf($hwnd)
        Title     = [WinAuditCore]::TextOf($hwnd)
        Rect      = [WinAuditCore]::RectOf($hwnd)
        Root      = $Root
        Route     = $Route
        LogDir    = $LogDir
    }
}

function Stop-WhalesApp {
    <#
    .SYNOPSIS
        Kill a WhalesLauncher process tree started by Start-WhalesApp.
    .DESCRIPTION
        The app spawns the Node bridge as a child; killing only the app would
        leave an orphan bridge holding the temp home. Children are enumerated
        via CIM first, then the app itself is killed, and the drained
        stdout/stderr is written next to the run's log directory.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][int]$Pid,
        [string]$LogDir = ''
    )
    $children = @()
    try {
        $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$Pid" -ErrorAction SilentlyContinue)
    } catch { }
    foreach ($child in $children) {
        try { Stop-Process -Id $child.ProcessId -Force -ErrorAction SilentlyContinue } catch { }
    }
    $result = 'not-running'
    try { $result = [WinAuditCore]::Kill($Pid) } catch { $result = 'kill-error' }

    if ($LogDir -and (Test-Path -LiteralPath $LogDir)) {
        try {
            [void][UiDriverNative]::Drain($Pid,
                (Join-Path $LogDir "app-$Pid.stdout.txt"),
                (Join-Path $LogDir "app-$Pid.stderr.txt"))
        } catch { }
    }
    if ($script:LastPid -eq $Pid) { $script:LastHwnd = [IntPtr]::Zero }
    return $result
}

function Get-WhalesWindow {
    <# Re-discover the window handle for a pid (the handle is stable, but a
       restart inside a case script changes the pid). #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][int]$Pid,
        [string]$WindowTitleLike = $script:DefaultWindowTitleLike,
        [int]$TimeoutMs = 30000
    )
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
    while ([DateTime]::UtcNow -lt $deadline) {
        $hwnd = [WinAuditCore]::FindWindow($Pid, $WindowTitleLike)
        if ($hwnd -ne [IntPtr]::Zero) { $script:LastHwnd = $hwnd; return $hwnd }
        Start-Sleep -Milliseconds 300
    }
    throw "Get-WhalesWindow: no window for pid $Pid within ${TimeoutMs}ms."
}

function Get-UiRoot {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Hwnd)
    $el = $null
    for ($i = 0; $i -lt 5; $i++) {
        try { $el = [System.Windows.Automation.AutomationElement]::FromHandle($Hwnd) } catch { $el = $null }
        if ($null -ne $el) { return $el }
        Start-Sleep -Milliseconds 500
    }
    throw "Get-UiRoot: UI Automation root unavailable for hwnd $Hwnd."
}

# ---------------------------------------------------------------------------
# Element lookup
# ---------------------------------------------------------------------------

function Find-ByAutomationId {
    <# Find by AutomationId. In WinUI 3 the XAML x:Name is surfaced as the
       AutomationId, so <Button x:Name="ThemeButton"/> is found as 'ThemeButton'.
       Pass -View Raw for controls hidden from the control view (see
       Get-UiDescendants). #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Id,
        $Scope,
        $Hwnd,
        [int]$TimeoutMs = 5000,
        [switch]$Exact,
        [switch]$All,
        [switch]$AllowMissing,
        [ValidateSet('Control', 'Raw')][string]$View = 'Control'
    )
    return Invoke-UiFind -Kind 'AutomationId' -Value $Id -Scope $Scope -Hwnd $Hwnd `
        -TimeoutMs $TimeoutMs -Exact:$Exact -All:$All -AllowMissing:$AllowMissing -View $View
}

function Find-ByName {
    <# Find by UIA Name. Default matching is a case-insensitive SUBSTRING test
       (UIA names carry suffixes such as '切换深浅色主题（深色）'); pass -Exact for
       an ordinal comparison. #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Name,
        $Scope,
        $Hwnd,
        [int]$TimeoutMs = 5000,
        [switch]$Exact,
        [switch]$All,
        [switch]$AllowMissing,
        [ValidateSet('Control', 'Raw')][string]$View = 'Control'
    )
    return Invoke-UiFind -Kind 'Name' -Value $Name -Scope $Scope -Hwnd $Hwnd `
        -TimeoutMs $TimeoutMs -Exact:$Exact -All:$All -AllowMissing:$AllowMissing -View $View
}

function Find-ByControlType {
    <# Find by control type ('Button', 'ListItem', 'Menu', 'Edit', ...). Combine
       with -NameLike / -ClassNameLike to narrow without paying for a second
       traversal. #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$ControlType,
        [string]$NameLike = '',
        [string]$ClassNameLike = '',
        $Scope,
        $Hwnd,
        [int]$TimeoutMs = 5000,
        [switch]$Exact,
        [switch]$All,
        [switch]$AllowMissing,
        [ValidateSet('Control', 'Raw')][string]$View = 'Control'
    )
    # @() normalises the 0/1/N cases: a single match arrives as a scalar, and
    # .Count / [0] on a scalar would throw.
    $found = @(Invoke-UiFind -Kind 'ControlType' -Value $ControlType -Scope $Scope -Hwnd $Hwnd `
        -TimeoutMs $TimeoutMs -All -AllowMissing -ClassNameLike $ClassNameLike -View $View)
    if ($NameLike) {
        $filtered = @()
        foreach ($item in $found) {
            if (Test-UiMatch -Value $item.Name -Pattern $NameLike -Exact:$Exact) { $filtered += $item }
        }
        $found = $filtered
    }
    if ($All) {
        if ($found.Count -eq 0 -and -not $AllowMissing) {
            $scopeEl = Get-UiScope -Scope $Scope -Hwnd $Hwnd
            throw (New-UiLookupError -What "ControlType='$ControlType' nameLike='$NameLike'" -TimeoutMs $TimeoutMs -Scope $scopeEl)
        }
        return $found
    }
    if ($found.Count -eq 0) {
        if ($AllowMissing) { return $null }
        $scopeEl = Get-UiScope -Scope $Scope -Hwnd $Hwnd
        throw (New-UiLookupError -What "ControlType='$ControlType' nameLike='$NameLike'" -TimeoutMs $TimeoutMs -Scope $scopeEl)
    }
    return $found[0]
}
# ---------------------------------------------------------------------------
# Interaction
# ---------------------------------------------------------------------------

function Invoke-Element {
    <# InvokePattern.Invoke() - buttons, menu items, hyperlink-like controls. #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Element)
    $Element = Resolve-UiRaw -Value $Element
    $pattern = Get-UiPattern -Element $Element -Pattern ([System.Windows.Automation.InvokePattern]::Pattern) -PatternName 'InvokePattern'
    $pattern.Invoke()
}

function Toggle-Element {
    <# TogglePattern.Toggle(). Returns the state AFTER the toggle. #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Element)
    $Element = Resolve-UiRaw -Value $Element
    $pattern = Get-UiPattern -Element $Element -Pattern ([System.Windows.Automation.TogglePattern]::Pattern) -PatternName 'TogglePattern'
    $pattern.Toggle()
    Start-Sleep -Milliseconds 250
    return $pattern.Current.ToggleState.ToString()
}

function Get-ElementToggleState {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Element)
    try {
        $pattern = Get-UiPattern -Element $Element -Pattern ([System.Windows.Automation.TogglePattern]::Pattern) -PatternName 'TogglePattern'
        return $pattern.Current.ToggleState.ToString()
    } catch {
        return ''
    }
}

function Select-Element {
    <# SelectionItemPattern.Select() - SelectorBar items, list rows, radio items. #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Element)
    $Element = Resolve-UiRaw -Value $Element
    $pattern = Get-UiPattern -Element $Element -Pattern ([System.Windows.Automation.SelectionItemPattern]::Pattern) -PatternName 'SelectionItemPattern'
    $pattern.Select()
    Start-Sleep -Milliseconds 300
}

function Get-ElementSelected {
    <# $true/$false when SelectionItemPattern exists, $null otherwise - callers
       must treat $null as "not verifiable", never as $false. #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Element)
    $Element = Resolve-UiRaw -Value $Element
    $obj = $null
    if (-not $Element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$obj)) { return $null }
    return [bool]$obj.Current.IsSelected
}

function Set-ElementValue {
    <# ValuePattern.SetValue() with readback, so a silently-ignored write is
       reported instead of producing a confusing downstream assertion. #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Element,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value
    )
    $Element = Resolve-UiRaw -Value $Element
    $pattern = Get-UiPattern -Element $Element -Pattern ([System.Windows.Automation.ValuePattern]::Pattern) -PatternName 'ValuePattern'
    $pattern.SetValue($Value)
    Start-Sleep -Milliseconds 200
    return [string]$pattern.Current.Value
}

function Expand-Element {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Element)
    $Element = Resolve-UiRaw -Value $Element
    $pattern = Get-UiPattern -Element $Element -Pattern ([System.Windows.Automation.ExpandCollapsePattern]::Pattern) -PatternName 'ExpandCollapsePattern'
    $pattern.Expand()
    Start-Sleep -Milliseconds 250
}

function Collapse-Element {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Element)
    $Element = Resolve-UiRaw -Value $Element
    $pattern = Get-UiPattern -Element $Element -Pattern ([System.Windows.Automation.ExpandCollapsePattern]::Pattern) -PatternName 'ExpandCollapsePattern'
    $pattern.Collapse()
    Start-Sleep -Milliseconds 250
}

function Send-Keys {
    <# Synthetic keyboard input through the proven [WinAuditCore]::Key helper
       (chord syntax: 'Ctrl+L', 'Escape', 'Tab'). The window is brought to the
       foreground first - synthetic input goes to whatever has focus. #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Chord,
        $Hwnd
    )
    $target = $Hwnd
    if ($null -eq $target -or [IntPtr]$target -eq [IntPtr]::Zero) { $target = $script:LastHwnd }
    if ($null -ne $target -and [IntPtr]$target -ne [IntPtr]::Zero) {
        [void][WinAuditCore]::SetForeground($target)
        Start-Sleep -Milliseconds 200
    }
    $result = [WinAuditCore]::Key($Chord)
    Start-Sleep -Milliseconds 350
    return $result
}

# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------

function Get-ElementName {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Element)
    $Element = Resolve-UiRaw -Value $Element
    return [string]$Element.Current.Name
}

function Get-ElementValue {
    <# ValuePattern value when available, otherwise the UIA Name. Returns '' when
       neither carries text. #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Element)
    $Element = Resolve-UiRaw -Value $Element
    $obj = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$obj)) {
        return [string]$obj.Current.Value
    }
    return [string]$Element.Current.Name
}

function Get-ElementChildren {
    <# Direct children (control view) as structured objects. #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Element)
    $Element = Resolve-UiRaw -Value $Element
    $list = New-Object System.Collections.Generic.List[object]
    $child = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetFirstChild($Element)
    $guard = 0
    while ($null -ne $child -and $guard -lt 500) {
        $list.Add((Get-UiInfo -Element $child))
        $child = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetNextSibling($child)
        $guard++
    }
    return $list.ToArray()
}

function Get-ElementTree {
    <# Structured UIA subtree (objects, never a formatted string) so callers can
       inspect it with normal PowerShell pipelines and ConvertTo-Json.
       Implemented iteratively: a nested function would leak into module scope
       after the first call, which makes repeated invocations unpredictable. #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Element,
        [int]$MaxDepth = 6,
        [int]$MaxNodes = 400
    )
    $walk = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $rootInfo = Get-UiInfo -Element (Resolve-UiRaw -Value $Element)
    $rootNode = [pscustomobject]@{
        Name         = $rootInfo.Name
        AutomationId = $rootInfo.AutomationId
        ControlType  = $rootInfo.ControlType
        ClassName    = $rootInfo.ClassName
        IsEnabled    = $rootInfo.IsEnabled
        IsOffscreen  = $rootInfo.IsOffscreen
        X = $rootInfo.X; Y = $rootInfo.Y; Width = $rootInfo.Width; Height = $rootInfo.Height
        Depth        = 0
        Children     = @()
    }
    $count = 1
    $stack = New-Object System.Collections.Stack
    $stack.Push(@{ Node = $rootNode; Element = (Resolve-UiRaw -Value $Element) })
    while ($stack.Count -gt 0 -and $count -lt $MaxNodes) {
        $frame = $stack.Pop()
        if ($frame.Node.Depth -ge $MaxDepth) { continue }
        $kids = New-Object System.Collections.Generic.List[object]
        $child = $walk.GetFirstChild($frame.Element)
        $guard = 0
        while ($null -ne $child -and $guard -lt 500 -and $count -lt $MaxNodes) {
            $guard++
            $count++
            $info = Get-UiInfo -Element $child
            $node = [pscustomobject]@{
                Name         = $info.Name
                AutomationId = $info.AutomationId
                ControlType  = $info.ControlType
                ClassName    = $info.ClassName
                IsEnabled    = $info.IsEnabled
                IsOffscreen  = $info.IsOffscreen
                X = $info.X; Y = $info.Y; Width = $info.Width; Height = $info.Height
                Depth        = $frame.Node.Depth + 1
                Children     = @()
            }
            $kids.Add($node)
            $stack.Push(@{ Node = $node; Element = $child })
            $child = $walk.GetNextSibling($child)
        }
        $frame.Node.Children = $kids.ToArray()
    }
    return $rootNode
}

function Get-ElementRect {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Element)
    $info = Get-UiInfo -Element (Resolve-UiRaw -Value $Element)
    return @($info.X, $info.Y, $info.Width, $info.Height)
}

function Get-UiChildrenOfType {
    <# DIRECT children of a scope whose control type matches exactly. Used to
       count list rows / cards without being confused by nested containers, and
       without the List-vs-ListItem substring trap. #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Element,
        [Parameter(Mandatory = $true)][string]$ControlType
    )
    $want = $ControlType
    if ($want -notlike 'ControlType.*') { $want = "ControlType.$want" }
    $out = @()
    foreach ($child in @(Get-ElementChildren -Element $Element)) {
        if ($child.ControlType -ieq $want) { $out += $child }
    }
    return $out
}

function Find-SelectorBarItem {
    <#
    .SYNOPSIS
        Find a SelectorBar item by its visible text.
    .DESCRIPTION
        WinUI's SelectorBarItem surfaces as a raw-view-only ListItem whose
        ClassName is 'Microsoft.UI.Xaml.Controls.SelectorBarItem'. An inner
        TextBlock (aid 'PART_TextVisual') is reachable from the control view,
        but it supports no patterns - the thing you can actually Select() is the
        ListItem, and it lives in the raw view. Hard-won detail: the
        InstancesPage's StatusFilter is wrapped in a NamedContainerAutomationPeer
        and IS in the control view, while the instance-detail TabBar is not, so a
        control-view-only driver silently found zero tabs.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        $Scope,
        $Hwnd,
        [int]$TimeoutMs = 8000,
        [switch]$All,
        [switch]$AllowMissing
    )
    return Find-ByControlType -ControlType 'ListItem' -ClassNameLike 'SelectorBarItem' `
        -NameLike $Name -Exact -Scope $Scope -Hwnd $Hwnd -TimeoutMs $TimeoutMs `
        -View Raw -All:$All -AllowMissing:$AllowMissing
}

function Get-ElementParent {
    <#
    .SYNOPSIS
        Walk up the control-view parent chain and return a wrapper object.
    .DESCRIPTION
        Needed because plain containers (Grid / StackPanel) that only carry an
        x:Name often have no UI Automation peer in WinUI, so an empty-state panel
        cannot be addressed directly. The reliable anchor is a Button inside it:
        buttons always have peers.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Element,
        [int]$Levels = 1
    )
    $current = Resolve-UiRaw -Value $Element
    $walk = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    for ($i = 0; $i -lt $Levels; $i++) {
        $parent = $walk.GetParent($current)
        if ($null -eq $parent) { break }
        $current = $parent
    }
    return (Get-UiInfo -Element $current)
}

function Get-UiPrecedingTexts {
    <#
    .SYNOPSIS
        Texts immediately BEFORE an element among its control-view siblings.
    .DESCRIPTION
        This is how a case reads the rendered wording of an empty state without
        hardcoding it: anchor on the state's action button (always has a peer),
        then walk left through the sibling TextBlocks. Walking *up* instead lands
        on the page root, because the intermediate panels have no peers, and the
        result would be the whole page instead of the block under test.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Element,
        [int]$Max = 6
    )
    $current = Resolve-UiRaw -Value $Element
    $walk = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $texts = New-Object System.Collections.Generic.List[string]
    $sibling = $walk.GetPreviousSibling($current)
    while ($null -ne $sibling -and $texts.Count -lt $Max) {
        $info = Get-UiInfo -Element $sibling
        if (-not [string]::IsNullOrWhiteSpace($info.Name)) { $texts.Add($info.Name) }
        $sibling = $walk.GetPreviousSibling($sibling)
    }
    return $texts.ToArray()
}

function Get-UiTexts {
    <# Every non-empty, on-screen UIA Name inside a scope, as a plain array.
       Call sites wrap in @(). #>
    [CmdletBinding()]
    param(
        $Scope,
        $Hwnd,
        [int]$Max = 600
    )
    $scopeEl = Get-UiScope -Scope $Scope -Hwnd $Hwnd
    $texts = New-Object System.Collections.Generic.List[string]
    foreach ($el in @(Get-UiDescendants -Scope $scopeEl)) {
        $info = Get-UiInfo -Element $el
        if ($info.IsOffscreen) { continue }
        if ([string]::IsNullOrWhiteSpace($info.Name)) { continue }
        if ($texts.Count -ge $Max) { break }
        $texts.Add($info.Name)
    }
    return $texts.ToArray()
}

function Test-UiTextContained {
    <# Does any on-screen text under $Scope contain $Needle (ordinal)? #>
    [CmdletBinding()]
    param(
        $Scope,
        [Parameter(Mandatory = $true)][string]$Needle,
        $Hwnd,
        [switch]$Exact
    )
    foreach ($text in @(Get-UiTexts -Scope $Scope -Hwnd $Hwnd)) {
        if ($Exact) {
            if ($text -ceq $Needle) { return $true }
        } elseif ($text.IndexOf($Needle, [System.StringComparison]::Ordinal) -ge 0) {
            return $true
        }
    }
    return $false
}

function Get-VisibleTexts {
    <# Flatten every non-empty UIA Name in a scope. This is the cheapest honest
       way to answer "did the content actually change?": comparing two text sets
       is a real observation, whereas comparing a single control's presence is
       not. #>
    [CmdletBinding()]
    param($Scope, $Hwnd, [int]$Max = 400)
    $scopeEl = Get-UiScope -Scope $Scope -Hwnd $Hwnd
    $texts = New-Object System.Collections.Generic.List[string]
    $items = Get-UiDescendants -Scope $scopeEl
    foreach ($el in $items) {
        $info = Get-UiInfo -Element $el
        if ($info.IsOffscreen) { continue }
        if ([string]::IsNullOrWhiteSpace($info.Name)) { continue }
        if ($texts.Count -ge $Max) { break }
        $texts.Add($info.Name)
    }
    return $texts.ToArray()
}

# ---------------------------------------------------------------------------
# Waiting
# ---------------------------------------------------------------------------

function Wait-Until {
    <#
    .SYNOPSIS
        Poll a condition script block until it returns truthy or the timeout expires.
    .DESCRIPTION
        Returns $true/$false, or throws with -ThrowOnTimeout. The condition runs
        in the caller's scope so it can close over local variables.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][scriptblock]$Condition,
        [int]$TimeoutMs = 5000,
        [int]$IntervalMs = 200,
        [string]$Message = 'condition',
        [switch]$ThrowOnTimeout
    )
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
    while ($true) {
        $ok = $false
        try { $ok = [bool](& $Condition) } catch { $ok = $false }
        if ($ok) { return $true }
        if ([DateTime]::UtcNow -ge $deadline) { break }
        Start-Sleep -Milliseconds $IntervalMs
    }
    if ($ThrowOnTimeout) { throw "Wait-Until: '$Message' not satisfied within ${TimeoutMs}ms." }
    return $false
}

# ---------------------------------------------------------------------------
# Pixels
# ---------------------------------------------------------------------------

function Save-Shot {
    <# PrintWindow(PW_RENDERFULLCONTENT) capture - the only method verified in
       this project to grab DirectComposition content instead of a black bitmap. #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Hwnd,
        [Parameter(Mandatory = $true)][string]$Path
    )
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $result = [WinAuditCore]::CaptureToPng($Hwnd, $Path)
    return $result
}

function Get-ImageStats {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)
    $json = [WinAuditCore]::ImageStats($Path)
    try { return ($json | ConvertFrom-Json) } catch { return $json }
}

function Compare-Image {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$PathA,
        [Parameter(Mandatory = $true)][string]$PathB,
        [int]$Threshold = 12
    )
    $json = [WinAuditCore]::ImageDiff($PathA, $PathB, $Threshold)
    try { return ($json | ConvertFrom-Json) } catch { return $json }
}

# ---------------------------------------------------------------------------
# Context file (UTF-8 JSON written by the Node runner)
# ---------------------------------------------------------------------------

function Read-UiContext {
    <#
    .SYNOPSIS
        Read the UTF-8 JSON context produced by run-ui-tests.mjs.
    .DESCRIPTION
        This is the ONLY place Chinese text enters a case script. Keeping it in
        a JSON file sidesteps the PowerShell 5.1 ANSI .ps1 decoding trap without
        scattering [char]0x.... escapes through the assertion code.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { throw "Read-UiContext: context file not found: $Path" }
    $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    return ($raw | ConvertFrom-Json)
}

function Get-ExpectedCount {
    <# Count entries in a directory - used for "UI row count == backend count"
       assertions without hardcoding any number in the case script. #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return 0 }
    return @(Get-ChildItem -LiteralPath $Path -Force -ErrorAction SilentlyContinue).Count
}

function Get-UiScriptRoot {
    <# Directory holding this module, so case scripts do not hardcode repo paths. #>
    return $PSScriptRoot
}

Export-ModuleMember -Function @(
    'Start-WhalesApp', 'Stop-WhalesApp', 'Get-WhalesWindow', 'Get-UiRoot',
    'Find-ByAutomationId', 'Find-ByName', 'Find-ByControlType', 'Find-SelectorBarItem',
    'Invoke-Element', 'Toggle-Element', 'Get-ElementToggleState', 'Select-Element',
    'Get-ElementSelected', 'Set-ElementValue', 'Expand-Element', 'Collapse-Element', 'Send-Keys',
    'Get-ElementName', 'Get-ElementValue', 'Get-ElementChildren', 'Get-ElementTree',
    'Get-ElementRect', 'Get-VisibleTexts', 'Get-UiChildrenOfType', 'Get-UiTexts', 'Test-UiTextContained',
    'Get-ElementParent', 'Get-UiPrecedingTexts',
    'Wait-Until', 'Save-Shot', 'Get-ImageStats', 'Compare-Image',
    'Read-UiContext', 'Get-ExpectedCount', 'Get-UiScriptRoot',
    'Get-UiInfo', 'Get-UiDescendants', 'Format-UiInventory', 'Resolve-UiRaw'
)

# ---------------------------------------------------------------------------
# tour.ps1 - plan-driven screenshot driver for the guide tutorial images.
#
# WHY THIS EXISTS (and why capture-window.ps1 is not enough on its own):
#   1. every tutorial page needs a DIFFERENT environment (WHALES_SMOKE_ROUTE for
#      deep-link navigation, WHALES_LAUNCHER_ROOT for the isolated demo home),
#      and capture-window.ps1 cannot set env vars per run;
#   2. several screenshots are only reachable through UI Automation (buttons,
#      menu bars, SelectorBar tabs). Synthetic mouse clicks do not work on some
#      WinUI 3 controls, so UIA patterns are the reliable path;
#   3. popups (MenuFlyout / ContentDialog) live in their own top-level windows,
#      so a PrintWindow of the main window does not contain them. Those shots
#      need a screen-region capture of the union of the app's visible windows.
#
# It reuses scripts/audit/capture-core.ps1 ([WinAuditCore]) for window
# discovery, PrintWindow capture, synthetic input, image statistics and diffs,
# and adds a small helper type for window enumeration + screen capture.
#
# PURE ASCII ON PURPOSE: Windows PowerShell 5.1 reads .ps1 as ANSI, so any
# non-ASCII byte here becomes a syntax error. All Chinese UI strings the driver
# has to match live in the plan JSON files (read as UTF-8).
#
# USAGE
#   pwsh -File scripts\tutorial\tour.ps1 -PlanFile scripts\tutorial\plan-static.json
#   pwsh -File scripts\tutorial\tour.ps1 -PlanFile ... -Only '01-|03-'
# ---------------------------------------------------------------------------
param(
    # Plan JSON (see scripts/tutorial/plan-*.json).
    [Parameter(Mandatory = $true)][string]$PlanFile,
    # Regex filter: only shots whose name matches are captured.
    [string]$Only,
    # Scratch root for UIA dumps and non-delivered "before" shots.
    [string]$WorkRoot,
    # Emit the result JSON on stdout.
    [switch]$EmitJson,
    # Keep the launched app alive after the run (debugging aid).
    [switch]$KeepOpen
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $repoRoot 'scripts\audit\capture-core.ps1')
Initialize-WinAuditCore | Out-Null

# ------------------------------------------------------------------ helper C#
$tutHelperSource = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

/// <summary>Window enumeration + screen-region capture for the tutorial driver.
/// WinAuditCore.FindWindow only returns the largest visible window of a pid and
/// cannot see popup windows, which is exactly what menu flyouts and content
/// dialogs are. This helper fills that gap.</summary>
public class WinTutHelper
{
    private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr hWnd, StringBuilder sb, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassNameW(IntPtr hWnd, StringBuilder sb, int max);
    [DllImport("user32.dll")] private static extern IntPtr GetParent(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT rect, int size);

    private const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;

    /// <summary>Visible window bounds. GetWindowRect includes the invisible
    /// resize border and the drop shadow, so a screen capture of that rectangle
    /// samples neighbouring windows along the edges (observed as foreign text
    /// bleeding into the right and bottom edge of the first draft). The DWM
    /// extended frame bounds are what the user actually sees.</summary>
    public static int[] VisibleRect(IntPtr hwnd)
    {
        RECT r;
        int hr = DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT)));
        if (hr != 0) { GetWindowRect(hwnd, out r); }
        return new int[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top };
    }

    private static uint _want;
    private static List<string> _rows;
    private static List<int[]> _rects;
    private static List<IntPtr> _hwnds;

    private static bool Callback(IntPtr h, IntPtr l)
    {
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        if (pid != _want) { return true; }
        RECT r;
        GetWindowRect(h, out r);
        int w = r.Right - r.Left;
        int hh = r.Bottom - r.Top;
        bool visible = IsWindowVisible(h);
        StringBuilder t = new StringBuilder(512);
        GetWindowTextW(h, t, t.Capacity);
        StringBuilder c = new StringBuilder(256);
        GetClassNameW(h, c, c.Capacity);
        _rows.Add("{\"hwnd\":" + h.ToInt64().ToString(CultureInfo.InvariantCulture)
            + ",\"class\":\"" + Escape(c.ToString()) + "\""
            + ",\"title\":\"" + Escape(t.ToString()) + "\""
            + ",\"visible\":" + (visible ? "true" : "false")
            + ",\"parent\":" + GetParent(h).ToInt64().ToString(CultureInfo.InvariantCulture)
            + ",\"x\":" + r.Left.ToString(CultureInfo.InvariantCulture)
            + ",\"y\":" + r.Top.ToString(CultureInfo.InvariantCulture)
            + ",\"w\":" + w.ToString(CultureInfo.InvariantCulture)
            + ",\"h\":" + hh.ToString(CultureInfo.InvariantCulture) + "}");
        if (visible && w > 0 && hh > 0) { _rects.Add(new int[] { r.Left, r.Top, w, hh }); _hwnds.Add(h); }
        return true;
    }

    private static string Escape(string s)
    {
        if (s == null) { return ""; }
        StringBuilder sb = new StringBuilder(s.Length + 8);
        for (int i = 0; i < s.Length; i++)
        {
            char ch = s[i];
            if (ch == '"') { sb.Append("\\\""); }
            else if (ch == '\\') { sb.Append("\\\\"); }
            else if (ch < 0x20) { sb.Append(' '); }
            else { sb.Append(ch); }
        }
        return sb.ToString();
    }

    /// <summary>All top-level windows of a process (visible or not), as JSON.</summary>
    public static string ListWindows(int pid)
    {
        _want = (uint)pid;
        _rows = new List<string>();
        _rects = new List<int[]>();
        _hwnds = new List<IntPtr>();
        EnumWindows(new EnumProc(Callback), IntPtr.Zero);
        return "[" + string.Join(",", _rows.ToArray()) + "]";
    }

    /// <summary>Union of the VISIBLE bounds (DWM extended frame bounds) of every
    /// visible window of a process; the main window contributes its own bounds
    /// even when the enumeration misses it.</summary>
    public static int[] UnionRect(int pid, IntPtr mainHwnd)
    {
        _want = (uint)pid;
        _rows = new List<string>();
        _rects = new List<int[]>();
        _hwnds = new List<IntPtr>();
        EnumWindows(new EnumProc(Callback), IntPtr.Zero);

        int[] baseRect = VisibleRect(mainHwnd);
        int left = baseRect[0], top = baseRect[1];
        int right = baseRect[0] + baseRect[2], bottom = baseRect[1] + baseRect[3];
        long mainValue = mainHwnd.ToInt64();
        for (int i = 0; i < _rects.Count; i++)
        {
            if (_hwnds[i].ToInt64() == mainValue) { continue; }
            int[] r = VisibleRect(_hwnds[i]);
            if (r[2] <= 0 || r[3] <= 0) { continue; }
            if (r[0] < left) { left = r[0]; }
            if (r[1] < top) { top = r[1]; }
            if (r[0] + r[2] > right) { right = r[0] + r[2]; }
            if (r[1] + r[3] > bottom) { bottom = r[1] + r[3]; }
        }
        return new int[] { left, top, right - left, bottom - top };
    }

    /// <summary>Starts the application with its stdio FULLY detached from ours.
    ///
    /// WHY (cost hours once): [WinAuditCore]::Launch leaves the child attached to
    /// our stdout/stderr handles. If the driver exits - normally or on an error -
    /// while the app is still alive, the caller's output pipe stays open and the
    /// whole run looks like a hang instead of a finished script. Draining the
    /// child's output into a log file removes that coupling entirely.</summary>
    public static Process LaunchDetached(string exe, string workDir, string exeArgs, string logFile)
    {
        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = exe;
        psi.UseShellExecute = false;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.CreateNoWindow = true;
        if (workDir != null && workDir.Length > 0) { psi.WorkingDirectory = workDir; }
        if (exeArgs != null && exeArgs.Length > 0) { psi.Arguments = exeArgs; }
        Process p = new Process();
        p.StartInfo = psi;
        string sink = string.IsNullOrEmpty(logFile) ? null : logFile;
        if (sink != null)
        {
            p.OutputDataReceived += delegate(object s, DataReceivedEventArgs e)
            {
                if (e.Data != null) { try { System.IO.File.AppendAllText(sink, e.Data + Environment.NewLine); } catch (Exception) { } }
            };
            p.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e)
            {
                if (e.Data != null) { try { System.IO.File.AppendAllText(sink, "[stderr] " + e.Data + Environment.NewLine); } catch (Exception) { } }
            };
        }
        p.Start();
        if (sink != null) { p.BeginOutputReadLine(); p.BeginErrorReadLine(); }
        return p;
    }

    /// <summary>Copies a screen region into a PNG. Used for shots whose subject
    /// is a popup window that a PrintWindow of the main window would miss.</summary>
    public static string ScreenRegion(int x, int y, int w, int h, string path)
    {
        if (w <= 0 || h <= 0) { return "bad-region"; }
        string dir = System.IO.Path.GetDirectoryName(path);
        if (dir != null && dir.Length > 0 && !System.IO.Directory.Exists(dir)) { System.IO.Directory.CreateDirectory(dir); }
        using (Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb))
        {
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
            }
            bmp.Save(path, ImageFormat.Png);
        }
        return "ok";
    }

    /// <summary>Screen capture covering the main window plus every visible popup
    /// window of the process (menu flyouts, content dialogs).
    ///
    /// Two corrections learned the hard way:
    ///  1. the capture region is the RAW union (GetWindowRect) because that is
    ///     guaranteed to contain everything - DWM bounds can lag during the
    ///     open/resize animation;
    ///  2. the result is cropped by the difference between the raw and the DWM
    ///     visible bounds of the main window, which removes the invisible
    ///     resize border where neighbouring windows bleed through. An edge is
    ///     only cropped when the union edge actually comes from the main window
    ///     (a popup sticking out must not be cut).</summary>
    public static string CaptureUnion(int pid, IntPtr mainHwnd, string path)
    {
        int[] raw = RawRect(pid, mainHwnd);
        string res = ScreenRegion(raw[0], raw[1], raw[2], raw[3], path);
        if (res != "ok") { return res; }

        int[] rawMain = new int[4];
        RECT mr;
        GetWindowRect(mainHwnd, out mr);
        rawMain[0] = mr.Left; rawMain[1] = mr.Top;
        rawMain[2] = mr.Right - mr.Left; rawMain[3] = mr.Bottom - mr.Top;
        int[] visMain = VisibleRect(mainHwnd);

        int dx = visMain[0] - rawMain[0];
        int dy = visMain[1] - rawMain[1];
        if (dx < 0 || dx > 24) { dx = 0; }
        if (dy < 0 || dy > 24) { dy = 0; }
        int dRight = (rawMain[0] + rawMain[2]) - (visMain[0] + visMain[2]);
        int dBottom = (rawMain[1] + rawMain[3]) - (visMain[1] + visMain[3]);
        if (dRight < 0 || dRight > 24) { dRight = 0; }
        if (dBottom < 0 || dBottom > 24) { dBottom = 0; }
        if (raw[0] != rawMain[0]) { dx = 0; }
        if (raw[1] != rawMain[1]) { dy = 0; }
        if (raw[0] + raw[2] != rawMain[0] + rawMain[2]) { dRight = 0; }
        if (raw[1] + raw[3] != rawMain[1] + rawMain[3]) { dBottom = 0; }

        if (dx == 0 && dy == 0 && dRight == 0 && dBottom == 0) { return "ok"; }

        int cw = raw[2] - dx - dRight;
        int ch = raw[3] - dy - dBottom;
        if (cw <= 0 || ch <= 0) { return "ok"; }

        // The PNG is read through a MemoryStream on purpose: `new Bitmap(path)`
        // keeps the file locked, so saving the cropped image back to the same
        // path fails with a GDI+ "generic error".
        byte[] bytes = System.IO.File.ReadAllBytes(path);
        using (System.IO.MemoryStream ms = new System.IO.MemoryStream(bytes))
        {
            using (Bitmap full = new Bitmap(ms))
            {
                using (Bitmap cropped = full.Clone(new Rectangle(dx, dy, cw, ch), PixelFormat.Format32bppArgb))
                {
                    cropped.Save(path, ImageFormat.Png);
                }
            }
        }
        return "ok-cropped-" + dx + "," + dy + "," + dRight + "," + dBottom;
    }

    /// <summary>Raw (GetWindowRect) union of all visible windows of the process,
    /// always including the main window.</summary>
    private static int[] RawRect(int pid, IntPtr mainHwnd)
    {
        _want = (uint)pid;
        _rows = new List<string>();
        _rects = new List<int[]>();
        _hwnds = new List<IntPtr>();
        EnumWindows(new EnumProc(Callback), IntPtr.Zero);
        RECT mr;
        GetWindowRect(mainHwnd, out mr);
        int left = mr.Left, top = mr.Top, right = mr.Right, bottom = mr.Bottom;
        long mainValue = mainHwnd.ToInt64();
        for (int i = 0; i < _rects.Count; i++)
        {
            if (_hwnds[i].ToInt64() == mainValue) { continue; }
            int[] r = _rects[i];
            if (r[2] <= 0 || r[3] <= 0) { continue; }
            if (r[0] < left) { left = r[0]; }
            if (r[1] < top) { top = r[1]; }
            if (r[0] + r[2] > right) { right = r[0] + r[2]; }
            if (r[1] + r[3] > bottom) { bottom = r[1] + r[3]; }
        }
        return new int[] { left, top, right - left, bottom - top };
    }

    /* ------------------------------------------------------------ watchdog
     * PrintWindow and DwmGetWindowAttribute are cross-process calls: against a
     * window whose owner thread is wedged they block indefinitely, and a wedged
     * call inside the driver kills the whole capture run (observed once: a
     * screen capture that never returned). Running each capture on a background
     * thread with a join timeout turns "hang forever" into "this shot failed".
     * -------------------------------------------------------------------- */

    private delegate string CaptureWork();

    private static string _workResult;

    private static void RunWork(object state)
    {
        CaptureWork work = (CaptureWork)state;
        try { _workResult = work(); }
        catch (Exception ex) { _workResult = "error: " + ex.Message; }
    }

    private static string RunWithTimeout(CaptureWork work, int timeoutMs)
    {
        _workResult = null;
        Thread t = new Thread(new ParameterizedThreadStart(RunWork));
        t.IsBackground = true;
        t.Start(work);
        if (!t.Join(timeoutMs)) { return "timeout-" + timeoutMs + "ms"; }
        return _workResult == null ? "no-result" : _workResult;
    }

    /// <summary>PrintWindow(PW_RENDERFULLCONTENT) capture with a watchdog.
    /// Same output as WinAuditCore.CaptureToPng, but it cannot hang the run.</summary>
    public static string CaptureWindowSafe(IntPtr hwnd, string path, int timeoutMs)
    {
        return RunWithTimeout(delegate() { return WindowCapture(hwnd, path); }, timeoutMs);
    }

    public static string CaptureUnionSafe(int pid, IntPtr hwnd, string path, int timeoutMs)
    {
        return RunWithTimeout(delegate() { return CaptureUnion(pid, hwnd, path); }, timeoutMs);
    }

    public static string WindowCapture(IntPtr hwnd, string path)
    {
        RECT r;
        GetWindowRect(hwnd, out r);
        int w = r.Right - r.Left;
        int h = r.Bottom - r.Top;
        if (w <= 0 || h <= 0) { return "bad-window-bounds"; }
        string dir = System.IO.Path.GetDirectoryName(path);
        if (dir != null && dir.Length > 0 && !System.IO.Directory.Exists(dir)) { System.IO.Directory.CreateDirectory(dir); }
        using (Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb))
        {
            using (Graphics g = Graphics.FromImage(bmp))
            {
                IntPtr hdc = g.GetHdc();
                bool ok;
                try { ok = PrintWindow(hwnd, hdc, 2); }
                finally { g.ReleaseHdc(hdc); }
                if (!ok) { return "printwindow-failed"; }
            }
            bmp.Save(path, ImageFormat.Png);
        }
        return "ok";
    }
}
'@

if (-not ('WinTutHelper' -as [type])) {
    Add-Type -TypeDefinition $tutHelperSource -ReferencedAssemblies 'System.Drawing', 'UIAutomationClient', 'UIAutomationTypes', 'WindowsBase', 'System.Core'
}

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

# ------------------------------------------------------------------ UIA utils

function Get-StepField {
    param($Step, [string]$Name)
    if ($null -eq $Step) { return $null }
    if ($Step.PSObject.Properties.Name -contains $Name) { return $Step.$Name }
    return $null
}

function Write-JsonFile {
    <#  Writes JSON as UTF-8 WITHOUT a BOM. Set-Content -Encoding UTF8 in
        PowerShell 5.1 emits a BOM, and a BOM makes Node's JSON.parse fail
        ("Unexpected token"), which cost real debugging time. #>
    param([string]$Path, $Value)
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $json = $Value | ConvertTo-Json -Depth 12
    [System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-FieldBool {
    param($Step, [string]$Name, [bool]$Default = $false)
    $v = Get-StepField -Step $Step -Name $Name
    if ($null -eq $v) { return $Default }
    return [bool]$v
}

function Get-UiaRoot {
    param([IntPtr]$Hwnd, [string]$Scope)
    if ($Scope -eq 'desktop') { return [System.Windows.Automation.AutomationElement]::RootElement }
    return [System.Windows.Automation.AutomationElement]::FromHandle($Hwnd)
}

function Get-UiaElementCurrent {
    <#  Reads the interesting properties of one element defensively: elements can
        disappear between enumeration and inspection during menu animations. #>
    param($Element)
    try {
        $c = $Element.Current
        return [pscustomobject]@{
            Name    = $c.Name
            Aid     = $c.AutomationId
            Ct      = $c.ControlType.ProgrammaticName
            Class   = $c.ClassName
            Enabled = $c.IsEnabled
            Offscreen = $c.IsOffscreen
            Pid     = $c.ProcessId
            Rect    = $c.BoundingRectangle
            Element = $Element
        }
    } catch {
        return $null
    }
}

# ControlType programmatic name -> ControlType instance, built by reflection so
# the mapping cannot drift from the framework.
$script:CtMap = @{}
foreach ($prop in [System.Windows.Automation.ControlType].GetProperties([System.Reflection.BindingFlags]::Public -bor [System.Reflection.BindingFlags]::Static)) {
    $value = $null
    try { $value = $prop.GetValue($null) } catch { $value = $null }
    if ($value -is [System.Windows.Automation.ControlType]) {
        $script:CtMap['ControlType.' + $prop.Name] = $value
    }
}

function New-UiaCondition {
    <#  Builds a server-side condition from the fields that UI Automation can
        filter itself (ProcessId / Name / AutomationId / ControlType).

        WHY: enumerating the whole desktop tree and reading properties of every
        element one by one is extremely slow (each property read is a cross
        process call, and the desktop tree of a busy machine has tens of
        thousands of elements). A first draft did exactly that and hung for
        minutes. Pushing the filter into the query keeps enumeration bounded. #>
    param(
        [int]$WantPid = 0,
        [string]$WantName,
        [string]$WantAid,
        [string]$WantCt
    )

    $conds = New-Object System.Collections.ArrayList
    if ($WantPid -gt 0) {
        [void]$conds.Add((New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $WantPid)))
    }
    if ($WantName) {
        [void]$conds.Add((New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $WantName)))
    }
    if ($WantAid) {
        [void]$conds.Add((New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $WantAid)))
    }
    if ($WantCt) {
        if (-not $WantCt.StartsWith('ControlType.')) { $WantCt = 'ControlType.' + $WantCt }
        if ($script:CtMap.ContainsKey($WantCt)) {
            [void]$conds.Add((New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $script:CtMap[$WantCt])))
        }
    }

    if ($conds.Count -eq 0) { return [System.Windows.Automation.Condition]::TrueCondition }
    if ($conds.Count -eq 1) { return $conds[0] }
    $arr = New-Object 'System.Windows.Automation.Condition[]' $conds.Count
    for ($i = 0; $i -lt $conds.Count; $i++) { $arr[$i] = $conds[$i] }
    return (New-Object System.Windows.Automation.AndCondition -ArgumentList (,$arr))
}

function Find-UiaElement {
    <#  Selector fields (all optional, ANDed):
          Name / NameLike / Aid / Ct / Class / Index / Pid / IncludeOffscreen
        Ct matches the ControlType programmatic name with or without the
        "ControlType." prefix, case-insensitively. #>
    param(
        [IntPtr]$Hwnd,
        $Step,
        [int]$AppPid = 0,
        [int]$TimeoutMs = 0
    )

    $scope = [string](Get-StepField -Step $Step -Name 'Scope')
    if (-not $scope) { $scope = 'main' }
    $wantName = [string](Get-StepField -Step $Step -Name 'Name')
    $wantLike = [string](Get-StepField -Step $Step -Name 'NameLike')
    $wantAid = [string](Get-StepField -Step $Step -Name 'Aid')
    $wantCt = [string](Get-StepField -Step $Step -Name 'Ct')
    $wantClass = [string](Get-StepField -Step $Step -Name 'Class')
    $wantIndex = 0
    $vi = Get-StepField -Step $Step -Name 'Index'
    if ($null -ne $vi) { $wantIndex = [int]$vi }
    $includeOffscreen = Get-FieldBool -Step $Step -Name 'IncludeOffscreen'
    $wantChild = [string](Get-StepField -Step $Step -Name 'ChildName')
    $wantPid = $AppPid
    $vp = Get-StepField -Step $Step -Name 'Pid'
    if ($null -ne $vp) { $wantPid = [int]$vp }
    if ($scope -eq 'main') { $wantPid = 0 }

    if ($wantCt -and $wantCt -notlike 'ControlType.*') { $wantCt = 'ControlType.' + $wantCt }

    # Only server-side filterable fields go into the condition; NameLike, Class
    # and ChildName stay client-side because UIA has no substring condition and
    # no "has a descendant named X" condition.
    $serverName = $null
    if ($wantName -and -not $wantLike) { $serverName = $wantName }
    $cond = New-UiaCondition -WantPid $wantPid -WantName $serverName -WantAid $wantAid -WantCt $wantCt
    $childCond = New-UiaCondition -WantName $wantChild

    $deadline = (Get-Date).AddMilliseconds([Math]::Max(0, $TimeoutMs))
    $matches = @()
    while ($true) {
        $matches = @()
        $root = $null
        try { $root = Get-UiaRoot -Hwnd $Hwnd -Scope $scope } catch { $root = $null }
        if ($null -ne $root) {
            $found = $null
            try {
                $found = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
            } catch { $found = $null }
            if ($null -ne $found) {
                foreach ($el in $found) {
                    $info = Get-UiaElementCurrent -Element $el
                    if ($null -eq $info) { continue }
                    if ($wantPid -gt 0 -and $info.Pid -ne $wantPid) { continue }
                    if (-not $includeOffscreen -and $info.Offscreen) { continue }
                    if ($wantName -and $info.Name -ne $wantName) { continue }
                    if ($wantLike -and ($null -eq $info.Name -or $info.Name.IndexOf($wantLike, [System.StringComparison]::OrdinalIgnoreCase) -lt 0)) { continue }
                    if ($wantAid -and $info.Aid -ne $wantAid) { continue }
                    if ($wantCt -and $info.Ct -ne $wantCt) { continue }
                    if ($wantClass -and ($null -eq $info.Class -or $info.Class.IndexOf($wantClass, [System.StringComparison]::OrdinalIgnoreCase) -lt 0)) { continue }
                    if ($wantChild) {
                        $hit = $null
                        try { $hit = $el.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $childCond) } catch { $hit = $null }
                        if ($null -eq $hit) { continue }
                    }
                    $matches += $info
                }
            }
        }
        if ($matches.Count -gt $wantIndex) { return $matches[$wantIndex] }
        if ((Get-Date) -ge $deadline) { return $null }
        Start-Sleep -Milliseconds 350
    }
}

function Get-UiaPattern {
    param($Element, $Pattern)
    try { return $Element.GetCurrentPattern($Pattern) } catch { return $null }
}

function Invoke-UiaAction {
    <#  Performs one UIA action on an element. Returns a short status string.
        Order matters: real patterns first (they never depend on pixel geometry),
        coordinate click only as the last resort. #>
    param($Info, [string]$Action, [string]$Value, [IntPtr]$Hwnd)

    switch ($Action) {
        'focus' {
            try { $Info.Element.SetFocus(); return 'focus-ok' } catch { return 'focus-failed: ' + $_.Exception.Message }
        }
        'value' {
            $p = Get-UiaPattern -Element $Info.Element -Pattern ([System.Windows.Automation.ValuePattern]::Pattern)
            if ($null -eq $p) { return 'no-value-pattern' }
            try { $p.SetValue($Value); return 'value-ok' } catch { return 'value-failed: ' + $_.Exception.Message }
        }
        'expand' {
            $p = Get-UiaPattern -Element $Info.Element -Pattern ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
            if ($null -eq $p) { return 'no-expand-pattern' }
            try { $p.Expand(); return 'expand-ok' } catch { return 'expand-failed: ' + $_.Exception.Message }
        }
        'collapse' {
            $p = Get-UiaPattern -Element $Info.Element -Pattern ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
            if ($null -eq $p) { return 'no-expand-pattern' }
            try { $p.Collapse(); return 'collapse-ok' } catch { return 'collapse-failed: ' + $_.Exception.Message }
        }
        'select' {
            $p = Get-UiaPattern -Element $Info.Element -Pattern ([System.Windows.Automation.SelectionItemPattern]::Pattern)
            if ($null -eq $p) { return 'no-selectionitem-pattern' }
            try { $p.Select(); return 'select-ok' } catch { return 'select-failed: ' + $_.Exception.Message }
        }
        'scrollintoview' {
            $p = Get-UiaPattern -Element $Info.Element -Pattern ([System.Windows.Automation.ScrollItemPattern]::Pattern)
            if ($null -eq $p) { return 'no-scrollitem-pattern' }
            try { $p.ScrollIntoView(); return 'scrollintoview-ok' } catch { return 'scrollintoview-failed: ' + $_.Exception.Message }
        }
        'clickcenter' {
            return (Invoke-UiaClickCenter -Info $Info -Hwnd $Hwnd -Button 'left')
        }
        'rightclick' {
            return (Invoke-UiaClickCenter -Info $Info -Hwnd $Hwnd -Button 'right')
        }
        default {
            # 'invoke' and everything unknown: try the activation patterns in order.
            $p = Get-UiaPattern -Element $Info.Element -Pattern ([System.Windows.Automation.InvokePattern]::Pattern)
            if ($null -ne $p) {
                try { $p.Invoke(); return 'invoke-ok' } catch { }
            }
            $p = Get-UiaPattern -Element $Info.Element -Pattern ([System.Windows.Automation.TogglePattern]::Pattern)
            if ($null -ne $p) {
                try { $p.Toggle(); return 'toggle-ok' } catch { }
            }
            $p = Get-UiaPattern -Element $Info.Element -Pattern ([System.Windows.Automation.SelectionItemPattern]::Pattern)
            if ($null -ne $p) {
                try { $p.Select(); return 'select-ok' } catch { }
            }
            $p = Get-UiaPattern -Element $Info.Element -Pattern ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
            if ($null -ne $p) {
                try { $p.Expand(); return 'expand-ok' } catch { }
            }
            return (Invoke-UiaClickCenter -Info $Info -Hwnd $Hwnd -Button 'left')
        }
    }
}

function Wait-WindowSettled {
    <#  Blocks until two captures taken ~700 ms apart are nearly identical.
        WHY: a first draft captured while the window was still playing its
        open/resize animation and produced a translucent, half-drawn frame with
        the title bar cut off - a useless screenshot that still "looked like" a
        successful capture. Comparing two consecutive frames is a cheap,
        objective idle test. #>
    param(
        [IntPtr]$Hwnd,
        [int]$AppPid,
        [string]$Mode = 'window',
        [string]$Name = 'shot',
        [int]$Tries = 6,
        [double]$Threshold = 0.004
    )

    $a = Join-Path $scratchDir ('_settle-' + $Name + '-a.png')
    $b = Join-Path $scratchDir ('_settle-' + $Name + '-b.png')
    $last = $null
    for ($i = 1; $i -le $Tries; $i++) {
        if ($Mode -eq 'screen') {
            [void][WinTutHelper]::CaptureUnionSafe($AppPid, $Hwnd, $a, 25000)
        } else {
            [void][WinTutHelper]::CaptureWindowSafe($Hwnd, $a, 20000)
        }
        Start-Sleep -Milliseconds 700
        [void][WinAuditCore]::SetForeground($Hwnd)
        if ($Mode -eq 'screen') {
            [void][WinTutHelper]::CaptureUnionSafe($AppPid, $Hwnd, $b, 25000)
        } else {
            [void][WinTutHelper]::CaptureWindowSafe($Hwnd, $b, 20000)
        }
        $d = $null
        try { $d = ([WinAuditCore]::ImageDiff($a, $b, 24) | ConvertFrom-Json) } catch { $d = $null }
        if ($null -eq $d -or $d.ok -ne $true) {
            return ([pscustomobject]@{ settled = $false; tries = $i; reason = 'diff-unavailable' })
        }
        $last = $d.changedPixelRatio
        if ([double]$d.changedPixelRatio -lt $Threshold) {
            return ([pscustomobject]@{ settled = $true; tries = $i; changedPixelRatio = $d.changedPixelRatio })
        }
    }
    Add-TutWarning "shot $Name : window did not settle in $Tries tries (last changedPixelRatio=$last)"
    return ([pscustomobject]@{ settled = $false; tries = $Tries; changedPixelRatio = $last })
}

function Invoke-UiaClickCenter {
    <#  Coordinate click at the centre of an element's rectangle. The rectangle is
        in screen coordinates, while [WinAuditCore]::Click wants window-relative
        coordinates, so the window origin is subtracted here. #>
    param($Info, [IntPtr]$Hwnd, [string]$Button = 'left')
    $r = $Info.Rect
    if ($null -eq $r -or $r.Width -le 0 -or $r.Height -le 0) { return 'empty-rect' }
    $wr = [WinAuditCore]::RectOf($Hwnd)
    $lx = [int]([Math]::Round($r.X - $wr[0] + $r.Width / 2))
    $ly = [int]([Math]::Round($r.Y - $wr[1] + $r.Height / 2))
    $res = [WinAuditCore]::Click($Hwnd, $lx, $ly, $Button)
    return ("clickcenter-" + $res + " @" + $lx + "," + $ly)
}

function Export-UiaDump {
    <#  Writes the app's UIA tree to one JSON file:
          main    - [WinAuditCore]::UiaDump of the main window handle
          windows - every top-level window of the process (popups included)
          popups  - a UIA dump of each OTHER visible window of the process,
                    which is where WinUI 3 menu flyouts and content dialogs live

        WHY not walk AutomationElement.RootElement: a first draft enumerated the
        whole desktop tree filtered by ProcessId and hung for minutes (UIA
        providers of unrelated apps answer queries very slowly). Going window by
        window through Win32 enumeration is bounded and fast. #>
    param([IntPtr]$Hwnd, [int]$AppPid, [string]$Path, [int]$MaxNodes = 900)

    Write-Host "     uia dump: main window ..."
    $mainDump = (([WinAuditCore]::UiaDump($Hwnd, 14, $MaxNodes)) | ConvertFrom-Json)
    Write-Host "     uia dump: main window -> $($mainDump.nodeCount) nodes"

    $windows = (([WinTutHelper]::ListWindows($AppPid)) | ConvertFrom-Json)
    $popups = @()
    foreach ($w in $windows) {
        if ($w.hwnd -eq $Hwnd.ToInt64()) { continue }
        if (-not $w.visible) { continue }
        if ($w.w -le 0 -or $w.h -le 0) { continue }
        Write-Host "     uia dump: popup $($w.class) $($w.w)x$($w.h) ..."
        $dump = $null
        try { $dump = (([WinAuditCore]::UiaDump([IntPtr]$w.hwnd, 12, 250)) | ConvertFrom-Json) } catch { $dump = $null }
        $popups += [pscustomobject]@{ hwnd = $w.hwnd; cls = $w.class; title = $w.title; dump = $dump }
    }

    $payload = [ordered]@{ main = $mainDump; windows = $windows; popups = $popups }
    Write-JsonFile -Path $Path -Value $payload
    return @{ nodes = $mainDump.nodeCount; popups = $popups.Count }
}

# ------------------------------------------------------------------ plan load

if (-not (Test-Path -LiteralPath $PlanFile)) { throw "plan file not found: $PlanFile" }
$planPath = (Resolve-Path -LiteralPath $PlanFile).Path
$plan = (Get-Content -LiteralPath $planPath -Raw -Encoding UTF8) | ConvertFrom-Json

if (-not $WorkRoot) { $WorkRoot = Join-Path $repoRoot '.probe\tutorial-work' }
if (-not (Test-Path -LiteralPath $WorkRoot)) { New-Item -ItemType Directory -Path $WorkRoot -Force | Out-Null }

$scratchDir = Join-Path $WorkRoot 'scratch'
$uiaDir = Join-Path $WorkRoot 'uia'
foreach ($d in @($scratchDir, $uiaDir)) {
    if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}

$sessionResults = New-Object System.Collections.Generic.List[object]
$shotResults = New-Object System.Collections.Generic.List[object]
$tutorialWarnings = New-Object System.Collections.Generic.List[string]

function Add-TutWarning {
    param([string]$Message)
    [void]$tutorialWarnings.Add($Message)
    Write-Host "  ! $Message"
}

function Clear-DemoProcesses {
    <#  Kills leftovers of THIS tutorial run only: Node processes whose command
        line mentions the isolated demo home (the stub engines and the app's
        bridge child). Never touches the user's real launcher, instances or
        engines - the filter is the temp home path, which cannot appear in a
        real instance's command line.

        WHY: when the app is killed, its bridge child and any stub engine it
        started survive. Running the next capture session on top of them left
        the app in a state where it crashed on startup (COMException
        0x8000FFFF) and no window could be found. Cleaning up first makes every
        run start from the same place. #>
    param([string]$HomePath)
    if (-not $HomePath) { return 0 }
    $killed = 0
    try {
        $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop
        foreach ($proc in $procs) {
            $cmd = [string]$proc.CommandLine
            if ($cmd -and $cmd.IndexOf($HomePath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
                try { Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop; $killed++ } catch { }
            }
        }
    } catch { }
    if ($killed -gt 0) { Write-Host "  (cleaned $killed stray node process(es) for the demo home)" }
    return $killed
}

# ------------------------------------------------------------------- main run

# Every launched pid is tracked so a failure anywhere cannot leave an app
# process behind (a surviving child keeps our stdio pipes open and makes the
# whole run look like a hang - see LaunchDetached for the same lesson).
$launchedPids = New-Object System.Collections.Generic.List[int]

try {

foreach ($session in $plan.sessions) {
    $sid = [string]$session.id
    Write-Host "== session $sid =="

    $route = [string](Get-StepField -Step $session -Name 'route')
    if ($route) { $env:WHALES_SMOKE_ROUTE = $route } else { Remove-Item Env:\WHALES_SMOKE_ROUTE -ErrorAction SilentlyContinue }
    $env:WHALES_LAUNCHER_ROOT = [string]$plan.home
    Remove-Item Env:\WHALES_ROOT -ErrorAction SilentlyContinue

    $extraEnv = Get-StepField -Step $session -Name 'env'
    if ($null -ne $extraEnv) {
        foreach ($p in $extraEnv.PSObject.Properties) { Set-Item -Path ("Env:\" + $p.Name) -Value ([string]$p.Value) }
    }

    $waitMs = 6000
    $vw = Get-StepField -Step $session -Name 'waitMs'
    if ($null -ne $vw) { $waitMs = [int]$vw }

    $sessionShots = @($session.shots | Where-Object {
        if (-not $Only) { return $true }
        return ([string]$_.name -match $Only)
    })
    if ($sessionShots.Count -eq 0) {
        Write-Host "  (no shots selected)"
        continue
    }

    [void](Clear-DemoProcesses -HomePath ([string]$plan.home))

    # Launch with retries. The app has an intermittent startup crash
    # (COMException 0x8000FFFF, no window ever appears) right after a previous
    # run was interrupted; a fresh launch a couple of seconds later always
    # worked. Retrying keeps one flaky start from losing a whole session.
    $appLog = Join-Path $WorkRoot ('app-' + $sid + '.log')
    $hwnd = [IntPtr]::Zero
    $appPid = 0
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        if ($attempt -gt 1) {
            Write-Host "  (launch attempt $attempt)"
            [void](Clear-DemoProcesses -HomePath ([string]$plan.home))
            Start-Sleep -Milliseconds 2500
        }
        $proc = [WinTutHelper]::LaunchDetached([string]$plan.exe, [string](Get-StepField -Step $session -Name 'workDir'), [string](Get-StepField -Step $session -Name 'exeArgs'), $appLog)
        $appPid = $proc.Id
        [void]$launchedPids.Add($appPid)
        Start-Sleep -Milliseconds $waitMs

        $hwnd = [WinAuditCore]::FindWindow($appPid, 'WhalesLauncher')
        if ($hwnd -ne [IntPtr]::Zero) {
            $rect = [WinAuditCore]::RectOf($hwnd)
            if ($rect[2] -gt 200 -and $rect[3] -gt 200) { break }
            Add-TutWarning "session $sid : window has no usable size ($($rect -join ','))"
            $hwnd = [IntPtr]::Zero
        }
        if (-not [WinAuditCore]::Alive($appPid)) {
            Add-TutWarning "session $sid : app exited during startup (attempt $attempt)"
        } else {
            Add-TutWarning "session $sid : no usable window for pid $appPid (attempt $attempt)"
        }
        [void][WinAuditCore]::Kill($appPid)
        Start-Sleep -Milliseconds 1200
    }

    if ($hwnd -eq [IntPtr]::Zero) {
        Add-TutWarning "session $sid : giving up after 3 launch attempts"
        continue
    }
    [void][WinAuditCore]::SetForeground($hwnd)
    Start-Sleep -Milliseconds 800

    $sessionRecord = [ordered]@{
        id = $sid
        route = $route
        pid = $appPid
        hwnd = $hwnd.ToInt64()
        windowClass = [WinAuditCore]::ClassOf($hwnd)
        windowRect = ([WinAuditCore]::RectOf($hwnd) -join ',')
        shots = @()
    }

    foreach ($shot in $sessionShots) {
        $name = [string]$shot.name
        $isScratch = Get-FieldBool -Step $shot -Name 'scratch'
        $mode = [string](Get-StepField -Step $shot -Name 'mode')
        if (-not $mode) { $mode = 'window' }
        $outPath = [string](Get-StepField -Step $shot -Name 'path')
        if (-not $outPath) {
            if ($isScratch) { $outPath = Join-Path $scratchDir ($name + '.png') }
            else { $outPath = Join-Path ([string]$plan.outDir) ($name + '.png') }
        }
        $dir = Split-Path -Parent $outPath
        if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

        $shotRecord = [ordered]@{
            name = $name
            session = $sid
            path = $outPath
            scratch = $isScratch
            mode = $mode
            steps = @()
            captureStatus = $null
            imageStats = $null
            pngSha256 = $null
            diff = $null
        }

        Write-Host "  -- shot $name"

        $captureRequested = $true
        foreach ($step in @($shot.steps)) {
            $type = [string](Get-StepField -Step $step -Name 'Type')
            $type = $type.ToLowerInvariant()
            $stepRecord = [ordered]@{ type = $type; detail = $null; ok = $true }

            switch ($type) {
                'wait' {
                    $ms = 800
                    $v = Get-StepField -Step $step -Name 'Ms'
                    if ($null -ne $v) { $ms = [int]$v }
                    Start-Sleep -Milliseconds $ms
                    $stepRecord.detail = "$ms ms"
                }
                'focus' {
                    $stepRecord.detail = [WinAuditCore]::SetForeground($hwnd)
                }
                'key' {
                    $chord = [string](Get-StepField -Step $step -Name 'Chord')
                    [void][WinAuditCore]::SetForeground($hwnd)
                    Start-Sleep -Milliseconds 200
                    $stepRecord.detail = [WinAuditCore]::Key($chord)
                }
                'text' {
                    $val = [string](Get-StepField -Step $step -Name 'Value')
                    [void][WinAuditCore]::SetForeground($hwnd)
                    Start-Sleep -Milliseconds 200
                    $stepRecord.detail = [WinAuditCore]::Text($val)
                }
                'click' {
                    $x = [int](Get-StepField -Step $step -Name 'X')
                    $y = [int](Get-StepField -Step $step -Name 'Y')
                    $btn = [string](Get-StepField -Step $step -Name 'Button')
                    if (-not $btn) { $btn = 'left' }
                    $stepRecord.detail = [WinAuditCore]::Click($hwnd, $x, $y, $btn)
                }
                'move' {
                    # Move the physical cursor WITHOUT clicking. Needed before a
                    # wheel step: the wheel event goes to whatever is under the
                    # cursor, so scrolling a page means parking the cursor there.
                    $x = [int](Get-StepField -Step $step -Name 'X')
                    $y = [int](Get-StepField -Step $step -Name 'Y')
                    [void][WinAuditCore]::SetForeground($hwnd)
                    Start-Sleep -Milliseconds 250
                    $stepRecord.detail = [WinAuditCore]::MoveTo($hwnd, $x, $y)
                    Start-Sleep -Milliseconds 250
                }
                'wheel' {
                    $d = -120
                    $v = Get-StepField -Step $step -Name 'Delta'
                    if ($null -ne $v) { $d = [int]$v }
                    [void][WinAuditCore]::SetForeground($hwnd)
                    $stepRecord.detail = [WinAuditCore]::Wheel($hwnd, $d)
                }
                'uia' {
                    $action = [string](Get-StepField -Step $step -Name 'Action')
                    if (-not $action) { $action = 'invoke' }
                    $action = $action.ToLowerInvariant()
                    $timeout = 0
                    $vt = Get-StepField -Step $step -Name 'TimeoutMs'
                    if ($null -ne $vt) { $timeout = [int]$vt }
                    if ($action -eq 'waitfor' -and $timeout -le 0) { $timeout = 8000 }

                    if ($action -eq 'windows') {
                        $json = [WinTutHelper]::ListWindows($appPid)
                        $file = Join-Path $uiaDir ($name + '-windows.json')
                        [System.IO.File]::WriteAllText($file, $json, (New-Object System.Text.UTF8Encoding($false)))
                        $stepRecord.detail = "windows -> $file"
                        break
                    }
                    if ($action -eq 'dump') {
                        $dumped = Export-UiaDump -Hwnd $hwnd -AppPid $appPid -Path (Join-Path $uiaDir ($name + '-uia.json'))
                        $stepRecord.detail = "uia main nodes = $($dumped.nodes); popups = $($dumped.popups)"
                        break
                    }

                    $info = Find-UiaElement -Hwnd $hwnd -Step $step -AppPid $appPid -TimeoutMs $timeout
                    if ($null -eq $info) {
                        $stepRecord.ok = $false
                        $stepRecord.detail = 'element-not-found'
                        Add-TutWarning "shot $name : uia $action -> element not found"
                    } elseif ($action -eq 'waitfor') {
                        $stepRecord.detail = 'found: ' + $info.Name
                    } elseif ($action -eq 'info') {
                        $stepRecord.detail = ($info.Ct + ' | ' + $info.Name + ' | ' + $info.Aid + ' | ' + [Math]::Round($info.Rect.X) + ',' + [Math]::Round($info.Rect.Y) + ' ' + [Math]::Round($info.Rect.Width) + 'x' + [Math]::Round($info.Rect.Height))
                    } else {
                        $stepRecord.detail = (Invoke-UiaAction -Info $info -Action $action -Value ([string](Get-StepField -Step $step -Name 'Value')) -Hwnd $hwnd)
                    }
                    $postWait = 500
                    $vpw = Get-StepField -Step $step -Name 'AfterMs'
                    if ($null -ne $vpw) { $postWait = [int]$vpw }
                    Start-Sleep -Milliseconds $postWait
                }
                'capture' {
                    $captureRequested = $true
                }
                default {
                    $stepRecord.ok = $false
                    $stepRecord.detail = "unknown step type '$type'"
                    Add-TutWarning "shot $name : unknown step type '$type'"
                }
            }

            $shotRecord.steps += [pscustomobject]$stepRecord
        }

        if ($captureRequested) {
            [void][WinAuditCore]::SetForeground($hwnd)
            Start-Sleep -Milliseconds 500
            $settle = Wait-WindowSettled -Hwnd $hwnd -AppPid $appPid -Mode $mode -Name $name
            $shotRecord.settle = $settle
            if ($mode -eq 'screen') {
                $shotRecord.captureStatus = [WinTutHelper]::CaptureUnionSafe($appPid, $hwnd, $outPath, 25000)
            } else {
                $shotRecord.captureStatus = [WinTutHelper]::CaptureWindowSafe($hwnd, $outPath, 20000)
            }
            if ($shotRecord.captureStatus -and $shotRecord.captureStatus.StartsWith('ok') -and (Test-Path -LiteralPath $outPath)) {
                $shotRecord.pngSha256 = [WinAuditCore]::Sha256OfFile($outPath)
                $shotRecord.imageStats = ([WinAuditCore]::ImageStats($outPath) | ConvertFrom-Json)
            } else {
                Add-TutWarning "shot $name : capture returned '$($shotRecord.captureStatus)'"
            }
        }

        $baseline = [string](Get-StepField -Step $shot -Name 'baseline')
        if ($baseline -and (Test-Path -LiteralPath $outPath)) {
            $basePath = $baseline
            if (-not (Test-Path -LiteralPath $basePath)) {
                $cand = Join-Path $scratchDir ($baseline + '.png')
                if (Test-Path -LiteralPath $cand) { $basePath = $cand }
            }
            # A baseline may also be a previously captured (delivered) shot of
            # this plan - that is how an interaction is proven against the same
            # page in its untouched state.
            if (-not (Test-Path -LiteralPath $basePath)) {
                $cand2 = Join-Path ([string]$plan.outDir) ($baseline + '.png')
                if (Test-Path -LiteralPath $cand2) { $basePath = $cand2 }
            }
            if (Test-Path -LiteralPath $basePath) {
                $d = ([WinAuditCore]::ImageDiff($basePath, $outPath, 24) | ConvertFrom-Json)
                $shotRecord.diff = [pscustomobject]@{ against = $basePath; result = $d }
            } else {
                Add-TutWarning "shot $name : baseline '$baseline' not found"
            }
        }

        [void]$shotResults.Add([pscustomobject]$shotRecord)
        $sessionRecord.shots += $name
    }

    [void]$sessionResults.Add([pscustomobject]$sessionRecord)

    if ($KeepOpen) {
        Write-Host "  (kept alive pid $appPid)"
    } else {
        [void][WinAuditCore]::Kill($appPid)
        Start-Sleep -Milliseconds 600
    }
}

} catch {
    Add-TutWarning ('fatal: ' + $_.Exception.Message)
} finally {
    foreach ($leftover in $launchedPids) {
        if ([WinAuditCore]::Alive($leftover)) { [void][WinAuditCore]::Kill($leftover) }
    }
    [void](Clear-DemoProcesses -HomePath ([string]$plan.home))
}

Remove-Item Env:\WHALES_SMOKE_ROUTE -ErrorAction SilentlyContinue
Remove-Item Env:\WHALES_LAUNCHER_ROOT -ErrorAction SilentlyContinue

$result = [ordered]@{
    schema = 'whaleslauncher.tutorial.tour/1'
    generatedAt = (Get-Date).ToString('o')
    plan = $planPath
    exe = [string]$plan.exe
    home = [string]$plan.home
    sessions = @($sessionResults.ToArray())
    shots = @($shotResults.ToArray())
    warnings = @($tutorialWarnings.ToArray())
}

$reportPath = Join-Path $WorkRoot 'tour-result.json'
Write-JsonFile -Path $reportPath -Value $result
$resultJson = $result | ConvertTo-Json -Depth 12

if ($EmitJson) { Write-Output $resultJson } else { Write-Host "result -> $reportPath" }
exit 0

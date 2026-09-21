# ---------------------------------------------------------------------------
# WhalesLauncher WinUI 3 visual-audit shared library  (W-AUDIT / task-3)
#
# Dot-source this file from a PowerShell script. It provides:
#   * [WinAuditCore] - inline C# helper: window discovery, PW_RENDERFULLCONTENT
#     capture, synthetic input (keyboard/mouse), image statistics, UI Automation
#     element-tree dump.
#   * Get-WinAuditImageStats / Compare-WinAuditImage - PNG analysis.
#   * WinAudit-SetSystemAppTheme / WinAudit-GetSystemAppTheme - theme control.
#   * WinAudit-GetImageHash / WinAudit-GetTextHash - traceability.
#
# CONSTRAINTS (do not break these):
#   1. This file must stay PURE ASCII. Windows PowerShell 5.1 reads .ps1 files as
#      ANSI; non-ASCII bytes get mangled into syntax errors.
#   2. Inline C# here is compiled by the PowerShell 5.1 in-box compiler, which
#      does NOT support C# 7+ syntax. No 'out var', no 'is not', no switch
#      expressions, no string interpolation, no expression-bodied members,
#      no tuples. Keep everything C# 5 / .NET Framework 4.x compatible and use
#      fully qualified type names for anything not in the default reference set.
# ---------------------------------------------------------------------------

$script:WinAuditCoreLoaded = $false

function Initialize-WinAuditCore {
    [CmdletBinding()]
    param()

    if ($script:WinAuditCoreLoaded) { return }

    Add-Type -AssemblyName System.Drawing
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes

    $source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

public class WinAuditCore
{
    // ----------------------------------------------------------------- P/Invoke
    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] private static extern bool ClientToScreen(IntPtr hWnd, ref POINT p);

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X; public int Y; }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr hWnd, StringBuilder sb, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassNameW(IntPtr hWnd, StringBuilder sb, int max);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] private static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr hWnd, IntPtr hdc);
    [DllImport("gdi32.dll")] private static extern int GetDeviceCaps(IntPtr hdc, int index);
    [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint nInputs, INPUT[] inputs, int cbSize);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);

    private const int LOGPIXELSX = 88;
    private const uint PW_RENDERFULLCONTENT = 2;
    private const uint INPUT_KEYBOARD = 1;
    private const uint INPUT_MOUSE = 0;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_UNICODE = 0x0004;
    private const uint MOUSEEVENTF_WHEEL = 0x0800;
    private const ushort VK_SHIFT = 0x10;
    private const ushort VK_CONTROL = 0x11;
    private const ushort VK_MENU = 0x12;   // Alt
    private const ushort VK_LWIN = 0x5B;

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT { public uint type; public InputUnion u; }

    // ------------------------------------------------------------------ state
    private static IntPtr _found;
    private static int _best;
    private static uint _wantPid;
    private static string _wantTitle;

    private static bool EnumCallback(IntPtr h, IntPtr l)
    {
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        if (!IsWindowVisible(h)) { return true; }
        if (_wantPid != 0 && pid != _wantPid) { return true; }
        if (_wantTitle != null)
        {
            string t = TextOf(h);
            if (t == null) { return true; }
            if (t.ToLowerInvariant().IndexOf(_wantTitle.ToLowerInvariant()) < 0) { return true; }
        }
        RECT r;
        GetWindowRect(h, out r);
        int area = (r.Right - r.Left) * (r.Bottom - r.Top);
        if (area > _best) { _best = area; _found = h; }
        return true;
    }

    public static void Init()
    {
        try { SetProcessDPIAware(); } catch (Exception) { }
    }

    public static string TextOf(IntPtr hWnd)
    {
        StringBuilder sb = new StringBuilder(512);
        GetWindowTextW(hWnd, sb, sb.Capacity);
        return sb.ToString();
    }

    public static string ClassOf(IntPtr hWnd)
    {
        StringBuilder sb = new StringBuilder(256);
        GetClassNameW(hWnd, sb, sb.Capacity);
        return sb.ToString();
    }

    public static int[] RectOf(IntPtr hWnd)
    {
        RECT r;
        GetWindowRect(hWnd, out r);
        int[] a = new int[4];
        a[0] = r.Left; a[1] = r.Top; a[2] = r.Right - r.Left; a[3] = r.Bottom - r.Top;
        return a;
    }

    public static int ScreenDpi()
    {
        IntPtr dc = GetDC(IntPtr.Zero);
        int dpi = 96;
        try { dpi = GetDeviceCaps(dc, LOGPIXELSX); }
        finally { if (dc != IntPtr.Zero) { ReleaseDC(IntPtr.Zero, dc); } }
        if (dpi <= 0) { dpi = 96; }
        return dpi;
    }

    /// <summary>Screen coordinates of the client area origin, expressed as an
    /// offset from the window origin. UIA rectangles are in screen coordinates
    /// inside the client area, while a PrintWindow bitmap is anchored at the
    /// window origin, so this offset is required to compare the two.</summary>
    public static int[] ClientOriginOffset(IntPtr hWnd)
    {
        RECT cr;
        GetClientRect(hWnd, out cr);
        POINT p = new POINT();
        p.X = 0;
        p.Y = 0;
        ClientToScreen(hWnd, ref p);
        int[] wr = RectOf(hWnd);
        int[] a = new int[4];
        a[0] = p.X - wr[0];
        a[1] = p.Y - wr[1];
        a[2] = cr.Right - cr.Left;
        a[3] = cr.Bottom - cr.Top;
        return a;
    }

    public static IntPtr FindWindow(int pid, string titleLike)
    {
        _found = IntPtr.Zero;
        _best = 0;
        _wantPid = (uint)pid;
        _wantTitle = (titleLike == null || titleLike.Length == 0) ? null : titleLike;
        EnumWindows(new EnumProc(EnumCallback), IntPtr.Zero);
        return _found;
    }

    public static void Activate(IntPtr hWnd)
    {
        ShowWindow(hWnd, 5);              // SW_SHOW
        SetForegroundWindow(hWnd);
    }

    // ------------------------------------------------------------------ launch
    public static Process Launch(string exe, string workDir, string exeArgs)
    {
        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = exe;
        psi.UseShellExecute = false;
        if (workDir != null && workDir.Length > 0) { psi.WorkingDirectory = workDir; }
        if (exeArgs != null && exeArgs.Length > 0) { psi.Arguments = exeArgs; }
        return Process.Start(psi);
    }

    public static string Kill(int pid)
    {
        try
        {
            Process p = Process.GetProcessById(pid);
            p.Kill();
            p.WaitForExit(5000);
            return "killed";
        }
        catch (ArgumentException) { return "not-running"; }
        catch (Exception ex) { return "kill-error: " + ex.Message; }
    }

    public static bool Alive(int pid)
    {
        try
        {
            Process p = Process.GetProcessById(pid);
            return !p.HasExited;
        }
        catch (Exception) { return false; }
    }

    // ------------------------------------------------------------------- input
    private static ushort VkFor(string name)
    {
        if (name == null) { return 0; }
        string n = name.Trim().ToUpperInvariant();
        if (n.Length == 0) { return 0; }
        if (n == "TAB") { return 0x09; }
        if (n == "ESC" || n == "ESCAPE") { return 0x1B; }
        if (n == "ENTER" || n == "RETURN") { return 0x0D; }
        if (n == "SPACE") { return 0x20; }
        if (n == "BACK") { return 0x08; }
        if (n == "DELETE" || n == "DEL") { return 0x2E; }
        if (n == "UP") { return 0x26; }
        if (n == "DOWN") { return 0x28; }
        if (n == "LEFT") { return 0x25; }
        if (n == "RIGHT") { return 0x27; }
        if (n == "HOME") { return 0x24; }
        if (n == "END") { return 0x23; }
        if (n == "PAGEUP") { return 0x21; }
        if (n == "PAGEDOWN") { return 0x22; }
        if (n == "F1") { return 0x70; }
        if (n == "F2") { return 0x71; }
        if (n == "F3") { return 0x72; }
        if (n == "F4") { return 0x73; }
        if (n == "F5") { return 0x74; }
        if (n == "F6") { return 0x75; }
        if (n == "F7") { return 0x76; }
        if (n == "F8") { return 0x77; }
        if (n == "F9") { return 0x78; }
        if (n == "F10") { return 0x79; }
        if (n == "F11") { return 0x7A; }
        if (n == "F12") { return 0x7B; }
        if (n.Length == 1)
        {
            char c = n[0];
            if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) { return (ushort)c; }
        }
        return 0;
    }

    private static INPUT KeyInput(ushort vk, bool up)
    {
        INPUT i = new INPUT();
        i.type = INPUT_KEYBOARD;
        i.u.ki.wVk = vk;
        i.u.ki.wScan = 0;
        i.u.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
        i.u.ki.time = 0;
        i.u.ki.dwExtraInfo = IntPtr.Zero;
        return i;
    }

    /// <summary>Sends a chord such as "Ctrl+Shift+T", "Tab", "Alt+F4", "F10".</summary>
    public static string Key(string chord)
    {
        if (chord == null || chord.Trim().Length == 0) { return "no-key"; }
        string[] parts = chord.Split('+');
        List<ushort> mods = new List<ushort>();
        ushort main = 0;
        for (int i = 0; i < parts.Length; i++)
        {
            string p = parts[i].Trim();
            string u = p.ToUpperInvariant();
            if (u == "CTRL" || u == "CONTROL") { mods.Add(VK_CONTROL); continue; }
            if (u == "SHIFT") { mods.Add(VK_SHIFT); continue; }
            if (u == "ALT" || u == "MENU") { mods.Add(VK_MENU); continue; }
            if (u == "WIN" || u == "LWIN") { mods.Add(VK_LWIN); continue; }
            ushort vk = VkFor(p);
            if (vk == 0) { return "unknown-key: " + p; }
            main = vk;
        }
        if (main == 0) { return "no-main-key: " + chord; }

        List<INPUT> seq = new List<INPUT>();
        for (int i = 0; i < mods.Count; i++) { seq.Add(KeyInput(mods[i], false)); }
        seq.Add(KeyInput(main, false));
        seq.Add(KeyInput(main, true));
        for (int i = mods.Count - 1; i >= 0; i--) { seq.Add(KeyInput(mods[i], true)); }
        INPUT[] arr = seq.ToArray();
        uint sent = SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(INPUT)));
        if (sent != (uint)arr.Length) { return "sendinput-partial: " + sent + "/" + arr.Length; }
        return "ok";
    }

    /// <summary>Types arbitrary text through KEYEVENTF_UNICODE (independent of layout).</summary>
    public static string Text(string s)
    {
        if (s == null || s.Length == 0) { return "empty"; }
        int sent = 0;
        for (int i = 0; i < s.Length; i++)
        {
            char c = s[i];
            INPUT down = new INPUT();
            down.type = INPUT_KEYBOARD;
            down.u.ki.wVk = 0;
            down.u.ki.wScan = (ushort)c;
            down.u.ki.dwFlags = KEYEVENTF_UNICODE;
            down.u.ki.dwExtraInfo = IntPtr.Zero;
            INPUT up = down;
            up.u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
            INPUT[] pair = new INPUT[] { down, up };
            uint r = SendInput(2, pair, Marshal.SizeOf(typeof(INPUT)));
            if (r == 2) { sent++; }
            Thread.Sleep(12);
        }
        return "typed " + sent + "/" + s.Length;
    }

    [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] private static extern void mouse_event(uint flags, int dx, int dy, uint data, IntPtr extra);

    /// <summary>Moves the physical cursor. Coordinates are window-local and stay
    /// correct under non-100% scaling because the process is DPI aware.</summary>
    public static string MoveTo(IntPtr hWnd, int localX, int localY)
    {
        int[] r = RectOf(hWnd);
        int sx = r[0] + localX;
        int sy = r[1] + localY;
        if (!SetCursorPos(sx, sy)) { return "setcursorpos-failed"; }
        Thread.Sleep(120);
        mouse_event(0x0001, 0, 0, 0, IntPtr.Zero);   // MOUSEEVENTF_MOVE
        return "ok";
    }

    public static string Click(IntPtr hWnd, int localX, int localY, string button)
    {
        string mv = MoveTo(hWnd, localX, localY);
        if (mv != "ok") { return mv; }
        Thread.Sleep(80);
        if (button != null && button.ToLowerInvariant() == "right") { mouse_event(0x0008, 0, 0, 0, IntPtr.Zero); mouse_event(0x0010, 0, 0, 0, IntPtr.Zero); }
        else { mouse_event(0x0002, 0, 0, 0, IntPtr.Zero); mouse_event(0x0004, 0, 0, 0, IntPtr.Zero); }
        Thread.Sleep(150);
        return "ok";
    }

    public static string Wheel(IntPtr hWnd, int delta)
    {
        mouse_event(MOUSEEVENTF_WHEEL, 0, 0, unchecked((uint)delta), IntPtr.Zero);
        Thread.Sleep(200);
        return "ok";
    }

    public static string SetForeground(IntPtr hWnd)
    {
        bool ok = SetForegroundWindow(hWnd);
        Thread.Sleep(250);
        return ok ? "ok" : "setforegroundwindow-returned-false";
    }

    public static string BroadcastSettingChange()
    {
        UIntPtr res;
        IntPtr r = SendMessageTimeout(new IntPtr(0xFFFF), 0x001A, UIntPtr.Zero, "ImmersiveColorSet", 2, 3000, out res);
        return (r == IntPtr.Zero) ? "broadcast-timeout" : "ok";
    }

    // --------------------------------------------------------------- capture
    /// <summary>Captures the window with PW_RENDERFULLCONTENT (needed for
    /// DirectComposition / WinUI 3 content) and writes a PNG. Returns "ok" or a
    /// short error code. Self-check statistics are produced by ImageStats.</summary>
    public static string CaptureToPng(IntPtr hWnd, string path)
    {
        int[] r = RectOf(hWnd);
        int w = r[2];
        int h = r[3];
        if (w <= 0 || h <= 0) { return "bad-window-bounds"; }

        string dir = Path.GetDirectoryName(path);
        if (dir != null && dir.Length > 0 && !Directory.Exists(dir)) { Directory.CreateDirectory(dir); }

        using (Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb))
        {
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.Clear(Color.White);
                IntPtr hdc = g.GetHdc();
                bool ok;
                try { ok = PrintWindow(hWnd, hdc, PW_RENDERFULLCONTENT); }
                finally { g.ReleaseHdc(hdc); }
                if (!ok) { return "printwindow-failed"; }
            }
            bmp.Save(path, ImageFormat.Png);
        }
        return "ok";
    }

    public static string Sha256OfFile(string path)
    {
        if (path == null || !File.Exists(path)) { return ""; }
        using (System.Security.Cryptography.SHA256 sha = System.Security.Cryptography.SHA256.Create())
        {
            using (FileStream fs = File.OpenRead(path))
            {
                byte[] hash = sha.ComputeHash(fs);
                StringBuilder sb = new StringBuilder();
                for (int i = 0; i < hash.Length; i++) { sb.Append(hash[i].ToString("x2", CultureInfo.InvariantCulture)); }
                return sb.ToString();
            }
        }
    }

    // ------------------------------------------------------------------- UIA
    public static string UiaDump(IntPtr hWnd, int maxDepth, int maxNodes)
    {
        // Node rectangles are reported relative to the WINDOW origin, which is
        // exactly the origin of the PrintWindow bitmap. UI Automation itself
        // reports screen coordinates, so the window origin is subtracted here;
        // without that shift, comparisons against the PNG are off by the window
        // position and produce nonsense.
        int[] wr = RectOf(hWnd);
        int ox = wr[0];
        int oy = wr[1];

        AutomationElement root;
        Exception last = null;
        root = null;
        for (int attempt = 0; attempt < 3; attempt++)
        {
            try { root = AutomationElement.FromHandle(hWnd); last = null; }
            catch (Exception ex) { last = ex; root = null; }
            if (root != null) { break; }
            Thread.Sleep(700);
        }
        if (root == null)
        {
            StringBuilder err = new StringBuilder();
            err.Append("{\"available\":false,\"reason\":\"");
            err.Append(JsonEscape(last == null ? "FromHandle returned null" : last.GetType().Name + ": " + last.Message));
            err.Append("\"}");
            return err.ToString();
        }

        List<string> nodes = new List<string>();
        int truncated = 0;
        int totalSeen = 0;
        // BFS with an explicit parent index per node. The tree is walked once, so
        // the recorded ancestry is real; an earlier draft guessed the parent from
        // the nearest preceding node with a lower depth, which silently produced
        // bogus parents for flattened views and must never be reintroduced.
        Queue<object[]> queue = new Queue<object[]>();
        queue.Enqueue(new object[] { root, 0, -1 });
        while (queue.Count > 0)
        {
            object[] item = queue.Dequeue();
            AutomationElement el = (AutomationElement)item[0];
            int depth = (int)item[1];
            int parentIndex = (int)item[2];
            totalSeen++;
            int selfIndex = -1;
            if (nodes.Count < maxNodes)
            {
                selfIndex = nodes.Count;
                nodes.Add(NodeJson(el, depth, selfIndex, parentIndex, ox, oy));
            }
            else
            {
                truncated++;
                continue;
            }
            if (depth >= maxDepth) { continue; }
            AutomationElement child = TreeWalker.ControlViewWalker.GetFirstChild(el);
            int guard = 0;
            while (child != null && guard < 400)
            {
                queue.Enqueue(new object[] { child, depth + 1, selfIndex });
                child = TreeWalker.ControlViewWalker.GetNextSibling(child);
                guard++;
            }
        }

        StringBuilder sb = new StringBuilder();
        sb.Append("{\"available\":true,\"coordinateFrame\":\"window-relative (0,0 = top-left of the captured PNG)\"");
        sb.Append(",\"windowOriginScreen\":[" + ox.ToString(CultureInfo.InvariantCulture) + "," + oy.ToString(CultureInfo.InvariantCulture) + "]");
        sb.Append(",\"totalSeen\":");
        sb.Append(totalSeen.ToString(CultureInfo.InvariantCulture));
        sb.Append(",\"nodeCount\":");
        sb.Append(nodes.Count.ToString(CultureInfo.InvariantCulture));
        sb.Append(",\"truncatedCount\":");
        sb.Append(truncated.ToString(CultureInfo.InvariantCulture));
        sb.Append(",\"maxDepth\":");
        sb.Append(maxDepth.ToString(CultureInfo.InvariantCulture));
        sb.Append(",\"nodes\":[");
        for (int i = 0; i < nodes.Count; i++)
        {
            if (i > 0) { sb.Append(","); }
            sb.Append(nodes[i]);
        }
        sb.Append("]}");
        return sb.ToString();
    }

    private static string NodeJson(AutomationElement el, int depth, int index, int parentIndex, int originX, int originY)
    {
        StringBuilder sb = new StringBuilder();
        sb.Append("{\"i\":");
        sb.Append(index.ToString(CultureInfo.InvariantCulture));
        sb.Append(",\"p\":");
        sb.Append(parentIndex.ToString(CultureInfo.InvariantCulture));
        sb.Append(",\"d\":");
        sb.Append(depth.ToString(CultureInfo.InvariantCulture));
        string name = null;
        string aid = null;
        string ct = null;
        string cls = null;
        bool enabled = false;
        bool focus = false;
        bool offscreen = false;
        double x = 0, y = 0, w = 0, h = 0;
        try
        {
            AutomationElement.AutomationElementInformation cur = el.Current;
            name = cur.Name;
            aid = cur.AutomationId;
            ct = cur.ControlType == null ? null : cur.ControlType.ProgrammaticName;
            cls = cur.ClassName;
            enabled = cur.IsEnabled;
            focus = cur.HasKeyboardFocus;
            offscreen = cur.IsOffscreen;
            System.Windows.Rect rc = cur.BoundingRectangle;
            x = rc.X - originX; y = rc.Y - originY; w = rc.Width; h = rc.Height;
        }
        catch (Exception ex)
        {
            sb.Append(",\"elementError\":\"" + JsonEscape(ex.GetType().Name) + "\"");
        }
        sb.Append(",\"ct\":\"" + JsonEscape(ct) + "\"");
        sb.Append(",\"name\":\"" + JsonEscape(name) + "\"");
        sb.Append(",\"aid\":\"" + JsonEscape(aid) + "\"");
        sb.Append(",\"cls\":\"" + JsonEscape(cls) + "\"");
        sb.Append(",\"enabled\":" + (enabled ? "true" : "false"));
        sb.Append(",\"focus\":" + (focus ? "true" : "false"));
        sb.Append(",\"offscreen\":" + (offscreen ? "true" : "false"));
        sb.Append(",\"x\":" + Num(x) + ",\"y\":" + Num(y) + ",\"w\":" + Num(w) + ",\"h\":" + Num(h));
        sb.Append("}");
        return sb.ToString();
    }

    private static string Num(double d)
    {
        // Offscreen UIA elements report empty rectangles, which surface as NaN or
        // Infinity. Emitting those verbatim would put the non-standard JSON
        // tokens NaN/Infinity into the report, so clamp them to a sentinel.
        if (double.IsNaN(d) || double.IsInfinity(d)) { return "-1"; }
        return Math.Round(d, 2).ToString(CultureInfo.InvariantCulture);
    }

    /// <summary>Higher precision for ratios: two decimals would turn a real but
    /// small pixel change (for example 844 of 836000 pixels) into "0", which
    /// would make a measurable difference look like no difference at all.</summary>
    private static string Ratio(double d)
    {
        return Math.Round(d, 6).ToString(CultureInfo.InvariantCulture);
    }

    public static string JsonEscape(string s)
    {
        if (s == null) { return ""; }
        StringBuilder sb = new StringBuilder(s.Length + 8);
        for (int i = 0; i < s.Length; i++)
        {
            char c = s[i];
            if (c == '"') { sb.Append("\\\""); }
            else if (c == '\\') { sb.Append("\\\\"); }
            else if (c == '\n') { sb.Append("\\n"); }
            else if (c == '\r') { sb.Append("\\r"); }
            else if (c == '\t') { sb.Append("\\t"); }
            else if (c < 0x20 || c > 0x7E) { sb.Append("\\u" + ((int)c).ToString("x4", CultureInfo.InvariantCulture)); }
            else { sb.Append(c); }
        }
        return sb.ToString();
    }

    // --------------------------------------------------------- image analysis
    /// <summary>Pixel-level statistics of a PNG. Returns a JSON object string.
    /// All fields are measurements; no pass/fail judgement is made here.</summary>
    public static string ImageStats(string path)
    {
        if (path == null || !File.Exists(path))
        {
            return "{\"ok\":false,\"reason\":\"file-not-found\"}";
        }
        Bitmap bmp = new Bitmap(path);
        try
        {
            int w = bmp.Width;
            int h = bmp.Height;
            int stride;
            byte[] data = ReadArgb(bmp, out stride);
            int total = w * h;

            HashSet<int> quantized = new HashSet<int>();
            HashSet<int> quantizedContent = new HashSet<int>();
            Dictionary<int, int> histogram = new Dictionary<int, int>();
            long sumLuma = 0;
            int blackish = 0;
            int contentTop = (int)Math.Round(48.0 * ((double)Math.Min(w, h) / 760.0));
            if (contentTop > h / 3) { contentTop = h / 3; }
            int contentHeight = h - contentTop;

            for (int y = 0; y < h; y++)
            {
                int row = y * stride;
                for (int x = 0; x < w; x++)
                {
                    int o = row + x * 4;
                    int b = data[o];
                    int g = data[o + 1];
                    int r = data[o + 2];
                    int q = (r >> 4) * 256 + (g >> 4) * 16 + (b >> 4);
                    quantized.Add(q);
                    if (y >= contentTop) { quantizedContent.Add(q); }
                    int luma = (int)(0.2126 * r + 0.7152 * g + 0.0722 * b);
                    sumLuma += luma;
                    if (r <= 8 && g <= 8 && b <= 8) { blackish++; }
                    if (luma <= 8) { continue; }
                    int key = q;
                    if (histogram.ContainsKey(key)) { histogram[key] = histogram[key] + 1; }
                    else { histogram[key] = 1; }
                }
            }

            int bgKey = -1;
            int bgCount = 0;
            Dictionary<int, int>.Enumerator en = histogram.GetEnumerator();
            while (en.MoveNext())
            {
                if (en.Current.Value > bgCount) { bgCount = en.Current.Value; bgKey = en.Current.Key; }
            }
            int bgB = (bgKey & 0xF) * 17;
            int bgG = ((bgKey >> 4) & 0xF) * 17;
            int bgR = ((bgKey >> 8) & 0xF) * 17;

            int nonBg = 0;
            long nonBgLumaSum = 0;
            int distinctExact = 0;
            HashSet<int> exact = new HashSet<int>();
            List<int> contentLuma = new List<int>();
            for (int y = 0; y < h; y += (h > 400 ? 2 : 1))
            {
                int row = y * stride;
                for (int x = 0; x < w; x += (w > 400 ? 2 : 1))
                {
                    int o = row + x * 4;
                    int b = data[o];
                    int g = data[o + 1];
                    int r = data[o + 2];
                    exact.Add((r << 16) | (g << 8) | b);
                    distinctExact++;
                    int luma = (int)(0.2126 * r + 0.7152 * g + 0.0722 * b);
                    int d = Math.Abs(r - bgR) + Math.Abs(g - bgG) + Math.Abs(b - bgB);
                    if (d > 24)
                    {
                        nonBg++;
                        nonBgLumaSum += luma;
                        contentLuma.Add(luma);
                    }
                }
            }
            distinctExact = exact.Count;
            int sampledPixels = 0;
            for (int y = 0; y < h; y += (h > 400 ? 2 : 1))
            {
                for (int x = 0; x < w; x += (w > 400 ? 2 : 1)) { sampledPixels++; }
            }
            double nonBgRatio = sampledPixels == 0 ? 0.0 : (double)nonBg / (double)sampledPixels;
            double meanLuma = (double)sumLuma / (double)total;

            int p05 = 0;
            int p995 = 0;
            if (contentLuma.Count > 0)
            {
                contentLuma.Sort();
                p05 = contentLuma[(int)(contentLuma.Count * 0.005)];
                p995 = contentLuma[(int)((contentLuma.Count - 1) * 0.995)];
            }

            // Horizontal/vertical content bounds. The window frame drawn by the
            // OS is excluded first (detected as a uniform dark border band), then
            // the first/last row/column that contains a non-background pixel is
            // reported. Values are advisory evidence, never a pass/fail by
            // themselves: a full-bleed background paints to the very edge.
            int inset = DetectFrameInset(data, stride, w, h, contentTop, bgR, bgG, bgB);
            int firstCol = -1;
            int lastCol = -1;
            int firstRow = -1;
            int lastRow = -1;
            for (int x = inset; x < w - inset; x++)
            {
                bool hit = false;
                for (int y = contentTop; y < h - inset; y += 2)
                {
                    int o = y * stride + x * 4;
                    int b = data[o];
                    int g = data[o + 1];
                    int r = data[o + 2];
                    int d = Math.Abs(r - bgR) + Math.Abs(g - bgG) + Math.Abs(b - bgB);
                    if (d > 24) { hit = true; break; }
                }
                if (hit) { if (firstCol < 0) { firstCol = x; } lastCol = x; }
            }
            for (int y = inset; y < h - inset; y++)
            {
                bool hit = false;
                for (int x = inset; x < w - inset; x += 2)
                {
                    int o = y * stride + x * 4;
                    int b = data[o];
                    int g = data[o + 1];
                    int r = data[o + 2];
                    int d = Math.Abs(r - bgR) + Math.Abs(g - bgG) + Math.Abs(b - bgB);
                    if (d > 24) { hit = true; break; }
                }
                if (hit) { if (firstRow < 0) { firstRow = y; } lastRow = y; }
            }

            int leftMargin = firstCol < 0 ? -1 : firstCol - inset;
            int rightMargin = lastCol < 0 ? -1 : (w - 1 - inset) - lastCol;

            StringBuilder sb = new StringBuilder();
            sb.Append("{\"ok\":true,\"path\":\"" + JsonEscape(path) + "\"");
            sb.Append(",\"width\":" + w.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"height\":" + h.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"distinctColorsExact\":" + distinctExact.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"distinctColorsQuantized\":" + quantized.Count.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"distinctColorsQuantizedContentArea\":" + quantizedContent.Count.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"contentAreaTop\":" + contentTop.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"blackishPixelRatio\":" + Ratio((double)blackish / (double)total));
            sb.Append(",\"backgroundRgb\":[" + bgR.ToString(CultureInfo.InvariantCulture) + "," + bgG.ToString(CultureInfo.InvariantCulture) + "," + bgB.ToString(CultureInfo.InvariantCulture) + "]");
            sb.Append(",\"backgroundShare\":" + Ratio((double)bgCount / (double)Math.Max(1, total - blackish)));
            sb.Append(",\"nonBackgroundPixelRatio\":" + Ratio(nonBgRatio));
            sb.Append(",\"meanLuma\":" + Num(meanLuma));
            sb.Append(",\"contentLumaP05\":" + p05.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"contentLumaP995\":" + p995.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"contentLumaSpread\":" + (p995 - p05).ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"frameInsetPx\":" + inset.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"contentFirstColumn\":" + firstCol.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"contentLastColumn\":" + lastCol.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"contentFirstRow\":" + firstRow.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"contentLastRow\":" + lastRow.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"leftMarginPx\":" + leftMargin.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"rightMarginPx\":" + rightMargin.ToString(CultureInfo.InvariantCulture));
            sb.Append("}");
            return sb.ToString();
        }
        finally
        {
            bmp.Dispose();
        }
    }

    /// <summary>Pixel-diff two PNGs of identical size. Returns JSON.</summary>
    public static string ImageDiff(string pathA, string pathB, int threshold)
    {
        if (!File.Exists(pathA) || !File.Exists(pathB))
        {
            return "{\"ok\":false,\"reason\":\"file-not-found\"}";
        }
        Bitmap a = new Bitmap(pathA);
        Bitmap b = new Bitmap(pathB);
        try
        {
            if (a.Width != b.Width || a.Height != b.Height)
            {
                return "{\"ok\":false,\"reason\":\"size-mismatch\",\"a\":\"" + a.Width + "x" + a.Height + "\",\"b\":\"" + b.Width + "x" + b.Height + "\"}";
            }
            int strideA, strideB;
            byte[] da = ReadArgb(a, out strideA);
            byte[] db = ReadArgb(b, out strideB);
            int w = a.Width;
            int h = a.Height;
            long changed = 0;
            long maxDelta = 0;
            long sumDelta = 0;
            int minX = w, minY = h, maxX = -1, maxY = -1;
            for (int y = 0; y < h; y++)
            {
                int ra = y * strideA;
                int rb = y * strideB;
                for (int x = 0; x < w; x++)
                {
                    int oa = ra + x * 4;
                    int ob = rb + x * 4;
                    int d = Math.Abs(da[oa] - db[ob]) + Math.Abs(da[oa + 1] - db[ob + 1]) + Math.Abs(da[oa + 2] - db[ob + 2]);
                    sumDelta += d;
                    if (d > maxDelta) { maxDelta = d; }
                    if (d > threshold)
                    {
                        changed++;
                        if (x < minX) { minX = x; }
                        if (y < minY) { minY = y; }
                        if (x > maxX) { maxX = x; }
                        if (y > maxY) { maxY = y; }
                    }
                }
            }
            long total = (long)w * (long)h;
            StringBuilder sb = new StringBuilder();
            sb.Append("{\"ok\":true,\"threshold\":" + threshold.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"changedPixelRatio\":" + Ratio((double)changed / (double)total));
            sb.Append(",\"changedPixels\":" + changed.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"totalPixels\":" + total.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"maxChannelSumDelta\":" + maxDelta.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"meanChannelSumDelta\":" + Ratio((double)sumDelta / (double)total));
            if (maxX >= 0)
            {
                sb.Append(",\"changedBox\":[" + minX + "," + minY + "," + (maxX - minX + 1) + "," + (maxY - minY + 1) + "]");
            }
            else
            {
                sb.Append(",\"changedBox\":null");
            }
            sb.Append("}");
            return sb.ToString();
        }
        finally
        {
            a.Dispose();
            b.Dispose();
        }
    }

    /// <summary>Detects the thickness of the uniform window frame that the OS
    /// paints into a PrintWindow capture, so content bounds are not measured
    /// against that frame. Only applied when BOTH the left and the right edge
    /// look like a frame, and capped at 24 px / one eighth of the width.</summary>
    private static int DetectFrameInset(byte[] data, int stride, int w, int h, int contentTop, int bgR, int bgG, int bgB)
    {
        int cap = Math.Min(24, w / 8);
        if (cap < 1) { return 0; }
        int left = 0;
        for (int i = 0; i < cap; i++)
        {
            if (!IsFrameColumn(data, stride, w, h, i, contentTop, bgR, bgG, bgB)) { break; }
            left = i + 1;
        }
        int right = 0;
        for (int i = 0; i < cap; i++)
        {
            if (!IsFrameColumn(data, stride, w, h, w - 1 - i, contentTop, bgR, bgG, bgB)) { break; }
            right = i + 1;
        }
        if (left > 0 && right > 0) { return Math.Max(left, right); }
        return 0;
    }

    /// <summary>A band counts as frame when it is mostly dark and clearly
    /// different from the measured background.</summary>
    private static bool IsFrameColumn(byte[] data, int stride, int w, int h, int x, int contentTop, int bgR, int bgG, int bgB)
    {
        int dark = 0;
        int sampled = 0;
        for (int y = contentTop; y < h; y += 4)
        {
            int o = y * stride + x * 4;
            int b = data[o];
            int g = data[o + 1];
            int r = data[o + 2];
            int luma = (int)(0.2126 * r + 0.7152 * g + 0.0722 * b);
            if (Math.Abs(r - bgR) + Math.Abs(g - bgG) + Math.Abs(b - bgB) > 24 && luma <= 40) { dark++; }
            sampled++;
        }
        if (sampled == 0) { return false; }
        return ((double)dark / (double)sampled) > 0.6;
    }

    /// <summary>Locks a bitmap and copies it to a tightly packed BGRA byte array.</summary>
    private static byte[] ReadArgb(Bitmap bmp, out int stride)
    {
        int w = bmp.Width;
        int h = bmp.Height;
        BitmapData bd = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try
        {
            int srcStride = bd.Stride;
            byte[] packed = new byte[w * h * 4];
            for (int y = 0; y < h; y++)
            {
                IntPtr src = new IntPtr(bd.Scan0.ToInt64() + (long)y * (long)srcStride);
                Marshal.Copy(src, packed, y * w * 4, w * 4);
            }
            stride = w * 4;
            return packed;
        }
        finally
        {
            bmp.UnlockBits(bd);
        }
    }
}
'@

    Add-Type -TypeDefinition $source -ReferencedAssemblies 'System.Drawing', 'UIAutomationClient', 'UIAutomationTypes', 'WindowsBase', 'System.Core'
    [WinAuditCore]::Init() | Out-Null
    $script:WinAuditCoreLoaded = $true
}

# --------------------------------------------------------------- PS wrappers

function Get-WinAuditImageStats {
    <#  Returns a PSCustomObject with pixel statistics for a PNG, or $null on failure. #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)

    Initialize-WinAuditCore
    $json = [WinAuditCore]::ImageStats($Path)
    $obj = $json | ConvertFrom-Json
    if (-not $obj.ok) { return $null }
    return $obj
}

function Compare-WinAuditImage {
    <#  Returns a PSCustomObject describing the pixel diff between two PNGs. #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$A,
        [Parameter(Mandatory = $true)][string]$B,
        [int]$Threshold = 24
    )

    Initialize-WinAuditCore
    $json = [WinAuditCore]::ImageDiff($A, $B, $Threshold)
    return ($json | ConvertFrom-Json)
}

function Get-WinAuditUiaDump {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][IntPtr]$Hwnd,
        [int]$MaxDepth = 12,
        [int]$MaxNodes = 400
    )

    Initialize-WinAuditCore
    $json = [WinAuditCore]::UiaDump($Hwnd, $MaxDepth, $MaxNodes)
    return ($json | ConvertFrom-Json)
}

function WinAudit-GetImageHash {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)
    Initialize-WinAuditCore
    return [WinAuditCore]::Sha256OfFile($Path)
}

function WinAudit-GetTextHash {
    <#  Stable content hash of a text file (used for traceability of the spec). #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes((Get-Content -LiteralPath $Path -Raw))
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash($bytes)
        $sb = New-Object System.Text.StringBuilder
        foreach ($b in $hash) { [void]$sb.Append($b.ToString('x2')) }
        return $sb.ToString()
    } finally { $sha.Dispose() }
}

function WinAudit-GetSystemAppTheme {
    <#  Reads HKCU AppsUseLightTheme. Returns $true for light, $false for dark, $null if unreadable. #>
    [CmdletBinding()]
    param()
    try {
        $v = Get-ItemProperty -Path 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name 'AppsUseLightTheme' -ErrorAction Stop
        return [bool]($v.AppsUseLightTheme -eq 1)
    } catch {
        return $null
    }
}

function WinAudit-SetSystemAppTheme {
    <#  Sets HKCU AppsUseLightTheme and broadcasts a settings change.
        RETURNS a hashtable: @{ Ok = bool; Previous = bool|null; Reason = string }
        CALLERS MUST RESTORE the previous value; this changes a user setting. #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][bool]$Light)

    Initialize-WinAuditCore
    $prev = WinAudit-GetSystemAppTheme
    $desired = 1
    if (-not $Light) { $desired = 0 }
    try {
        Set-ItemProperty -Path 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Themes\Personalize' `
            -Name 'AppsUseLightTheme' -Value $desired -Type DWord -ErrorAction Stop
        [void][WinAuditCore]::BroadcastSettingChange()
        Start-Sleep -Milliseconds 600
        $now = WinAudit-GetSystemAppTheme
        if ($now -eq $Light) {
            return @{ Ok = $true; Previous = $prev; Reason = 'applied' }
        }
        return @{ Ok = $false; Previous = $prev; Reason = 'registry-write-did-not-stick' }
    } catch {
        return @{ Ok = $false; Previous = $prev; Reason = ('registry-write-failed: ' + $_.Exception.Message) }
    }
}

function WinAudit-RestoreSystemAppTheme {
    [CmdletBinding()]
    param([AllowNull()]$Previous)
    if ($null -eq $Previous) { return $false }
    $r = WinAudit-SetSystemAppTheme -Light ([bool]$Previous)
    return $r.Ok
}

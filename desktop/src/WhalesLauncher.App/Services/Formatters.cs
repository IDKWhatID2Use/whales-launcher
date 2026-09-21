using System.Globalization;

namespace WhalesLauncher.Services;

/// <summary>
/// 时间 / 体积 / 路径格式化（中文，桌面端习惯）。
///
/// 逐行移植自旧实现 <c>src/renderer/util/format.ts</c>：刻意**不用**文化敏感格式化（不用 Intl 等价物），
/// 以保证与旧版输出逐字一致 —— 这样审计时可以拿新旧截图直接对比，不会因格式化差异产生噪声。
/// </summary>
public static class Formatters
{
    private static string Pad(int n) => n < 10 ? "0" + n.ToString(CultureInfo.InvariantCulture) : n.ToString(CultureInfo.InvariantCulture);

    /// <summary>`2025-06-01 14:32`；无法解析返回 `—`。</summary>
    public static string FormatDateTime(string? iso)
    {
        var d = ParseLocal(iso);
        if (d is null) return "—";
        var v = d.Value;
        return $"{v.Year}-{Pad(v.Month)}-{Pad(v.Day)} {Pad(v.Hour)}:{Pad(v.Minute)}";
    }

    /// <summary>`2025-06-01`。</summary>
    public static string FormatDate(string? iso)
    {
        var d = ParseLocal(iso);
        if (d is null) return "—";
        var v = d.Value;
        return $"{v.Year}-{Pad(v.Month)}-{Pad(v.Day)}";
    }

    /// <summary>`14:32:07`；无法解析返回 `--:--:--`。</summary>
    public static string FormatClock(string? iso)
    {
        var d = ParseLocal(iso);
        if (d is null) return "--:--:--";
        var v = d.Value;
        return $"{Pad(v.Hour)}:{Pad(v.Minute)}:{Pad(v.Second)}";
    }

    /// <summary>相对时间：刚刚 / 3 分钟前 / 2 小时前 / 昨天 14:32 / 3 天前 / 2025-01-02。</summary>
    public static string FormatRelative(string? iso, DateTimeOffset? now = null)
    {
        var parsed = ParseOffset(iso);
        if (parsed is null) return "从未启动";

        var current = now ?? DateTimeOffset.Now;
        var diffMs = current.ToUnixTimeMilliseconds() - parsed.Value.ToUnixTimeMilliseconds();
        if (diffMs < 0) return "刚刚";

        var sec = diffMs / 1000;
        if (sec < 60) return "刚刚";

        var min = sec / 60;
        if (min < 60) return $"{min} 分钟前";

        var hour = min / 60;
        if (hour < 24) return $"{hour} 小时前";

        var day = hour / 24;
        var localNow = current.LocalDateTime;
        var startOfToday = localNow.Date;
        var localParsed = parsed.Value.LocalDateTime;

        if (localParsed >= startOfToday.AddDays(-1))
        {
            if (localParsed >= startOfToday) return $"{hour} 小时前";
            return $"昨天 {Pad(localParsed.Hour)}:{Pad(localParsed.Minute)}";
        }

        if (day < 30) return $"{day} 天前";
        return FormatDate(iso);
    }

    /// <summary>运行时长：`01:23:45`（带小时位）。</summary>
    public static string FormatDuration(double ms)
    {
        if (double.IsNaN(ms) || double.IsInfinity(ms) || ms < 0) return "00:00:00";
        var total = (long)Math.Floor(ms / 1000);
        var h = total / 3600;
        var m = (total % 3600) / 60;
        var s = total % 60;
        return $"{Pad((int)h)}:{Pad((int)m)}:{Pad((int)s)}";
    }

    /// <summary>体积：`48.2 MB`；未知返回 `—`。</summary>
    public static string FormatBytes(double? bytes)
    {
        if (bytes is null || double.IsNaN(bytes.Value) || double.IsInfinity(bytes.Value) || bytes.Value < 0) return "—";
        var value = bytes.Value;
        if (value < 1024) return $"{(long)value} B";

        string[] units = { "KB", "MB", "GB", "TB" };
        var scaled = value / 1024;
        var idx = 0;
        while (scaled >= 1024 && idx < units.Length - 1)
        {
            scaled /= 1024;
            idx += 1;
        }

        var digits = scaled >= 100 ? 0 : 1;
        return scaled.ToString("F" + digits, CultureInfo.InvariantCulture) + " " + units[idx];
    }

    /// <summary>
    /// 引擎体积：`0` 与 `null` 一律显示「未知」。
    ///
    /// 原因（沿用旧实现注释）：core 的 <c>dirSize</c> 刻意不跟随 junction / 符号链接，
    /// 因此通过链接接入的引擎会返回 0；若直接渲染成 `0 B`，用户会误以为引擎是空的。
    /// </summary>
    public static string FormatEngineSize(double? bytes)
    {
        if (bytes is null || double.IsNaN(bytes.Value) || double.IsInfinity(bytes.Value) || bytes.Value <= 0) return "未知";
        return FormatBytes(bytes);
    }

    /// <summary>中间省略的长路径：`F:\WhalesLauncher\…\instances\我的实例`。</summary>
    public static string ShortenPath(string path, int max = 72)
    {
        if (path.Length <= max) return path;

        var parts = path.Split(new[] { '\\', '/' }, StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length <= 2) return path.Substring(0, Math.Max(0, max - 1)) + "…";

        var head = parts[0] + "\\" + parts[1];
        var tailParts = new List<string>();
        for (var i = parts.Length - 1; i >= 2; i -= 1)
        {
            var candidate = string.Join("\\", new[] { parts[i] }.Concat(tailParts));
            if (head.Length + candidate.Length + 2 > max) break;
            tailParts.Insert(0, parts[i]);
        }

        if (tailParts.Count == 0) return head + "\\…";
        return head + "\\…\\" + string.Join("\\", tailParts);
    }

    /// <summary>文件名与最后一段路径。</summary>
    public static string BaseName(string path)
    {
        var parts = path.Split(new[] { '\\', '/' }, StringSplitOptions.RemoveEmptyEntries);
        return parts.Length == 0 ? path : parts[^1];
    }

    /// <summary>解析为本地时间（对应 JS `new Date(iso)` + `getHours()` 的本地语义）。</summary>
    private static DateTime? ParseLocal(string? iso)
    {
        var d = ParseOffset(iso);
        return d?.LocalDateTime;
    }

    private static DateTimeOffset? ParseOffset(string? iso)
    {
        if (string.IsNullOrWhiteSpace(iso)) return null;
        if (DateTimeOffset.TryParse(iso, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var d))
        {
            return d;
        }
        return null;
    }
}

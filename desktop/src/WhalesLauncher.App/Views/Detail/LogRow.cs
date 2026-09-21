using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media;
using WhalesLauncher.Models;
using WhalesLauncher.Services;

namespace WhalesLauncher.Views.Detail;

/// <summary>
/// 日志视图的一行。由 <see cref="LogChunk"/> 按行切分而来（一个 chunk 常含多行）。
///
/// 为什么要有这一层：契约里的 <c>LogChunk</c> 是「一段文本」，而界面要按行虚拟化渲染、
/// 按行过滤。若直接把 chunk 塞进列表项，一个 chunk 里的多行会挤在同一行上，
/// 行数与「显示 N / 共 M 行」的统计也就无从谈起（规范 §9.6 状态条要求计数）。
///
/// 只读属性 + 无通知：日志行一旦产生就不再变化，省掉 1500 行 × N 个字段变更通知
/// 的开销（日志洪峰下这是实打实的成本）。
/// </summary>
public sealed class LogRow
{
    public LogRow(LogChunk chunk, string text)
    {
        Stream = chunk.Stream;
        TimeText = Formatters.FormatClock(chunk.Ts);
        Text = text;
    }

    /// <summary>原始流名，用于过滤判定（不参与渲染）。</summary>
    public string Stream { get; }

    /// <summary>`HH:mm:ss`。解析失败时为 <c>--:--:--</c>（<see cref="Formatters.FormatClock"/>）。</summary>
    public string TimeText { get; }

    /// <summary>正文（不含流前缀，前缀由 <see cref="StreamText"/> 给出）。</summary>
    public string Text { get; }

    /// <summary>
    /// 流标签列文本。stdout 是常态，留空以减少噪声；stderr / system 显式标注。
    ///
    /// 规范 §9.6 要求「色 + 形 + 字」三通道，颜色之外必须有文字 —— 这一列与
    /// <see cref="StreamText"/> 的前缀共同承担「字」通道，色条（Rectangle）承担「形/色」通道。
    /// </summary>
    public string StreamLabel => Stream switch
    {
        LogStreamValues.Stderr => "stderr",
        LogStreamValues.System => "system",
        _ => string.Empty,
    };

    /// <summary>
    /// 真机渲染的正文。
    ///
    /// stderr 加 <c>!</c> 前缀、system 加 <c>·</c> 前缀：规范 §9.6 明确「斜体不可用」，
    /// 而正文必须用等宽字族的 <see cref="Microsoft.UI.Xaml.Controls.TextBlock"/>，
    /// 不能改字重，故用前缀区分（这也是规范给出的方案）。
    /// </summary>
    public string StreamText => Stream switch
    {
        LogStreamValues.Stderr => "! " + Text,
        LogStreamValues.System => "· " + Text,
        _ => Text,
    };

    /// <summary>
    /// 该行是否符合当前过滤条件。
    /// </summary>
    /// <param name="stream">流名；<c>null</c> 或空表示「全部」。</param>
    /// <param name="keyword">关键字；大小写不敏感，空表示不过滤。</param>
    public bool Matches(string? stream, string? keyword)
    {
        if (!string.IsNullOrEmpty(stream) && !string.Equals(Stream, stream, StringComparison.Ordinal))
        {
            return false;
        }

        if (string.IsNullOrEmpty(keyword))
        {
            return true;
        }

        return Text.Contains(keyword, StringComparison.OrdinalIgnoreCase);
    }

    /* ------------------------------------------------------------------ *
     * 画刷（供 DataTemplate 的 x:Bind 使用）
     *
     * 为什么不直接在 XAML 里用 {ThemeResource}：流语义色要在**运行时**按行决定，
     * XAML 绑定无法表达「按 Stream 取不同资源键」。这里经 Application.Current.Resources
     * 查的仍是内置键（符合 §6「颜色一律来自内置键」），没有自写 hex。
     * 行在容器创建时求值一次（Mode=OneTime）；换主题后列表会重建，因此不会残留旧主题色。
     * ------------------------------------------------------------------ */

    /// <summary>左侧色条填充。stdout 中性、stderr 危险色、system 强调色。</summary>
    public Brush Fill => Stream switch
    {
        LogStreamValues.Stderr => Lookup("SystemFillColorCriticalBrush"),
        LogStreamValues.System => Lookup("SystemFillColorAttentionBrush"),
        _ => Lookup("TextFillColorTertiaryBrush"),
    };

    /// <summary>流标签列前景。</summary>
    public Brush LabelBrush => Stream switch
    {
        LogStreamValues.Stderr => Lookup("SystemFillColorCriticalBrush"),
        LogStreamValues.System => Lookup("TextFillColorSecondaryBrush"),
        _ => Lookup("TextFillColorTertiaryBrush"),
    };

    /// <summary>正文前景。stderr 整行危险色，便于在洪峰里一眼扫到错误。</summary>
    public Brush BodyBrush => Stream switch
    {
        LogStreamValues.Stderr => Lookup("SystemFillColorCriticalBrush"),
        LogStreamValues.System => Lookup("TextFillColorSecondaryBrush"),
        _ => Lookup("TextFillColorPrimaryBrush"),
    };

    /// <summary>
    /// 归一化流名：契约里的取值只有三种，但推送载荷来自 Node，
    /// 出现未知值时按 stdout 处理（中性呈现），不抛异常也不丢行。
    /// </summary>
    public static string NormalizeStream(string? stream) => stream switch
    {
        LogStreamValues.Stderr => LogStreamValues.Stderr,
        LogStreamValues.System => LogStreamValues.System,
        _ => LogStreamValues.Stdout,
    };

    private static Brush Lookup(string key)
    {
        // 内置键一定存在；万一被主题字典覆盖成非画刷，退化为透明而不是崩在渲染线程
        if (Application.Current?.Resources is { } resources &&
            resources.TryGetValue(key, out var value) &&
            value is Brush brush)
        {
            return brush;
        }

        return new SolidColorBrush(Microsoft.UI.Colors.Transparent);
    }
}

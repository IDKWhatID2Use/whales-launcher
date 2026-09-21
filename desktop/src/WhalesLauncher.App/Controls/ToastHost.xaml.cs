using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using WhalesLauncher.Services;

namespace WhalesLauncher.Controls;

/// <summary>
/// 轻提示宿主。用法：外壳把它放在最上层，然后由 <see cref="ToastService"/> 驱动。
///
/// 行为（视觉规范 §9.10.2）：
/// - 最多同屏 3 条，超出时挤出最旧的一条；
/// - 相同去重键在存活期内不重复弹出（旧实现 <c>shownErrors</c> 的等价物）；
/// - 每条可手动关闭，并在超时后自动消失。
/// </summary>
public sealed partial class ToastHost : UserControl
{
    private const int MaxVisible = 3;

    private readonly List<Entry> _entries = new();

    public ToastHost()
    {
        InitializeComponent();
    }

    /// <summary>显示一条提示。相同 <paramref name="dedupeKey"/> 在存活期内只显示一次。</summary>
    public void Show(ToastKind kind, string message, string? detail = null, string? dedupeKey = null, TimeSpan? duration = null)
    {
        var key = dedupeKey ?? $"{kind}|{message}|{detail}";

        if (_entries.Any(e => e.Key == key))
        {
            return;
        }

        var bar = new InfoBar
        {
            Severity = kind switch
            {
                ToastKind.Success => InfoBarSeverity.Success,
                ToastKind.Warning => InfoBarSeverity.Warning,
                ToastKind.Error => InfoBarSeverity.Error,
                _ => InfoBarSeverity.Informational,
            },
            Title = message,
            Message = detail ?? string.Empty,
            IsOpen = true,
            IsClosable = true,
            IsHitTestVisible = true,
        };

        var entry = new Entry(key, bar);
        bar.CloseButtonClick += (_, _) => Dismiss(entry);

        _entries.Add(entry);
        ItemsPanel.Children.Add(bar);

        // 超出上限：挤出最旧一条
        while (_entries.Count > MaxVisible)
        {
            Dismiss(_entries[0]);
        }

        var life = duration ?? DefaultDuration(kind);
        entry.Timer = new DispatcherTimer { Interval = life };
        entry.Timer.Tick += (_, _) => Dismiss(entry);
        entry.Timer.Start();
    }

    private static TimeSpan DefaultDuration(ToastKind kind) => kind switch
    {
        // 错误留久一点：用户需要读完并可能复制文案
        ToastKind.Error => TimeSpan.FromSeconds(12),
        ToastKind.Warning => TimeSpan.FromSeconds(8),
        _ => TimeSpan.FromSeconds(5),
    };

    private void Dismiss(Entry entry)
    {
        if (!_entries.Remove(entry))
        {
            return;
        }

        entry.Timer?.Stop();
        ItemsPanel.Children.Remove(entry.Element);
    }

    private sealed class Entry
    {
        public Entry(string key, InfoBar element)
        {
            Key = key;
            Element = element;
        }

        public string Key { get; }

        public InfoBar Element { get; }

        public DispatcherTimer? Timer { get; set; }
    }
}

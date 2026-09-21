using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using WhalesLauncher.Models;

namespace WhalesLauncher.Views.Detail;

/// <summary>
/// 可复用日志视图（视觉规范 §9.6 的 <c>LogView</c>）。
///
/// <b>它被两处复用</b>：P5 日志页（<see cref="LogsView"/>）与外壳右侧日志抽屉（§9.1）。
/// 因此它**不订阅桥接事件、不调用 AppServices**：订阅一旦写在控件里，
/// 两处宿主会各订阅一次，同一行日志被渲染两遍。
///
/// <b>外露 API</b>：
/// <list type="bullet">
///   <item><description><c>void Append(IEnumerable&lt;LogChunk&gt; chunks)</c> —— 批量追加（洪峰下每帧调一次）。</description></item>
///   <item><description><c>void Append(LogChunk chunk)</c> —— 单条追加。</description></item>
///   <item><description><c>void Clear()</c> —— 清空缓冲与丢弃计数。</description></item>
///   <item><description><c>void SetFilter(string? stream, string? keyword)</c> —— 过滤只重建绑定集合，不重建行对象。</description></item>
///   <item><description><c>void ScrollToEnd()</c> —— 强制回到底部。</description></item>
///   <item><description><c>int MaxLines</c> / <c>string? InstanceId</c> / <c>string EmptyHint</c> —— 可写属性。</description></item>
///   <item><description><c>bool FollowTail</c>（依赖属性，可 TwoWay 绑定 <c>ToggleSwitch.IsOn</c>）。</description></item>
///   <item><description><c>event EventHandler? FollowTailChanged</c> —— 用户上滚导致跟随自动暂停时通知宿主同步开关。</description></item>
///   <item><description><c>int VisibleCount</c> / <c>int TotalCount</c> / <c>int DroppedCount</c> —— 状态条要的计数。</description></item>
///   <item><description><c>event EventHandler? CountsChanged</c> —— 计数变化通知。</description></item>
/// </list>
/// </summary>
public sealed partial class LogView : UserControl
{
    /// <summary>渲染行数上限。规范 §11 U06：无官方出处，沿用需求口径 1500 行（<c>⚠️ 自定</c>）。</summary>
    public const int DefaultMaxLines = 1500;

    /// <summary>
    /// 单行最大字符数。日志里偶有超长单行（压缩后的 JSON、base64），
    /// 不设上限会让文本布局耗掉整帧预算；截断比卡死好，且截断处有明确省略号。
    /// </summary>
    private const int MaxRowChars = 4000;

    /// <summary>判定「已在底部」的容差（epx）。</summary>
    private const double BottomTolerance = 8;

    private readonly List<LogRow> _allRows = new();

    private ScrollViewer? _scrollViewer;
    private string? _currentStream;
    private string? _currentKeyword;

    public LogView()
    {
        InitializeComponent();
        RefreshStates(rowsAdded: false);
    }

    /// <summary>绑定源：过滤后的行。ListView 只看到这一份，过滤切换不重建行对象。</summary>
    public System.Collections.ObjectModel.ObservableCollection<LogRow> Rows { get; } = new();

    /// <summary>只接受该实例的 chunk；为 <c>null</c> 时全部接受。</summary>
    public string? InstanceId { get; set; }

    /// <summary>渲染行数上限。小于 100 的值会被夹到 100，避免误设导致列表几乎不显示。</summary>
    public int MaxLines { get; set; } = DefaultMaxLines;

    /// <summary>空态说明文案。</summary>
    public string EmptyHint
    {
        get => EmptyHintText.Text;
        set => EmptyHintText.Text = value;
    }

    /// <summary>已丢弃（被环形裁剪掉）的行数。</summary>
    public int DroppedCount { get; private set; }

    /// <summary>当前显示（过滤后）的行数。</summary>
    public int VisibleCount => Rows.Count;

    /// <summary>缓冲总行数（过滤前）。</summary>
    public int TotalCount => _allRows.Count;

    /// <summary>计数变化（含丢弃数）。状态条订阅它刷新文本。</summary>
    public event EventHandler? CountsChanged;

    /// <summary>跟随开关被滚动行为自动改变时触发，宿主据此同步自己的 ToggleSwitch。</summary>
    public event EventHandler? FollowTailChanged;

    public static readonly DependencyProperty FollowTailProperty = DependencyProperty.Register(
        nameof(FollowTail),
        typeof(bool),
        typeof(LogView),
        new PropertyMetadata(true, OnFollowTailChanged));

    /// <summary>是否跟随滚动（默认开）。规范 §9.6：用户上滚则自动暂停并给出「回到底部」。</summary>
    public bool FollowTail
    {
        get => (bool)GetValue(FollowTailProperty);
        set => SetValue(FollowTailProperty, value);
    }

    private static void OnFollowTailChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
    {
        var view = (LogView)d;
        view.JumpToBottomButton.Visibility = (bool)e.NewValue ? Visibility.Collapsed : Visibility.Visible;
    }

    /// <summary>批量追加。调用方应已按帧合并（规范 §9.6「批量入队」）。</summary>
    public void Append(IEnumerable<LogChunk> chunks)
    {
        var added = false;
        foreach (var chunk in chunks)
        {
            added |= AppendCore(chunk);
        }

        if (!added)
        {
            return;
        }

        TrimToLimit();
        RefreshStates(rowsAdded: true);
    }

    /// <summary>单条追加。</summary>
    public void Append(LogChunk chunk)
    {
        if (!AppendCore(chunk))
        {
            return;
        }

        TrimToLimit();
        RefreshStates(rowsAdded: true);
    }

    /// <summary>清空缓冲与丢弃计数。</summary>
    public void Clear()
    {
        _allRows.Clear();
        Rows.Clear();
        DroppedCount = 0;
        RefreshStates(rowsAdded: false);
    }

    /// <summary>
    /// 设置过滤条件。
    ///
    /// 只重建「绑定集合」（1500 项级别，毫秒内完成），**不**重建行对象、**不**重新解析日志文本 ——
    /// 规范 §9.6 明确禁止「重新渲染全部行」。
    /// </summary>
    public void SetFilter(string? stream, string? keyword)
    {
        _currentStream = string.IsNullOrWhiteSpace(stream) ? null : stream;
        _currentKeyword = string.IsNullOrWhiteSpace(keyword) ? null : keyword.Trim();

        Rows.Clear();
        foreach (var row in _allRows)
        {
            if (row.Matches(_currentStream, _currentKeyword))
            {
                Rows.Add(row);
            }
        }

        RefreshStates(rowsAdded: false);
    }

    /// <summary>强制回到底部（并重新打开跟随）。</summary>
    public void ScrollToEnd()
    {
        if (Rows.Count == 0)
        {
            return;
        }

        LogList.ScrollIntoView(Rows[^1]);
    }

    /// <summary>
    /// 当前**可见**（过滤后）的全部日志文本，供「复制全部」使用。
    ///
    /// 复制可见集合而不是原始缓冲：用户按下复制时看到的就是过滤后的内容，
    /// 复制出看不见的行会让人以为过滤失效了。
    /// </summary>
    public string GetVisibleText()
    {
        if (Rows.Count == 0)
        {
            return string.Empty;
        }

        var builder = new System.Text.StringBuilder(Rows.Count * 64);
        foreach (var row in Rows)
        {
            // 时间 + 流标签 + **正文**：漏掉正文会让"复制全部"复制出一堆空壳（shell-dev 实测发现）
            builder.Append(row.TimeText)
                .Append(' ')
                .Append(row.StreamLabel.PadRight(6))
                .Append(row.Text)
                .Append('\n');
        }

        return builder.ToString();
    }

    /// <summary>返回 true 表示该 chunk 被接受。</summary>
    private bool AppendCore(LogChunk? chunk)
    {
        if (chunk is null) return false;
        if (InstanceId is not null && !string.Equals(chunk.InstanceId, InstanceId, StringComparison.Ordinal))
        {
            return false;
        }

        if (string.IsNullOrEmpty(chunk.Text)) return false;

        var added = false;
        foreach (var line in SplitLines(chunk.Text))
        {
            var text = line.Length > MaxRowChars ? line.Substring(0, MaxRowChars) + " …" : line;
            var row = new LogRow(chunk, text);
            _allRows.Add(row);

            // 过滤条件下新增的行也要即时判定，否则用户开着 stderr 过滤却看不到新错误
            if (row.Matches(_currentStream, _currentKeyword))
            {
                Rows.Add(row);
            }

            added = true;
        }

        return added;
    }

    /// <summary>
    /// 环形裁剪：超出上限时按批移除最旧的行。
    ///
    /// 若每次追加都逐条 <c>RemoveAt(0)</c>，在 1500 行上限下会退化成 O(n²)；
    /// 这里一次删到上限，摊还到每次追加仍是常数级。
    /// </summary>
    private void TrimToLimit()
    {
        var limit = Math.Max(100, MaxLines);
        if (_allRows.Count <= limit)
        {
            return;
        }

        var dropCount = _allRows.Count - limit;
        for (var i = 0; i < dropCount; i++)
        {
            var row = _allRows[0];
            _allRows.RemoveAt(0);

            var visibleIndex = Rows.IndexOf(row);
            if (visibleIndex >= 0)
            {
                Rows.RemoveAt(visibleIndex);
            }
        }

        DroppedCount += dropCount;
    }

    /// <summary>刷新空态 / 截断提示 / 跟随滚动 / 计数。</summary>
    private void RefreshStates(bool rowsAdded)
    {
        EmptyState.Visibility = Rows.Count == 0 ? Visibility.Visible : Visibility.Collapsed;

        TruncatedBar.IsOpen = DroppedCount > 0;
        if (DroppedCount > 0)
        {
            TruncatedBar.Message = $"已丢弃最早的 {DroppedCount} 行（渲染上限 {Math.Max(100, MaxLines)} 行）";
        }

        JumpToBottomButton.Visibility = FollowTail ? Visibility.Collapsed : Visibility.Visible;

        // 只在真的有新行、且跟随打开时才滚动：ItemsStackPanel 自身的
        // KeepLastItemInView 会处理常规续滚，这里补的是「被裁剪后重新贴底」的场景。
        if (rowsAdded && FollowTail)
        {
            ScrollToEnd();
        }

        CountsChanged?.Invoke(this, EventArgs.Empty);
    }

    /// <summary>
    /// 按行切分。手写而不是用 <c>Split</c>：一个 chunk 可能含成百上千行，
    /// <c>Split</c> 会为每行分配数组元素外加数组本身，洪峰下 GC 压力明显。
    /// </summary>
    private static IEnumerable<string> SplitLines(string text)
    {
        var start = 0;
        for (var i = 0; i < text.Length; i++)
        {
            if (text[i] != '\n') continue;

            var end = i;
            if (end > start && text[end - 1] == '\r') end--;
            yield return text.Substring(start, end - start);
            start = i + 1;
        }

        if (start < text.Length)
        {
            var end = text.Length;
            if (end > start && text[end - 1] == '\r') end--;
            yield return text.Substring(start, end - start);
        }
    }

    private void OnLoaded(object sender, RoutedEventArgs e)
    {
        // ListView 的 ScrollViewer 要到模板应用后才在可视树里；Loaded 是最早的可靠时机
        _scrollViewer = FindScrollViewer(LogList);
        if (_scrollViewer is not null)
        {
            _scrollViewer.ViewChanged += OnScrollViewChanged;
        }

        RefreshStates(rowsAdded: false);
    }

    private void OnScrollViewChanged(object? sender, ScrollViewerViewChangedEventArgs e)
    {
        if (_scrollViewer is null || !FollowTail)
        {
            return;
        }

        // 只有「用户已离开底部」才暂停跟随；在底部时不动开关，避免与用户的开关操作打架
        var atBottom = _scrollViewer.ScrollableHeight - _scrollViewer.VerticalOffset <= BottomTolerance;
        if (!atBottom && !e.IsIntermediate)
        {
            FollowTail = false;
            FollowTailChanged?.Invoke(this, EventArgs.Empty);
        }
    }

    private void OnJumpToBottomClick(object sender, RoutedEventArgs e)
    {
        FollowTail = true;
        ScrollToEnd();
        FollowTailChanged?.Invoke(this, EventArgs.Empty);
    }

    private static ScrollViewer? FindScrollViewer(DependencyObject root)
    {
        var count = VisualTreeHelper.GetChildrenCount(root);
        for (var i = 0; i < count; i++)
        {
            var child = VisualTreeHelper.GetChild(root, i);
            if (child is ScrollViewer viewer) return viewer;

            var nested = FindScrollViewer(child);
            if (nested is not null) return nested;
        }

        return null;
    }
}

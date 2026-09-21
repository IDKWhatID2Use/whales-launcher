using System.Collections.Concurrent;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Windows.ApplicationModel.DataTransfer;
using WhalesLauncher.Models;
using WhalesLauncher.Services;
using WhalesLauncher.Views.Detail;

namespace WhalesLauncher.Shell;

/// <summary>
/// 右侧运行日志抽屉（规范 §9.1）。
///
/// 分工：内容渲染复用 P5 的 <see cref="LogView"/>（它的文件头注释明确要求"宿主订阅、控件不订阅"，
/// 否则 P5 页与抽屉各订阅一次，同一行日志会被渲染两遍）。因此本类负责：
/// <list type="bullet">
///   <item><description>订阅 <c>log:chunk</c> 推送并按帧合并（规范 §7.6：不逐条 Invoke）；</description></item>
///   <item><description>来源过滤（"全部实例" = <see cref="LogView.InstanceId"/> 设 null）；</description></item>
///   <item><description>跟随开关、打开日志目录、复制全部；</description></item>
///   <item><description>标题栏「运行日志」按钮上的未读错误 <c>InfoBadge</c>。</description></item>
/// </list>
///
/// 与旧实现（<c>src/renderer/shell.ts:354-364</c>）的差异：旧实现"抽屉收拢动画结束后清空内容"，
/// 这里**不清空** —— LogView 自带 1500 行环形上限，关闭时内容留在控件里，
/// 重新打开只需回放最近 chunk 补齐空档，反而不会丢掉用户已经滚动到的位置。
/// </summary>
public sealed class LogDrawer
{
    /// <summary>抽屉关闭期间保留的 chunk 条数（重新打开时用它回放最近上下文）。</summary>
    private const int RecentCapacity = 300;

    /// <summary>徽标上限：再大的数字在 8 epx 见方的点位上没有意义。</summary>
    private const int MaxBadgeValue = 99;

    /// <summary>刷新合并窗口（与 P5 的 LogsView 同值，规范 §7.6 的"按帧合并"）。</summary>
    private static readonly TimeSpan FlushInterval = TimeSpan.FromMilliseconds(16);

    private readonly FrameworkElement _uiRoot;
    private readonly SplitView _drawer;
    private readonly ToggleButton _toggle;
    private readonly InfoBadge _badge;
    private readonly ComboBox _sourceBox;
    private readonly ToggleButton _followToggle;
    private readonly Button _openFolderButton;
    private readonly Button _copyButton;
    private readonly LogView _surface;
    private readonly TextBlock _countText;

    private readonly ConcurrentQueue<LogChunk> _inbox = new();
    private readonly object _recentGate = new();
    private readonly Queue<LogChunk> _recent = new();

    /// <summary>刷新合并计时器。在 <see cref="Attach"/> 里创建：那时 DispatcherQueue 必定可用。</summary>
    private DispatcherQueueTimer? _flushTimer;

    private string? _sourceId;
    private int _unreadErrors;
    private int _flushScheduled;
    private bool _syncingToggle;
    private bool _subscribed;
    private bool _attached;

    public LogDrawer(
        FrameworkElement uiRoot,
        SplitView drawer,
        ToggleButton toggle,
        InfoBadge badge,
        ComboBox sourceBox,
        ToggleButton followToggle,
        Button openFolderButton,
        Button copyButton,
        LogView surface,
        TextBlock countText)
    {
        _uiRoot = uiRoot ?? throw new ArgumentNullException(nameof(uiRoot));
        _drawer = drawer ?? throw new ArgumentNullException(nameof(drawer));
        _toggle = toggle ?? throw new ArgumentNullException(nameof(toggle));
        _badge = badge ?? throw new ArgumentNullException(nameof(badge));
        _sourceBox = sourceBox ?? throw new ArgumentNullException(nameof(sourceBox));
        _followToggle = followToggle ?? throw new ArgumentNullException(nameof(followToggle));
        _openFolderButton = openFolderButton ?? throw new ArgumentNullException(nameof(openFolderButton));
        _copyButton = copyButton ?? throw new ArgumentNullException(nameof(copyButton));
        _surface = surface ?? throw new ArgumentNullException(nameof(surface));
        _countText = countText ?? throw new ArgumentNullException(nameof(countText));
    }

    /// <summary>挂载：接线所有控件事件并订阅日志推送。幂等（Loaded 可能重复触发）。</summary>
    public void Attach()
    {
        if (_attached)
        {
            return;
        }

        _attached = true;

        var queue = _uiRoot.DispatcherQueue ?? throw new InvalidOperationException(
            "外壳尚未挂到窗口上：DispatcherQueue 为空，无法创建日志刷新计时器。");

        var timer = queue.CreateTimer();
        timer.Interval = FlushInterval;
        timer.IsRepeating = false;
        timer.Tick += OnFlushTick;
        _flushTimer = timer;

        _toggle.Checked += OnToggleChanged;
        _toggle.Unchecked += OnToggleChanged;
        _drawer.PaneOpened += OnPaneOpened;
        _drawer.PaneClosed += OnPaneClosed;
        _followToggle.Checked += OnFollowChanged;
        _followToggle.Unchecked += OnFollowChanged;
        _sourceBox.SelectionChanged += OnSourceChanged;
        _openFolderButton.Click += OnOpenFolderClick;
        _copyButton.Click += OnCopyAllClick;
        _surface.CountsChanged += OnCountsChanged;
        _surface.FollowTailChanged += OnFollowTailChanged;

        _surface.EmptyHint = "尚未收到日志输出：日志只在实例运行时产生。";
        _surface.InstanceId = null;

        // 未读徽标必须在抽屉关闭时也计数，所以订阅不随开合启停；
        // 后端若尚未装配，Attach 时订不上，由外壳在装配完成后调用 SubscribeToBackend() 补订。
        SubscribeToBackend();
        RebuildSources();
        UpdateCopyState();
        UpdateBadge();
    }

    /// <summary>窗口关闭时解绑（简报 §4.9：订阅必须成对解除，否则桥接层一直持有本对象）。</summary>
    public void Detach()
    {
        _flushTimer?.Stop();

        if (!_subscribed || !AppServices.IsReady)
        {
            return;
        }

        AppServices.Bridge.LogChunk -= OnLogChunk;
        _subscribed = false;
    }

    /// <summary>重建来源下拉（"全部实例" + 各实例）。实例列表变化时由外壳调用。</summary>
    public void RebuildSources()
    {
        var previous = _sourceId;

        _sourceBox.Items.Clear();
        _sourceBox.Items.Add(new ComboBoxItem { Content = "全部实例", Tag = null });

        if (AppServices.IsReady)
        {
            foreach (var instance in AppServices.State.Instances)
            {
                var name = string.IsNullOrWhiteSpace(instance.Meta.Name) ? instance.Meta.DirName : instance.Meta.Name;
                _sourceBox.Items.Add(new ComboBoxItem { Content = name, Tag = instance.Meta.Id });
            }
        }

        // 默认"全部实例"；实例刷新时不要顺手把用户选的来源重置掉
        var restored = 0;
        if (previous is not null)
        {
            for (var i = 1; i < _sourceBox.Items.Count; i++)
            {
                if (_sourceBox.Items[i] is ComboBoxItem { Tag: string id } && string.Equals(id, previous, StringComparison.Ordinal))
                {
                    restored = i;
                    break;
                }
            }
        }

        _sourceBox.SelectedIndex = restored;
    }

    /// <summary>订阅日志推送并刷新来源下拉。外壳在桥接就绪后调用（幂等）。</summary>
    public void SubscribeToBackend()
    {
        if (_subscribed || !AppServices.IsReady)
        {
            return;
        }

        AppServices.Bridge.LogChunk += OnLogChunk;
        _subscribed = true;
        RebuildSources();
    }

    /* ------------------------------------------------------------------ *
     * 标题栏按钮 / 抽屉开合
     * ------------------------------------------------------------------ */

    private void OnToggleChanged(object sender, RoutedEventArgs e)
    {
        if (_syncingToggle)
        {
            return;
        }

        _drawer.IsPaneOpen = _toggle.IsChecked == true;
    }

    private void OnPaneOpened(SplitView sender, object args)
    {
        _syncingToggle = true;
        _toggle.IsChecked = true;
        _syncingToggle = false;

        // 打开即视为"已读"：否则徽标会一直挂着，用户无法把它清掉
        Interlocked.Exchange(ref _unreadErrors, 0);
        UpdateBadge();

        ReplayRecent();
    }

    private void OnPaneClosed(SplitView sender, object args)
    {
        _syncingToggle = true;
        _toggle.IsChecked = false;
        _syncingToggle = false;
    }

    private void OnFollowChanged(object sender, RoutedEventArgs e) =>
        _surface.FollowTail = _followToggle.IsChecked == true;

    private void OnFollowTailChanged(object? sender, EventArgs e) =>
        _followToggle.IsChecked = _surface.FollowTail;

    private void OnSourceChanged(object sender, SelectionChangedEventArgs e)
    {
        _sourceId = (_sourceBox.SelectedItem as ComboBoxItem)?.Tag as string;

        // LogView 自己会按 InstanceId 过滤，"全部实例"用 null
        _surface.InstanceId = _sourceId;

        _openFolderButton.IsEnabled = _sourceId is not null;
        ToolTipService.SetToolTip(
            _openFolderButton,
            _sourceId is null
                ? "「全部实例」没有单一日志目录：请先选择一个实例"
                : "在资源管理器中打开该实例的日志目录");

        if (_drawer.IsPaneOpen)
        {
            ReplayRecent();
        }
    }

    private void OnOpenFolderClick(object sender, RoutedEventArgs e) => _ = OpenFolderAsync();

    private async Task OpenFolderAsync()
    {
        var id = _sourceId;
        if (id is null || !AppServices.IsReady)
        {
            return;
        }

        // 目录自愈与校验在 core 侧（沿用旧 shell.openPath 的行为：打开前 ensureDir）
        var result = await AppServices.Bridge.CallVoidAsync(Channels.InstanceOpenFolder, id, "logs");
        if (!result.Ok)
        {
            AppServices.Toast.Error("打开日志目录失败", result.Error);
        }
    }

    private void OnCopyAllClick(object sender, RoutedEventArgs e)
    {
        var text = _surface.GetVisibleText();
        if (string.IsNullOrEmpty(text))
        {
            AppServices.Toast.Warning("没有可复制的日志", "抽屉里还没有日志行。");
            return;
        }

        var package = new DataPackage { RequestedOperation = DataPackageOperation.Copy };
        package.SetText(text);
        Clipboard.SetContent(package);

        AppServices.Toast.Success("日志已复制", $"共 {_surface.VisibleCount} 行（当前来源的可见内容）。");
    }

    /* ------------------------------------------------------------------ *
     * 推送订阅与按帧合并
     * ------------------------------------------------------------------ */

    /// <summary>
    /// 在桥接读线程上被调用：**只入队、不碰 UI**（规范 §7.6 禁止每条日志一次 Invoke）。
    /// </summary>
    private void OnLogChunk(object? sender, LogChunk chunk)
    {
        lock (_recentGate)
        {
            _recent.Enqueue(chunk);
            while (_recent.Count > RecentCapacity)
            {
                _recent.Dequeue();
            }
        }

        var isError = string.Equals(chunk.Stream, LogStreamValues.Stderr, StringComparison.Ordinal);
        if (isError)
        {
            Interlocked.Increment(ref _unreadErrors);
        }

        _inbox.Enqueue(chunk);

        if (Interlocked.Exchange(ref _flushScheduled, 1) == 0)
        {
            _uiRoot.DispatcherQueue.TryEnqueue(() => _flushTimer?.Start());
        }

        if (isError)
        {
            _uiRoot.DispatcherQueue.TryEnqueue(UpdateBadge);
        }
    }

    private void OnFlushTick(DispatcherQueueTimer sender, object args)
    {
        Interlocked.Exchange(ref _flushScheduled, 0);

        if (!_drawer.IsPaneOpen)
        {
            // 抽屉关着：丢弃本帧（最近 chunk 已在 _recent 里，打开时回放）
            while (_inbox.TryDequeue(out _))
            {
            }

            return;
        }

        var batch = new List<LogChunk>(32);
        while (_inbox.TryDequeue(out var chunk))
        {
            batch.Add(chunk);
        }

        if (batch.Count > 0)
        {
            _surface.Append(batch);
        }
    }

    /// <summary>用最近 chunk 回放抽屉内容（打开抽屉 / 切换来源时调用）。</summary>
    private void ReplayRecent()
    {
        LogChunk[] snapshot;
        lock (_recentGate)
        {
            snapshot = _recent.ToArray();
        }

        _surface.Clear();
        _surface.Append(snapshot);

        if (_surface.FollowTail)
        {
            _surface.ScrollToEnd();
        }

        UpdateCopyState();
    }

    private void OnCountsChanged(object? sender, EventArgs e) => UpdateCopyState();

    private void UpdateCopyState()
    {
        _countText.Text = $"显示 {_surface.VisibleCount} / 共 {_surface.TotalCount} 行";
        _copyButton.IsEnabled = _surface.VisibleCount > 0;
    }

    private void UpdateBadge()
    {
        var count = Volatile.Read(ref _unreadErrors);
        _badge.Value = Math.Min(count, MaxBadgeValue);
        _badge.Visibility = count > 0 && !_drawer.IsPaneOpen ? Visibility.Visible : Visibility.Collapsed;

        // 徽标只是"有没有新错误"的提示，具体条数交给屏幕阅读器读出
        AutomationName(_badge, count > 0 ? $"运行日志有 {count} 条未读错误" : "运行日志");
    }

    private static void AutomationName(DependencyObject target, string name) =>
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(target, name);
}

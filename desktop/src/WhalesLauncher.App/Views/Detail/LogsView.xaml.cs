using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using WhalesLauncher.Models;
using WhalesLauncher.Services;

namespace WhalesLauncher.Views.Detail;

/// <summary>
/// P5 实例详情 · 日志（视觉规范 §9.6）。
///
/// 生命周期由 <see cref="InstanceDetailPage"/> 驱动：<see cref="LoadAsync"/> 装载、
/// <see cref="Unload"/> 解绑。之所以不做成 <c>Page</c>：4 个页签共用同一个
/// <see cref="Microsoft.UI.Xaml.Controls.Frame"/> 位置，用 <c>UserControl</c> 切 <c>Visibility</c>
/// 才能保住各自的滚动位置与编辑态（规范 §6.3 不选 <c>TabView</c> 的理由正是"切页即丢编辑态"）。
/// </summary>
public sealed partial class LogsView : UserControl
{
    /// <summary>日志事件可能来自后台读线程，先入队再合并（协议 §2.4 的推送在 stdout 读循环上触发）。</summary>
    private readonly System.Collections.Concurrent.ConcurrentQueue<LogChunk> _inbox = new();

    private readonly DispatcherQueueTimer _batchTimer;

    private string _instanceId = string.Empty;
    private bool _subscribed;
    private int _flushScheduled;

    public LogsView()
    {
        InitializeComponent();

        // 跟随默认开。初始值刻意在代码里赋，而不是 XAML 里的 IsOn="True" ——
        // 后者会在 LoadComponent 解析阶段抛 XamlParseException（详见 LogsView.xaml 的注释）。
        FollowSwitch.IsOn = true;

        _batchTimer = DispatcherQueue.CreateTimer();
        _batchTimer.Interval = TimeSpan.FromMilliseconds(16);
        _batchTimer.IsRepeating = false;
        _batchTimer.Tick += OnBatchTick;

        BuildStreamFilter();
        Logs.CountsChanged += OnCountsChanged;
        Logs.FollowTailChanged += OnFollowTailAutoPaused;
    }

    /// <summary>装载：绑定实例、初始化过滤条件、订阅日志推送。</summary>
    public void Load(string instanceId, string instanceName)
    {
        _instanceId = instanceId;
        Logs.InstanceId = instanceId;

        Crumb.ItemsSource = DetailBreadcrumb.For(instanceName, DetailTabs.Label(DetailTabs.Logs));

        ApplyFilter();
        UpdateCounts();

        // 订阅只用做一次：页签来回切换时 Load 会重复调用，重复 += 会让同一行日志渲染多遍
        if (_subscribed)
        {
            return;
        }

        AppServices.Bridge.LogChunk += OnLogChunk;
        AppServices.Bridge.LogStateChanged += OnLogStateChanged;
        _subscribed = true;
    }

    /// <summary>离开页面/切页签：必须解绑，否则桥接层会一直持有本视图（规范 §9.6 与简报 §4.9）。</summary>
    public void Unload()
    {
        _batchTimer.Stop();

        if (!_subscribed)
        {
            return;
        }

        AppServices.Bridge.LogChunk -= OnLogChunk;
        AppServices.Bridge.LogStateChanged -= OnLogStateChanged;
        _subscribed = false;
    }

    /* ------------------------------------------------------------------ *
     * 工具条
     * ------------------------------------------------------------------ */

    private void BuildStreamFilter()
    {
        StreamBar.Items.Clear();

        // 顺序与规范 §9.6 一致：全部 | stdout | stderr | system
        AddStreamItem("全部", null, selected: true);
        AddStreamItem("stdout", LogStreamValues.Stdout, selected: false);
        AddStreamItem("stderr", LogStreamValues.Stderr, selected: false);
        AddStreamItem("system", LogStreamValues.System, selected: false);
    }

    private void AddStreamItem(string label, string? stream, bool selected)
    {
        var item = new SelectorBarItem
        {
            // Tag 用 null 表示"全部"：与 LogView.SetFilter(null, ...) 的语义直接对上
            Tag = stream,
            Text = label,
            IsSelected = selected,
        };
        StreamBar.Items.Add(item);
    }

    private string? SelectedStream =>
        (StreamBar.SelectedItem as SelectorBarItem)?.Tag as string;

    private void ApplyFilter() => Logs.SetFilter(SelectedStream, KeywordBox.Text);

    private void OnStreamFilterChanged(SelectorBar sender, SelectorBarSelectionChangedEventArgs args)
    {
        ApplyFilter();
        UpdateCounts();
    }

    /// <summary>
    /// 关键字过滤防抖 150ms（规范 §9.6 明确给出该值）。
    ///
    /// 不防抖的话每敲一个字符都要重建一遍绑定集合；1500 行时每次几十毫秒，
    /// 连续输入就会肉眼可见地卡。
    /// </summary>
    private void OnKeywordChanged(object sender, TextChangedEventArgs e)
    {
        if (_keywordTimer is null)
        {
            _keywordTimer = DispatcherQueue.CreateTimer();
            _keywordTimer.Interval = TimeSpan.FromMilliseconds(150);
            _keywordTimer.IsRepeating = false;
            _keywordTimer.Tick += (_, _) =>
            {
                ApplyFilter();
                UpdateCounts();
            };
        }

        _keywordTimer.Stop();
        _keywordTimer.Start();
    }

    private DispatcherQueueTimer? _keywordTimer;

    private void OnFollowToggled(object sender, RoutedEventArgs e)
    {
        Logs.FollowTail = FollowSwitch.IsOn;
    }

    /// <summary>用户上滚导致跟随自动暂停 → 同步工具条上的开关（避免"开关还开着但已经不跟随"的错觉）。</summary>
    private void OnFollowTailAutoPaused(object? sender, EventArgs e)
    {
        FollowSwitch.IsOn = Logs.FollowTail;
    }

    private void OnClearClick(object sender, RoutedEventArgs e) => Logs.Clear();

    private async void OnOpenLogsFolderClick(object sender, RoutedEventArgs e)
    {
        if (string.IsNullOrEmpty(_instanceId))
        {
            return;
        }

        var result = await AppServices.Bridge.CallAsync<BridgeVoid>(
            Channels.InstanceOpenFolder,
            _instanceId,
            InstanceFolderValues.Logs);

        if (!result.Ok)
        {
            AppServices.Toast.Error("无法打开日志目录", result.Error);
        }
    }

    /// <summary>
    /// 复制当前**可见**（过滤后）的全部日志。
    ///
    /// 复制可见集合而不是原始缓冲：用户按下复制时看到的就是过滤后的内容，
    /// 复制出看不见的行会让人以为过滤失效了。空集合时明确提示，而不是静默复制空串。
    /// </summary>
    private void OnCopyAllClick(object sender, RoutedEventArgs e)
    {
        var text = Logs.GetVisibleText();
        if (string.IsNullOrEmpty(text))
        {
            AppServices.Toast.Info("当前没有可复制的日志");
            return;
        }

        var package = new Windows.ApplicationModel.DataTransfer.DataPackage();
        package.SetText(text);
        Windows.ApplicationModel.DataTransfer.Clipboard.SetContent(package);

        AppServices.Toast.Success($"已复制 {Logs.VisibleCount} 行日志到剪贴板");
    }

    /* ------------------------------------------------------------------ *
     * 推送订阅与按帧合并
     * ------------------------------------------------------------------ */

    /// <summary>
    /// 在后台读线程上被调用（见 <c>CoreBridge</c> 的事件分发）。
    /// 这里**只入队**，绝不碰 UI —— 规范 §9.6 禁止"每条日志一次 DispatcherQueue.Invoke"。
    /// </summary>
    private void OnLogChunk(object? sender, LogChunk chunk)
    {
        if (!string.Equals(chunk.InstanceId, _instanceId, StringComparison.Ordinal))
        {
            return;
        }

        _inbox.Enqueue(chunk);

        // 只保证"至少排一次刷新"，多次入队不叠加 timer 操作
        if (Interlocked.Exchange(ref _flushScheduled, 1) == 0)
        {
            DispatcherQueue.TryEnqueue(() => _batchTimer.Start());
        }
    }

    /// <summary>
    /// 本实例的运行态快照。日志页自己**不**渲染状态徽标（外壳页头负责），
    /// 但运行态决定了空态文案该说「启动实例后将在此显示」还是别的，
    /// 所以这里保留最近一次 <c>log:state</c> 快照。
    /// </summary>
    private InstanceRuntime? _lastRuntime;

    /// <summary>记录本实例的运行态快照。日志页自己不画状态徽标（外壳页头负责），但空态文案要据此措辞。</summary>
    private void OnLogStateChanged(object? sender, InstanceRuntime runtime)
    {
        if (string.Equals(runtime.InstanceId, _instanceId, StringComparison.Ordinal))
        {
            _lastRuntime = runtime;
            UpdateCounts();
        }
    }

    /// <summary>把本帧内累积的所有 chunk 合成一次批量追加（规范 §9.6「批量入队」）。</summary>
    private void OnBatchTick(DispatcherQueueTimer sender, object args)
    {
        Interlocked.Exchange(ref _flushScheduled, 0);
        if (_inbox.IsEmpty)
        {
            return;
        }

        var batch = new List<LogChunk>(32);
        while (_inbox.TryDequeue(out var chunk))
        {
            batch.Add(chunk);
        }

        if (batch.Count > 0)
        {
            Logs.Append(batch);
        }
    }

    private void OnCountsChanged(object? sender, EventArgs e) => UpdateCounts();

    private void UpdateCounts()
    {
        CountText.Text = $"显示 {Logs.VisibleCount} / 共 {Logs.TotalCount} 行";

        var dropped = Logs.DroppedCount;
        TruncateText.Visibility = dropped > 0 ? Visibility.Visible : Visibility.Collapsed;
        TruncateText.Text = $"较早日志已截断（已丢弃 {dropped} 行）";

        // 规范 §9.6 空态：未运行 → "启动实例后将在此显示"
        Logs.EmptyHint = _lastRuntime is { State: InstanceStateValues.Running } or { State: InstanceStateValues.Starting }
            ? "尚未收到输出"
            : "启动实例后将在此显示";
    }

    /// <summary>页级错误呈现（规范 §9.0：错误不得只进日志）。</summary>
    public void ShowError(string title, string message)
    {
        ErrorBar.Title = title;
        ErrorBar.Message = message;
        ErrorBar.IsOpen = true;
    }

    /// <summary>Shell 调用：把当前可见日志整段复制到剪贴板。</summary>
    public string GetVisibleText() => Logs.GetVisibleText();
}

using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Text;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Navigation;
using WhalesLauncher.Models;
using WhalesLauncher.Services;
using Windows.ApplicationModel.DataTransfer;

namespace WhalesLauncher.Views;

/// <summary>
/// P6 引擎版本管理（视觉规范 §9.7）。
///
/// 三条硬性语义来自契约与 core，实现时不能想当然：
/// 1. <c>EngineInfo.usedBy</c> 里是**实例 id**，界面必须显示实例名（id 只进诊断 ToolTip）；
/// 2. <c>EngineInfo.sizeBytes</c> 的 <c>0</c> / <c>null</c> 一律显示「未知」——core 的 dirSize 刻意
///    不跟随 junction，链接接入的引擎会返回 0，显示成 <c>0 B</c> 会让用户以为引擎是空的
///    （原因见 <see cref="Formatters.FormatEngineSize"/> 的注释），因此这里只用它、不自己格式化；
/// 3. 安装/移除期间**没有取消通道**（规范 §11 U19），所以前端必须挡住并发触发，
///    并在 ToolTip 里说清「不能取消」，而不是给一个按不动的取消按钮。
/// </summary>
public sealed partial class EnginesPage : Page
{
    /// <summary>日志渲染上限：沿用 §9.6 的口径（§9.7「上限同上」）。超过后按批丢弃最旧行。</summary>
    private const int LogLineLimit = 1500;

    /// <summary>启动器自身的日志来源 id（<c>src/main/runtime.ts:18</c> 的 <c>LAUNCHER_LOG_ID</c>）。
    /// <c>engine:install</c> 的进度日志经 <c>logSink(LAUNCHER_LOG_ID)</c> 推送，故按实例 id <c>launcher</c> 过滤。</summary>
    private const string LauncherLogId = "launcher";

    /// <summary>空态/提示用图标（Segoe Fluent Icons 字形）。提成常量便于两处空态复用同一套语义。</summary>
    private const string GlyphDownload = "\uE896";
    private const string GlyphWarning = "\uE7BA";

    /// <summary>
    /// <c>engine:install</c> 的超时。core 侧 npm install 自身超时是 30 分钟（<c>src/core/engine.ts:32</c>），
    /// 前端必须**晚于**后端放弃，否则会在后端仍在安装时报「超时」，让用户误以为失败。
    /// </summary>
    private static readonly TimeSpan InstallTimeout = TimeSpan.FromMinutes(35);

    /// <summary><c>engine:available</c> 走 <c>npm view</c>，core 侧超时 3 分钟（<c>src/core/engine.ts:35</c>），同样放宽。</summary>
    private static readonly TimeSpan AvailableTimeout = TimeSpan.FromMinutes(4);

    /// <summary>体积列的统一说明（「未知」的两种成因写在格式化方法的注释里）。</summary>
    private const string SizeTooltipText =
        "引擎目录占用体积。「未知」表示 core 尚未统计完成（体积是惰性统计的），或该目录由链接接入。";

    /// <summary>
    /// 是否有安装在跑。**静态**：页面被导航离开再回来会换一个新实例，
    /// 若用实例字段，旧实例的安装还在跑时用户可以再点一次「安装」——
    /// 而后端的安装是并发执行的，前端必须自己挡住（§9.7「同时禁止并发发起第二次安装」）。
    /// </summary>
    private static bool InstallRunning;

    private static string? InstallRunningVersion;

    /// <summary>静态事件：某个页面实例开始/结束安装后，通知**其它**存活的页面实例刷新忙碌态表现。</summary>
    private static event EventHandler? InstallStateChanged;

    private readonly List<LogChunk> _pendingChunks = new();
    private readonly List<string> _errors = new();

    private DispatcherQueue? _dispatcher;
    private ScrollViewer? _logScrollViewer;
    private List<string> _availableVersions = new();
    private string? _availableError;
    private string? _installedError;
    private string? _removingVersion;
    private string? _lastInstallSummary;
    private int _logFlushScheduled;
    private int _droppedLines;
    private bool _eventsAttached;
    private bool _installedLoaded;
    private bool _availableLoaded;
    private bool _installedLoading;
    private bool _availableLoading;
    private bool _sizeRefreshScheduled;

    public EnginesPage()
    {
        InitializeComponent();
    }

    /// <summary>已安装版本行。</summary>
    public ObservableCollection<EngineInstalledRow> InstalledRows { get; } = new();

    /// <summary>可安装版本行。</summary>
    public ObservableCollection<EngineAvailableRow> AvailableRows { get; } = new();

    /// <summary>安装日志缓冲（独立于 P5 的日志，只收启动器来源的分片）。</summary>
    public ObservableCollection<EngineLogLine> LogLines { get; } = new();

    private bool IsBusy => InstallRunning || _removingVersion is not null;

    /* ------------------------------------------------------------------ *
     * 生命周期
     * ------------------------------------------------------------------ */

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        base.OnNavigatedTo(e);

        _dispatcher = DispatcherQueue;
        SizeChanged += OnPageSizeChanged;
        UpdateRootPadding();

        AttachEvents();
        RefreshUiState();

        _ = LoadAsync();
    }

    protected override void OnNavigatedFrom(NavigationEventArgs e)
    {
        // 必须解绑：CoreBridge.LogChunk 是长生命周期对象上的事件，页面订阅不解绑就会一直被它持有（约定 §8）。
        // 安装本身**不**取消（后端没有取消通道，见 §11 U19），这里只解除界面订阅。
        DetachEvents();
        SizeChanged -= OnPageSizeChanged;
        _dispatcher = null;

        base.OnNavigatedFrom(e);
    }

    private void AttachEvents()
    {
        if (_eventsAttached || !AppServices.IsReady)
        {
            return;
        }

        _eventsAttached = true;
        AppServices.State.EnginesChanged += OnEnginesChanged;
        // usedBy 是实例 id，显示名要通过实例列表解析：实例改名/删除后「占用」列也要跟着更新。
        AppServices.State.InstancesChanged += OnInstancesChanged;
        AppServices.Bridge.LogChunk += OnLogChunk;
        InstallStateChanged += OnInstallStateChangedStatic;
    }

    private void DetachEvents()
    {
        if (!_eventsAttached)
        {
            return;
        }

        _eventsAttached = false;
        AppServices.State.EnginesChanged -= OnEnginesChanged;
        AppServices.State.InstancesChanged -= OnInstancesChanged;
        AppServices.Bridge.LogChunk -= OnLogChunk;
        InstallStateChanged -= OnInstallStateChangedStatic;
    }

    private void OnPageSizeChanged(object sender, SizeChangedEventArgs e) => UpdateRootPadding();

    /// <summary>
    /// 页面 gutter 随宽度切换：≥ 640 epx 用 24，窄窗用 12（§2.1 硬性规则）。
    /// 判据取**内容区**宽度而不是窗口宽度 —— 官方对 NavigationView 的建议本身就是按内容区给 12/24
    /// （<c>[LRN:navview]</c>「We recommend 12px margins for your content area when NavigationView is in Minimal mode」）。
    /// </summary>
    private void UpdateRootPadding()
    {
        var narrow = ActualWidth < 640;
        RootGrid.Padding = narrow ? new Thickness(12) : new Thickness(24);
    }

    /* ------------------------------------------------------------------ *
     * 装载
     * ------------------------------------------------------------------ */

    private async Task LoadAsync()
    {
        ClearErrors();

        if (!await WaitForBackendAsync())
        {
            ShowBackendUnavailable();
            return;
        }

        AttachEvents();
        _installedLoading = true;
        _availableLoading = true;
        RefreshUiState();

        // 三个调用互不依赖，并行发出：可安装最慢（走 npm view），
        // 但不能阻塞「已安装」页签 —— §9.7 要求只让「可安装」显示进度条。
        await Task.WhenAll(LoadInstalledAsync(), LoadAvailableAsync(), LoadNodeAsync());

        _installedLoading = false;
        _availableLoading = false;
        RefreshUiState();
        MaybeScheduleSizeRefresh();
    }

    /// <summary>
    /// App 是「先把窗口立起来，再后台装配后端」（<c>App.xaml.cs:27-36</c>），页面可能比后端先到。
    /// 这里做一次有上限的等待，避免把「后端还没起来」误报成「读取失败」。
    /// </summary>
    private static async Task<bool> WaitForBackendAsync()
    {
        for (var i = 0; i < 24 && !AppServices.IsReady; i += 1)
        {
            await Task.Delay(250);
        }

        return AppServices.IsReady;
    }

    private void ShowBackendUnavailable()
    {
        _installedLoaded = false;
        _availableLoaded = false;
        _installedLoading = false;
        _availableLoading = false;
        _installedError = "后端进程尚未就绪或已断开。";
        _availableError = _installedError;
        AddError("后端不可用", "引擎列表与安装/移除都需要 Node 侧车进程；界面仍可浏览，但本页功能不可用。");
        RefreshUiState();
    }

    private async Task LoadInstalledAsync()
    {
        try
        {
            // 先刷新实例列表：usedBy 里是 id，「占用」列要显示实例名。
            var instances = await AppServices.State.RefreshInstancesAsync();
            var result = await AppServices.State.RefreshEnginesAsync();

            _installedLoaded = result.Ok;
            if (result.Ok)
            {
                _installedError = null;
            }
            else
            {
                _installedError = result.Error;
                AddError("无法读取已安装的引擎版本", result.Error);
            }

            if (!instances.Ok)
            {
                // 实例列表失败不会让本页不可用，但「占用」列会退化成「未知实例」——原因必须可见。
                AddError("无法读取实例列表", instances.Error);
            }

            // 集合内容由 EnginesChanged 事件统一转成行（单一转换点）；失败时集合没变，仍需重算界面状态。
            RebuildInstalledRows();
        }
        catch (Exception ex)
        {
            _installedLoaded = false;
            _installedError = ex.Message;
            AddError("无法读取已安装的引擎版本", ex.Message);
        }
    }

    private async Task LoadAvailableAsync()
    {
        if (!AppServices.IsReady)
        {
            return;
        }

        _availableLoading = true;
        RefreshUiState();

        try
        {
            var result = await AppServices.Bridge.CallAsync<string[]>(Channels.EngineAvailable, AvailableTimeout);
            if (result.Ok)
            {
                _availableVersions = result.Value is null ? new List<string>() : new List<string>(result.Value);
                _availableLoaded = true;
                _availableError = null;
                HideInfoBar(AvailableWarningInfoBar);
            }
            else
            {
                // 「查询失败」与「registry 上一个版本都没有」必须区分：前者是能力不可用，后者是真实结果。
                _availableLoaded = false;
                _availableError = result.Error;
                ShowAvailableWarning(result.Error);
                // 若曾经成功过，保留上一次的列表：一次网络抖动不该清空用户视野。
            }

            RebuildAvailableRows();
        }
        catch (Exception ex)
        {
            _availableLoaded = false;
            _availableError = ex.Message;
            ShowAvailableWarning(ex.Message);
            RebuildAvailableRows();
        }
        finally
        {
            _availableLoading = false;
            RefreshUiState();
        }
    }

    private async Task LoadNodeAsync()
    {
        if (!AppServices.IsReady)
        {
            return;
        }

        try
        {
            var result = await AppServices.Bridge.CallAsync<NodeRuntimeReport>(Channels.LauncherDetectNode);
            if (!result.Ok || result.Value is null)
            {
                SetNodeBadge(false, "Node 未就绪");
                NodeCaption.Text = "当前生效的 Node：未知";
                ShowNodeWarning(result.Error ?? "探测没有返回结果。");
                AddError("Node 运行时探测失败", result.Error);
                return;
            }

            var report = result.Value;
            var source = SourceLabel(report.Source);
            var version = string.IsNullOrWhiteSpace(report.Version) ? "未知版本" : report.Version!;

            if (report.Ok)
            {
                SetNodeBadge(true, $"Node {version}");
                NodeCaption.Text = $"当前生效的 Node：{version}（{source}）";
                HideInfoBar(NodeWarningInfoBar);
            }
            else
            {
                // §9.7「Node 运行时缺失」：页级 Warning + 「去全局设置修复」行动按钮，不算错误。
                SetNodeBadge(false, "Node 不可用");
                NodeCaption.Text = "当前生效的 Node：未探测到可用的 Node.js";
                ShowNodeWarning(report.Message);
            }

            ToolTipService.SetToolTip(NodeBadge, BuildNodeTooltip(report));
        }
        catch (Exception ex)
        {
            SetNodeBadge(false, "Node 未就绪");
            NodeCaption.Text = "当前生效的 Node：未知";
            ShowNodeWarning(ex.Message);
        }
    }

    private static string BuildNodeTooltip(NodeRuntimeReport report)
    {
        var lines = new List<string> { report.Message };
        if (!string.IsNullOrWhiteSpace(report.File))
        {
            lines.Add(report.File!);
        }

        return string.Join("\n", lines);
    }

    private static string SourceLabel(string? source) => source switch
    {
        NodeRuntimeSourceValues.Env => "环境变量 WHALES_NODE_PATH",
        NodeRuntimeSourceValues.Config => "全局设置里的 nodePath",
        NodeRuntimeSourceValues.Current => "启动器自身进程",
        NodeRuntimeSourceValues.Path => "系统 PATH",
        NodeRuntimeSourceValues.Common => "常见安装位置",
        _ => "来源未知",
    };

    /// <summary>
    /// core 的引擎体积是**惰性**统计的：列表只读缓存，首次返回 <c>null</c> 并在后台单飞计算
    /// （<c>src/core/engine.ts:37-45</c>）。所以看到「未知」时过几秒再刷一次列表就能拿到真实体积。
    /// 每次进页面只补一次，避免变成轮询。
    /// </summary>
    private void MaybeScheduleSizeRefresh()
    {
        if (_sizeRefreshScheduled || !AppServices.IsReady)
        {
            return;
        }

        var hasUnknown = false;
        foreach (var info in AppServices.State.Engines)
        {
            if (info.SizeBytes is null or <= 0)
            {
                hasUnknown = true;
                break;
            }
        }

        if (!hasUnknown)
        {
            return;
        }

        _sizeRefreshScheduled = true;
        var timer = DispatcherQueue.CreateTimer();
        timer.Interval = TimeSpan.FromSeconds(4);
        timer.IsRepeating = false;
        timer.Tick += OnSizeRefreshTick;
        timer.Start();
    }

    private async void OnSizeRefreshTick(DispatcherQueueTimer sender, object args)
    {
        sender.Stop();
        if (!AppServices.IsReady || IsBusy)
        {
            return;
        }

        var result = await AppServices.State.RefreshEnginesAsync();
        if (!result.Ok)
        {
            // 这是后台补充统计，不阻塞主流程，但错误仍要可见（不能只进日志）。
            AppServices.Toast.Warning("引擎体积统计刷新失败", result.Error);
        }
    }

    /* ------------------------------------------------------------------ *
     * 事件
     * ------------------------------------------------------------------ */

    private void OnEnginesChanged(object? sender, EventArgs e) => RebuildInstalledRows();

    private void OnInstancesChanged(object? sender, EventArgs e)
    {
        // 实例改名/删除会影响「占用」列的显示名；重算即可，不必重新请求引擎列表。
        RebuildInstalledRows();
    }

    private void OnInstallStateChangedStatic(object? sender, EventArgs e) => RefreshUiState();

    /// <summary>
    /// <c>log:chunk</c> 在**后台 stdout 读取线程**上触发（CoreBridge 的读取循环），
    /// 因此这里只入队、绝不碰 UI；UI 更新统一走 <see cref="FlushPendingLogs"/>。
    /// 同一轮 DispatcherQueue 内的多条分片合并成一次批量追加（§9.6「批量入队」，避免洪峰卡 UI）。
    /// </summary>
    private void OnLogChunk(object? sender, LogChunk chunk)
    {
        if (!string.Equals(chunk.InstanceId, LauncherLogId, StringComparison.Ordinal))
        {
            return;
        }

        lock (_pendingChunks)
        {
            _pendingChunks.Add(chunk);
        }

        if (Interlocked.Exchange(ref _logFlushScheduled, 1) == 1)
        {
            return;
        }

        var dispatcher = _dispatcher;
        if (dispatcher is null || !dispatcher.TryEnqueue(FlushPendingLogs))
        {
            // 入队失败（页面已卸载）时复位标记：分片仍在缓冲区里，下次分片到达会再试一次。
            Interlocked.Exchange(ref _logFlushScheduled, 0);
        }
    }

    private void FlushPendingLogs()
    {
        Interlocked.Exchange(ref _logFlushScheduled, 0);

        LogChunk[] batch;
        lock (_pendingChunks)
        {
            if (_pendingChunks.Count == 0)
            {
                return;
            }

            batch = _pendingChunks.ToArray();
            _pendingChunks.Clear();
        }

        var follow = IsLogAtBottom();
        foreach (var chunk in batch)
        {
            AppendChunkLines(chunk);
        }

        TrimLog();
        UpdateLogState();

        if (follow)
        {
            ScrollLogToEnd();
        }
    }

    private void AppendChunkLines(LogChunk chunk)
    {
        var text = chunk.Text ?? string.Empty;
        var lines = text.Split('\n');
        for (var i = 0; i < lines.Length; i += 1)
        {
            var line = lines[i].TrimEnd('\r');
            // 分片末尾常常正好落在换行上，会切出一个空串；丢掉它，否则日志里会凭空多出空行。
            if (line.Length == 0 && i == lines.Length - 1)
            {
                break;
            }

            LogLines.Add(new EngineLogLine(chunk.Stream, line, chunk.Ts));
        }
    }

    /// <summary>本页自己产生的日志行（不是后端分片），用于标注安装起止与错误原文。</summary>
    private void AppendLocalLogLine(string stream, string text) =>
        LogLines.Add(new EngineLogLine(stream, text, DateTimeOffset.Now.ToString("o")));

    private void TrimLog()
    {
        var overflow = LogLines.Count - LogLineLimit;
        if (overflow <= 0)
        {
            return;
        }

        for (var i = 0; i < overflow; i += 1)
        {
            LogLines.RemoveAt(0);
        }

        _droppedLines += overflow;
    }

    private void ScrollLogToEnd()
    {
        if (LogLines.Count == 0)
        {
            return;
        }

        InstallLogList.ScrollIntoView(LogLines[^1]);
    }

    /// <summary>仅当用户本来就在底部时才自动滚动（§9.6「跟随判定」）：用户上滚看历史时不要打断他。</summary>
    private bool IsLogAtBottom()
    {
        var viewer = _logScrollViewer;
        if (viewer is null)
        {
            return true;
        }

        return viewer.ScrollableHeight - viewer.VerticalOffset <= 8;
    }

    private void OnLogListLoaded(object sender, RoutedEventArgs e) =>
        _logScrollViewer = FindDescendant<ScrollViewer>(InstallLogList);

    private static T? FindDescendant<T>(DependencyObject root)
        where T : DependencyObject
    {
        var count = VisualTreeHelper.GetChildrenCount(root);
        for (var i = 0; i < count; i += 1)
        {
            var child = VisualTreeHelper.GetChild(root, i);
            if (child is T target)
            {
                return target;
            }

            var found = FindDescendant<T>(child);
            if (found is not null)
            {
                return found;
            }
        }

        return null;
    }

    /* ------------------------------------------------------------------ *
     * 行集合构建（id → 显示的唯一边界）
     * ------------------------------------------------------------------ */

    private void RebuildInstalledRows()
    {
        if (!AppServices.IsReady)
        {
            return;
        }

        InstalledRows.Clear();
        foreach (var info in AppServices.State.Engines)
        {
            var names = ResolveUsageNames(info.UsedBy, diagnostic: false);
            var diagnosticNames = ResolveUsageNames(info.UsedBy, diagnostic: true);
            InstalledRows.Add(new EngineInstalledRow(info, names, diagnosticNames, SizeTooltipText));
        }

        // 已安装集合变了，可安装行的「已安装」徽标要跟着变。
        SyncAvailableInstalledFlags();
        RefreshUiState();
    }

    /// <summary>
    /// <c>usedBy</c> 是实例 id 列表，界面显示实例名（契约要求"不显示裸 id"）。
    /// 解析不到时主文案退化成「未知实例」，只把 id 放进 ToolTip 供排查。
    /// </summary>
    private static IReadOnlyList<string> ResolveUsageNames(IReadOnlyList<string>? usedBy, bool diagnostic)
    {
        var names = new List<string>();
        if (usedBy is null)
        {
            return names;
        }

        foreach (var id in usedBy)
        {
            var summary = AppServices.State.FindInstance(id);
            var name = summary?.Meta.Name;
            if (!string.IsNullOrWhiteSpace(name))
            {
                names.Add(name!);
            }
            else
            {
                names.Add(diagnostic ? $"未知实例（{id}）" : "未知实例");
            }
        }

        return names;
    }

    private void RebuildAvailableRows()
    {
        if (!AppServices.IsReady)
        {
            return;
        }

        var installed = new HashSet<string>(StringComparer.Ordinal);
        foreach (var info in AppServices.State.Engines)
        {
            installed.Add(info.Version);
        }

        AvailableRows.Clear();
        foreach (var version in _availableVersions)
        {
            AvailableRows.Add(new EngineAvailableRow(version, installed.Contains(version)));
        }

        RefreshUiState();
    }

    private void SyncAvailableInstalledFlags()
    {
        var installed = new HashSet<string>(StringComparer.Ordinal);
        foreach (var info in AppServices.State.Engines)
        {
            installed.Add(info.Version);
        }

        foreach (var row in AvailableRows)
        {
            row.IsInstalled = installed.Contains(row.Version);
        }
    }

    /* ------------------------------------------------------------------ *
     * 安装
     * ------------------------------------------------------------------ */

    private void OnInstallClick(object sender, RoutedEventArgs e)
    {
        if (sender is FrameworkElement { Tag: EngineAvailableRow row })
        {
            _ = StartInstallAsync(row.Version);
        }
    }

    /// <summary>空态里的「安装最新版」：core 已按版本从新到旧排序（<c>src/core/engine.ts:154</c>）。</summary>
    private void OnInstallLatestClick(object sender, RoutedEventArgs e) => _ = InstallLatestAsync();

    private async Task InstallLatestAsync()
    {
        if (_availableVersions.Count == 0)
        {
            await LoadAvailableAsync();
        }

        if (_availableVersions.Count == 0)
        {
            AppServices.Toast.Warning(
                "暂时拿不到可安装版本",
                _availableError ?? "registry 没有返回任何版本，请稍后重试。");
            return;
        }

        // 让用户看到正在安装的那一行（安装进度与日志都挂在「可安装」页签上）
        ViewSelector.SelectedItem = AvailableTab;
        await StartInstallAsync(_availableVersions[0]);
    }

    private async Task StartInstallAsync(string version)
    {
        if (IsBusy)
        {
            AppServices.Toast.Warning("已有安装或移除在进行中", "后端不支持取消安装，请等待当前操作结束。");
            return;
        }

        var registry = AppServices.State.Config?.EngineRegistry;
        var registryText = string.IsNullOrWhiteSpace(registry) ? "未配置（由 npm 默认值决定）" : registry!;
        var confirmed = await ConfirmAsync(
            $"安装 dsh {version}",
            $"将执行 npm install @deepseek-ai/dsh@{version}\nregistry：{registryText}\n\n"
            + "安装期间会持续输出日志。当前后端没有取消安装的通道，一旦开始只能等它结束。",
            "开始安装");
        if (!confirmed)
        {
            return;
        }

        ClearErrors();
        InstallRunning = true;
        InstallRunningVersion = version;
        _lastInstallSummary = null;
        InstallStateChanged?.Invoke(null, EventArgs.Empty);

        // §9.7：安装开始时自动展开日志
        InstallLogExpander.IsExpanded = true;
        AppendLocalLogLine(LogStreamValues.System, $"— 开始安装 @deepseek-ai/dsh@{version}（registry：{registryText}）—");
        RefreshUiState();
        ScrollLogToEnd();

        try
        {
            var result = await AppServices.Bridge.CallAsync<EngineInfo>(Channels.EngineInstall, InstallTimeout, version);
            if (result.Ok)
            {
                AppendLocalLogLine(LogStreamValues.System, $"— 安装完成：{version} —");
                _lastInstallSummary = $"最近一次安装成功：{version}";
                AppServices.Toast.Success($"引擎 {version} 安装完成", "已重新读取本机引擎列表。");

                var refreshed = await AppServices.State.RefreshEnginesAsync();
                if (!refreshed.Ok)
                {
                    AddError("引擎已安装，但列表刷新失败", refreshed.Error);
                }

                RebuildInstalledRows();
                MaybeScheduleSizeRefresh();
            }
            else
            {
                // §9.7：安装失败 → Error InfoBar（原文可复制）+ 展开日志 + 按钮恢复可点
                AppendLocalLogLine(LogStreamValues.Stderr, result.Error ?? "安装失败（后端未返回原因）。");
                _lastInstallSummary = $"最近一次安装失败：{version}";
                InstallLogExpander.IsExpanded = true;
                AddError($"安装引擎 {version} 失败", result.Error);
            }
        }
        catch (Exception ex)
        {
            // 桥接层自身异常（后端已断开、超时等）：同样必须可见
            AppendLocalLogLine(LogStreamValues.Stderr, ex.Message);
            _lastInstallSummary = $"最近一次安装失败：{version}";
            AddError($"安装引擎 {version} 失败", ex.Message);
        }
        finally
        {
            InstallRunning = false;
            InstallRunningVersion = null;
            InstallStateChanged?.Invoke(null, EventArgs.Empty);
            RefreshUiState();
        }
    }

    /* ------------------------------------------------------------------ *
     * 移除
     * ------------------------------------------------------------------ */

    private void OnRemoveClick(object sender, RoutedEventArgs e)
    {
        if (sender is FrameworkElement { Tag: EngineInstalledRow row })
        {
            _ = RemoveAsync(row);
        }
    }

    private async Task RemoveAsync(EngineInstalledRow row)
    {
        if (row.IsUsed)
        {
            // 正常情况下按钮已禁用，这里是双保险（后端也会拒绝，但没必要走一趟往返）。
            AppServices.Toast.Warning(
                $"引擎 {row.Version} 正被占用",
                row.UsedText + " 请先把这些实例切换到其它引擎版本。");
            return;
        }

        if (IsBusy)
        {
            AppServices.Toast.Warning("已有安装或移除在进行中", "请等待当前操作结束。");
            return;
        }

        if (!AppServices.IsReady)
        {
            AppServices.Toast.Error("后端不可用", "引擎移除需要 Node 侧车进程。");
            return;
        }

        var confirmed = await ConfirmAsync(
            $"移除引擎 {row.Version}",
            $"将删除引擎目录：\n{row.Dir}\n\n"
            + "该版本当前没有被任何实例使用。删除后若要再次使用必须重新安装（需要联网）。",
            "移除",
            destructive: true);
        if (!confirmed)
        {
            return;
        }

        ClearErrors();
        _removingVersion = row.Version;
        row.RowBusy = true;
        RefreshUiState();

        try
        {
            var result = await AppServices.Bridge.CallVoidAsync(Channels.EngineRemove, row.Version);
            if (result.Ok)
            {
                AppServices.Toast.Success($"引擎 {row.Version} 已移除");
                var refreshed = await AppServices.State.RefreshEnginesAsync();
                if (!refreshed.Ok)
                {
                    AddError("引擎已移除，但列表刷新失败", refreshed.Error);
                }

                // 重建后 row 已不在集合里；可安装行的「已安装」徽标也会随之消失。
                RebuildInstalledRows();
            }
            else
            {
                AddError($"移除引擎 {row.Version} 失败", result.Error);
                row.RowBusy = false;
            }
        }
        catch (Exception ex)
        {
            AddError($"移除引擎 {row.Version} 失败", ex.Message);
            row.RowBusy = false;
        }
        finally
        {
            _removingVersion = null;
            RefreshUiState();
        }
    }

    /* ------------------------------------------------------------------ *
     * 其它交互
     * ------------------------------------------------------------------ */

    private void OnRefreshAvailableClick(object sender, RoutedEventArgs e) => _ = LoadAvailableAsync();

    private void OnRefreshInstalledClick(object sender, RoutedEventArgs e) => _ = RefreshInstalledAsync();

    private async Task RefreshInstalledAsync()
    {
        if (!AppServices.IsReady)
        {
            return;
        }

        ClearErrors();
        _installedLoading = true;
        RefreshUiState();
        try
        {
            await LoadInstalledAsync();
        }
        finally
        {
            _installedLoading = false;
            RefreshUiState();
        }
    }

    private void OnGoToSettingsClick(object sender, RoutedEventArgs e)
    {
        if (!AppServices.IsReady)
        {
            return;
        }

        AppServices.Navigation.Navigate(RouteKeys.Settings);
    }

    /// <summary>
    /// 确认对话框的统一入口。
    ///
    /// <see cref="DialogService"/> 要求外壳先挂载 <c>XamlRoot</c>，未挂载时会抛明确异常；
    /// 那种情况下不能把用户的操作静默吞掉（点了没反应），必须给出可见提示并放弃本次操作。
    /// </summary>
    private async Task<bool> ConfirmAsync(string title, string message, string primaryText, bool destructive = false)
    {
        try
        {
            return await AppServices.Dialogs.ConfirmAsync(title, message, primaryText, "取消", destructive);
        }
        catch (Exception ex)
        {
            AddError("无法打开确认对话框", ex.Message);
            return false;
        }
    }

    private void OnViewSelectionChanged(SelectorBar sender, SelectorBarSelectionChangedEventArgs args)
    {
        // 标记里写了 IsSelected="True"，该事件可能在 InitializeComponent 期间、
        // 后续元素尚未构造时触发 —— 此时这些字段仍是 null，必须先判空。
        if (InstalledView is null || AvailableView is null)
        {
            return;
        }

        var available = ReferenceEquals(sender.SelectedItem, AvailableTab);
        InstalledView.Visibility = available ? Visibility.Collapsed : Visibility.Visible;
        AvailableView.Visibility = available ? Visibility.Visible : Visibility.Collapsed;
    }

    private void OnCopyLogClick(object sender, RoutedEventArgs e)
    {
        if (LogLines.Count == 0)
        {
            return;
        }

        var builder = new StringBuilder();
        foreach (var line in LogLines)
        {
            builder.Append(line.TimeText).Append(' ').Append(line.StreamLabel).Append(' ').Append(line.Text).Append('\n');
        }

        TryCopyToClipboard(builder.ToString(), $"已复制 {LogLines.Count} 行安装日志");
    }

    private static void TryCopyToClipboard(string text, string successMessage)
    {
        try
        {
            var package = new DataPackage();
            package.SetText(text);
            Clipboard.SetContent(package);
            AppServices.Toast.Success(successMessage);
        }
        catch (Exception ex)
        {
            AppServices.Toast.Error("复制到剪贴板失败", ex.Message);
        }
    }

    private void OnClearLogClick(object sender, RoutedEventArgs e)
    {
        LogLines.Clear();
        _droppedLines = 0;
        UpdateLogState();
        AppServices.Toast.Info("安装日志已清空");
    }

    /* ------------------------------------------------------------------ *
     * 界面状态（单一入口：任何状态变化后都调它，避免多处各写一半）
     * ------------------------------------------------------------------ */

    private void RefreshUiState()
    {
        if (RootGrid is null)
        {
            return;
        }

        var busy = IsBusy;

        RefreshAvailableButton.IsEnabled = !busy && !_availableLoading && AppServices.IsReady;
        InstalledProgressBar.Visibility = _installedLoading ? Visibility.Visible : Visibility.Collapsed;
        AvailableProgressBar.Visibility = _availableLoading ? Visibility.Visible : Visibility.Collapsed;
        InstallProgressPanel.Visibility = InstallRunning ? Visibility.Visible : Visibility.Collapsed;

        foreach (var row in InstalledRows)
        {
            row.PageBusy = busy;
        }

        foreach (var row in AvailableRows)
        {
            row.PageBusy = busy;
            row.RowBusy = InstallRunning && string.Equals(row.Version, InstallRunningVersion, StringComparison.Ordinal);
        }

        UpdateInstalledState();
        UpdateAvailableState();
        UpdateLogState();
    }

    /// <summary>已安装视图三态：列表 / 首屏加载 / 空态（空态再分「一个都没装」与「读不到」）。</summary>
    private void UpdateInstalledState()
    {
        var hasRows = InstalledRows.Count > 0;
        var firstLoad = _installedLoading && !_installedLoaded && !hasRows;

        InstalledHeader.Visibility = hasRows ? Visibility.Visible : Visibility.Collapsed;
        InstalledList.Visibility = hasRows ? Visibility.Visible : Visibility.Collapsed;
        InstalledFirstLoad.Visibility = firstLoad ? Visibility.Visible : Visibility.Collapsed;
        InstalledEmpty.Visibility = !hasRows && !firstLoad ? Visibility.Visible : Visibility.Collapsed;

        if (InstalledEmpty.Visibility != Visibility.Visible)
        {
            return;
        }

        if (_installedLoaded)
        {
            InstalledEmptyIcon.Glyph = GlyphDownload;
            InstalledEmptyTitle.Text = "还没有安装任何引擎版本";
            InstalledEmptyDesc.Text = "实例必须绑定一个引擎版本才能启动。点「安装最新版」从 registry 装一个。";
            InstalledEmptyInstallButton.Visibility = Visibility.Visible;
            InstalledEmptyRetryButton.Visibility = Visibility.Collapsed;
        }
        else
        {
            // 「读不到」与「一个都没装」不是一回事：这里绝不能显示成"空"的文案，
            // 否则用户会以为自己的引擎丢了。
            InstalledEmptyIcon.Glyph = GlyphWarning;
            InstalledEmptyTitle.Text = "无法读取本机引擎列表";
            InstalledEmptyDesc.Text = _installedError is null
                ? "读取 engines 目录失败，稍后可以重试。"
                : $"读取 engines 目录失败：{_installedError}";
            InstalledEmptyInstallButton.Visibility = Visibility.Collapsed;
            InstalledEmptyRetryButton.Visibility = Visibility.Visible;
        }
    }

    /// <summary>可安装视图三态：列表 / 首屏加载 / 空态（空态再分「查询失败」与「确实没有版本」）。</summary>
    private void UpdateAvailableState()
    {
        var hasRows = AvailableRows.Count > 0;
        var firstLoad = _availableLoading && !_availableLoaded && !hasRows;

        AvailableHeader.Visibility = hasRows ? Visibility.Visible : Visibility.Collapsed;
        AvailableList.Visibility = hasRows ? Visibility.Visible : Visibility.Collapsed;
        AvailableFirstLoad.Visibility = firstLoad ? Visibility.Visible : Visibility.Collapsed;
        AvailableEmpty.Visibility = !hasRows && !firstLoad ? Visibility.Visible : Visibility.Collapsed;

        if (AvailableEmpty.Visibility != Visibility.Visible)
        {
            return;
        }

        if (_availableLoaded)
        {
            AvailableEmptyIcon.Glyph = GlyphDownload;
            AvailableEmptyTitle.Text = "registry 上没有可安装的版本";
            AvailableEmptyDesc.Text = "查询成功但返回了空列表。可以在「全局设置」里换一个 npm registry 后再刷新。";
        }
        else
        {
            AvailableEmptyIcon.Glyph = GlyphWarning;
            AvailableEmptyTitle.Text = "无法获取可用版本";
            AvailableEmptyDesc.Text = _availableError is null
                ? "查询 npm registry 失败（离线或 registry 不可达）。注意这不是「一个版本都没有」。"
                : $"查询 npm registry 失败（离线或 registry 不可达）。注意这不是「一个版本都没有」：{_availableError}";
        }
    }

    private void UpdateLogState()
    {
        if (CopyLogButton is null)
        {
            return;
        }

        var hasLines = LogLines.Count > 0;
        CopyLogButton.IsEnabled = hasLines;
        ClearLogButton.IsEnabled = hasLines;
        LogLineCountText.Text = !hasLines
            ? "暂无日志"
            : _droppedLines > 0
                ? $"共 {LogLines.Count} 行（较早的 {_droppedLines} 行已丢弃）"
                : $"共 {LogLines.Count} 行";

        LogHeaderStatus.Text = InstallRunning
            ? $"正在安装 {InstallRunningVersion}…（后端没有取消通道，请等它结束）"
            : _lastInstallSummary ?? string.Empty;
    }

    private void SetNodeBadge(bool ok, string text)
    {
        NodeBadgeText.Text = text;
        NodeBadgeOkIcon.Visibility = ok ? Visibility.Visible : Visibility.Collapsed;
        NodeBadgeFailIcon.Visibility = ok ? Visibility.Collapsed : Visibility.Visible;
    }

    /* ------------------------------------------------------------------ *
     * InfoBar
     * ------------------------------------------------------------------ */

    /// <summary>
    /// 错误区是**累积**的：一次装载可能同时失败两三个调用，只显示最后一条会漏掉原因。
    /// 同时发一条 toast —— toast 会被忽略，InfoBar 常驻且原文可复制。
    /// </summary>
    private void AddError(string title, string? detail)
    {
        _errors.Add(string.IsNullOrWhiteSpace(detail) ? title : $"{title}：{detail}");

        ErrorInfoBar.Title = _errors.Count > 1 ? $"操作失败（{_errors.Count} 项）" : title;
        ErrorDetailText.Text = string.Join("\n", _errors);
        ShowInfoBar(ErrorInfoBar);
        AppServices.Toast.Error(title, detail);
    }

    private void ClearErrors()
    {
        _errors.Clear();
        HideInfoBar(ErrorInfoBar);
    }

    private void ShowNodeWarning(string detail)
    {
        NodeWarningText.Text = detail;
        ShowInfoBar(NodeWarningInfoBar);
    }

    private void ShowAvailableWarning(string? detail)
    {
        AvailableWarningText.Text = string.IsNullOrWhiteSpace(detail)
            ? "查询 npm registry 失败（离线或 registry 不可达）。"
            : detail!;
        ShowInfoBar(AvailableWarningInfoBar);
    }

    /// <summary>InfoBar 关闭时既要 IsOpen=false 也要折叠：关闭态在默认样式下不一定收起占位。</summary>
    private static void ShowInfoBar(InfoBar bar)
    {
        bar.IsOpen = true;
        bar.Visibility = Visibility.Visible;
    }

    private static void HideInfoBar(InfoBar bar)
    {
        bar.IsOpen = false;
        bar.Visibility = Visibility.Collapsed;
    }
}

/// <summary>
/// 引擎列表行的公共部分：忙碌状态 + 派生属性（按钮可用性/可见性/ToolTip）的通知。
///
/// 为什么放在本页面文件里（而不是 Models/ 或 Controls/）：它是**纯展示**的行视图模型，只服务 P6；
/// 放共享层会污染契约镜像层（约定 §3 规定 Models 只做契约镜像、不写逻辑）。
/// </summary>
public abstract class EngineRowBase : INotifyPropertyChanged
{
    private bool _pageBusy;
    private bool _rowBusy;

    public event PropertyChangedEventHandler? PropertyChanged;

    /// <summary>页面级忙碌：有安装或移除在进行 → 所有动作按钮禁用（§11 U19：后端没有取消通道）。</summary>
    public bool PageBusy
    {
        get => _pageBusy;
        set
        {
            if (_pageBusy == value)
            {
                return;
            }

            _pageBusy = value;
            Raise(nameof(PageBusy));
            OnBusyChanged();
        }
    }

    /// <summary>本行自己的动作正在执行（该行按钮换成内联 ProgressRing）。</summary>
    public bool RowBusy
    {
        get => _rowBusy;
        set
        {
            if (_rowBusy == value)
            {
                return;
            }

            _rowBusy = value;
            Raise(nameof(RowBusy));
            OnBusyChanged();
        }
    }

    /// <summary>忙碌态变化后，子类必须把**派生属性**逐个通知出去，否则 x:Bind 不会刷新。</summary>
    protected abstract void OnBusyChanged();

    /// <summary>行内忙碌指示（ProgressRing + 文案）的可见性。</summary>
    public Visibility BusyVisibility => RowBusy ? Visibility.Visible : Visibility.Collapsed;

    /// <summary>动作按钮的可见性（忙碌时让位给行内忙碌指示）。</summary>
    public Visibility ActionButtonVisibility => RowBusy ? Visibility.Collapsed : Visibility.Visible;

    protected void Raise(string name) =>
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}

/// <summary>已安装引擎的一行（列宽见 EnginesPage.xaml 的 InstalledEngineTemplate）。</summary>
public sealed class EngineInstalledRow : EngineRowBase
{
    public EngineInstalledRow(
        EngineInfo info,
        IReadOnlyList<string> usedByNames,
        IReadOnlyList<string> usedByDiagnosticNames,
        string sizeTooltip)
    {
        Version = info.Version;
        Dir = info.Dir;
        DirDisplay = Formatters.ShortenPath(info.Dir);
        // 只用 Formatters.FormatEngineSize：0 与 null 都显示「未知」，不在这里兜底成 0 B。
        SizeText = Formatters.FormatEngineSize(info.SizeBytes);
        SizeTooltip = sizeTooltip;
        UsedByCount = usedByNames.Count;
        IsUsed = usedByNames.Count > 0;
        FreeText = "未被占用";
        UsedText = $"被 {UsedByCount} 个实例占用：{string.Join("、", usedByNames)}";
        UsedTooltip = $"被 {UsedByCount} 个实例占用：{string.Join("、", usedByDiagnosticNames)}";
    }

    public string Version { get; }

    public string Dir { get; }

    public string DirDisplay { get; }

    public string SizeText { get; }

    public string SizeTooltip { get; }

    /// <summary>是否被实例占用。占用中的版本**不允许**移除（后端也会拒绝；§9.7 明确禁止「强制移除」）。</summary>
    public bool IsUsed { get; }

    public int UsedByCount { get; }

    public string FreeText { get; }

    public string UsedText { get; }

    public string UsedTooltip { get; }

    public Visibility FreeVisibility => IsUsed ? Visibility.Collapsed : Visibility.Visible;

    public Visibility UsedVisibility => IsUsed ? Visibility.Visible : Visibility.Collapsed;

    public Visibility RemoveButtonVisibility => ActionButtonVisibility;

    public bool CanRemove => !IsUsed && !PageBusy && !RowBusy;

    public string RemoveTooltip
    {
        get
        {
            if (IsUsed)
            {
                return $"该版本正被 {UsedByCount} 个实例占用，不能移除。请先把这些实例切换到其它引擎版本。";
            }

            if (RowBusy)
            {
                return "正在移除该版本…";
            }

            return PageBusy
                ? "有安装或移除正在进行：后端没有取消通道，请等它结束。"
                : $"移除引擎目录：{Dir}";
        }
    }

    protected override void OnBusyChanged()
    {
        Raise(nameof(CanRemove));
        Raise(nameof(RemoveTooltip));
        Raise(nameof(RemoveButtonVisibility));
        Raise(nameof(BusyVisibility));
        Raise(nameof(ActionButtonVisibility));
    }
}

/// <summary>可安装版本的一行（列宽见 EnginesPage.xaml 的 AvailableEngineTemplate）。</summary>
public sealed class EngineAvailableRow : EngineRowBase
{
    private bool _isInstalled;

    public EngineAvailableRow(string version, bool installed)
    {
        Version = version;
        _isInstalled = installed;
    }

    public string Version { get; }

    /// <summary>本机是否已安装该版本：已安装的行显示「已安装」徽标且按钮禁用（§9.7）。</summary>
    public bool IsInstalled
    {
        get => _isInstalled;
        set
        {
            if (_isInstalled == value)
            {
                return;
            }

            _isInstalled = value;
            Raise(nameof(IsInstalled));
            OnBusyChanged();
        }
    }

    public Visibility InstalledBadgeVisibility => IsInstalled ? Visibility.Visible : Visibility.Collapsed;

    public Visibility InstallButtonVisibility => ActionButtonVisibility;

    public bool CanInstall => !IsInstalled && !PageBusy && !RowBusy;

    public string InstallTooltip
    {
        get
        {
            if (IsInstalled)
            {
                return "该版本已经装在本机，无需重复安装。";
            }

            if (RowBusy)
            {
                return "正在安装该版本。后端没有取消安装的通道，只能等它结束。";
            }

            return PageBusy
                ? "已有安装或移除在进行：后端没有取消通道，请等它结束。"
                : $"安装 @deepseek-ai/dsh@{Version}（从全局设置里的 npm registry 下载）。";
        }
    }

    protected override void OnBusyChanged()
    {
        Raise(nameof(CanInstall));
        Raise(nameof(InstallTooltip));
        Raise(nameof(InstallButtonVisibility));
        Raise(nameof(BusyVisibility));
        Raise(nameof(ActionButtonVisibility));
        Raise(nameof(InstalledBadgeVisibility));
    }
}

/// <summary>
/// 安装日志的一行。内容不可变（只有新增没有修改），因此不需要变更通知——
/// 这样 1500 行的缓冲也不会带来额外的属性变更开销。
/// </summary>
public sealed class EngineLogLine
{
    public EngineLogLine(string stream, string text, string ts)
    {
        Stream = IsKnownStream(stream) ? stream : LogStreamValues.System;
        Text = text ?? string.Empty;
        TimeText = Formatters.FormatClock(ts);
    }

    /// <summary>取值见 <see cref="LogStreamValues"/>；未知取值按 system 处理（不丢行，也不误标成 stdout）。</summary>
    public string Stream { get; }

    public string Text { get; }

    public string TimeText { get; }

    /// <summary>流标签：与 §9.6 一致，独立成固定宽 56 的列。</summary>
    public string StreamLabel => Stream;

    /// <summary>system 流用「· 」前缀区分（§9.6：字阶里没有斜体，不能靠斜体表达）。</summary>
    public string SystemText => "· " + Text;

    public Visibility StdoutVisibility => Stream == LogStreamValues.Stdout ? Visibility.Visible : Visibility.Collapsed;

    public Visibility StderrVisibility => Stream == LogStreamValues.Stderr ? Visibility.Visible : Visibility.Collapsed;

    public Visibility SystemVisibility => Stream == LogStreamValues.System ? Visibility.Visible : Visibility.Collapsed;

    private static bool IsKnownStream(string stream)
    {
        foreach (var known in LogStreamValues.All)
        {
            if (string.Equals(known, stream, StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }
}

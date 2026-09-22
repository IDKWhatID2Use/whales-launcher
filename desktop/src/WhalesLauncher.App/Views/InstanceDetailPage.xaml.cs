using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Navigation;
using WhalesLauncher.Models;
using WhalesLauncher.Services;
using WhalesLauncher.Views.Detail;

namespace WhalesLauncher.Views;

/// <summary>
/// 实例详情外壳（P2–P5 的宿主）。
///
/// 职责边界：页头状态与主操作、4 个页签的切换与生命周期、实例级错误/降级呈现、
/// 实例被外部删除时的空态。**各页签的业务全部在 `Views/Detail/**` 里**，
/// 这里不碰插件/设置/存档/日志的具体逻辑。
///
/// 两个关键实现选择：
/// <list type="bullet">
///   <item><description>4 个子视图**常驻**可视树、只切 <c>Visibility</c>：与规范 §6.3 不选
///   <c>TabView</c> 的理由一致 —— 切页不该丢编辑态与滚动位置。</description></item>
///   <item><description>切离设置页前询问未保存的 YAML 编辑（规范 §9.4「页面离开时提示」）。</description></item>
/// </list>
/// </summary>
public sealed partial class InstanceDetailPage : Page
{
    /// <summary>页签定义（顺序即显示顺序，与 DetailTabs.All 一致）。</summary>
    private sealed record TabEntry(string Key, string Label, FrameworkElement View);

    private readonly List<TabEntry> _tabs = new();

    private InstanceSummary? _instance;
    private InstanceRuntime? _runtime;
    private string _instanceId = string.Empty;
    private string _currentTab = DetailTabs.Plugins;

    /// <summary>
    /// 标签切换的「就绪门闩」。
    ///
    /// 为什么需要：XAML 里第一个 <c>SelectorBarItem</c> 带 <c>IsSelected="True"</c>（插件），
    /// 它的 <c>SelectionChanged</c> 会**异步**派发，时机晚于 <c>OnNavigatedTo</c> 里的
    /// <see cref="UpdateTabSelection"/>，于是把 <c>_currentTab</c> 覆盖回「插件」——
    /// 表现为**带参数进入详情页（深链 / 从列表点「详情」指定页签）时内容区停在插件页**。
    /// 装载完成前一律忽略标签事件，装载完成后再放行用户操作。
    /// </summary>
    private bool _tabsReady;
    private bool _suppressTabEvents;
    private bool _subscriptionsAttached;

    public InstanceDetailPage()
    {
        InitializeComponent();

        BuildTabBar();
        AttachSubscriptions();
    }

    /* ------------------------------------------------------------------ *
     * 导航生命周期
     * ------------------------------------------------------------------ */

    protected override async void OnNavigatedTo(NavigationEventArgs e)
    {
        base.OnNavigatedTo(e);

        var args = e.Parameter as DetailNavArgs;

        // 刷新时可能带新参数；不带参数（如从外壳返回）时沿用已记住的实例
        if (args is not null && !string.IsNullOrEmpty(args.InstanceId))
        {
            _instanceId = args.InstanceId;
            _currentTab = DetailTabs.IsValid(args.Tab) ? args.Tab : DetailTabs.Plugins;
            _instance = null;
            _runtime = null;
        }

        if (string.IsNullOrEmpty(_instanceId))
        {
            ShowMissing("没有收到实例标识，请从实例列表重新进入。");
            return;
        }

        await LoadAsync();
    }

    protected override void OnNavigatedFrom(NavigationEventArgs e)
    {
        base.OnNavigatedFrom(e);

        // 离开后重新落下门闩：下次进入时仍要先完成装载再接受标签事件
        _tabsReady = false;

        // 简报 §4.9 硬性要求：离开页面必须解绑，否则桥接/状态层会一直持有本页
        DetachSubscriptions();

        foreach (var tab in _tabs)
        {
            switch (tab.View)
            {
                case LogsView logs:
                    logs.Unload();
                    break;
                case SavesView saves:
                    saves.Unload();
                    break;
                case InstanceSettingsView settings:
                    settings.Unload();
                    break;
            }
        }
    }

    private async Task LoadAsync()
    {
        var instance = AppServices.State.FindInstance(_instanceId);

        // 列表里没有 → 可能只是还没拉过 instance:list（例如直接深链进来），先刷新一次再判定
        if (instance is null)
        {
            await AppServices.State.RefreshInstancesAsync();
            instance = AppServices.State.FindInstance(_instanceId);
        }

        if (instance is null)
        {
            ShowMissing($"实例 {_instanceId} 已不在实例列表中（可能被外部删除或改名）。");
            return;
        }

        await RefreshRuntimeQuietAsync(instance);

        Header.Visibility = Visibility.Visible;
        TabBar.Visibility = Visibility.Visible;
        TabHost.Visibility = Visibility.Visible;
        MissingState.Visibility = Visibility.Collapsed;

        _instance = instance;
        _runtime = instance.Runtime;

        EnsureTabs();
        Render();
        UpdateTabSelection();
        await LoadCurrentTabAsync();

        // 装载完成，放行标签事件（见 _tabsReady 的说明）
        _tabsReady = true;

        // 再兜一次：SelectorBar 的 SelectionChanged 可能是**异步**派发的，即晚于上面这行
        // 才到达。那时 _tabsReady 已为 true、_suppressTabEvents 已复位，事件会以为用户点了
        // 页签，把 _currentTab 覆写回 BuildTabBar 在装载期设的默认项（「插件」）。
        // 实测症状：深链 detail/<id>/settings 进入时，标题栏、页签选中态、面包屑三处都
        // 显示「插件」，内容区也是插件页 —— 带页签的深链失效。
        //
        // 用 DispatcherQueue 的 Low 优先级重排：它排在所有已入队的工作之后，因此那些
        // 异步派发的标签事件一定已经落地，这次收敛才是有效的（Task.Yield 只让出一次，
        // 实测不足以保证这一点）。
        var dispatcher = Microsoft.UI.Dispatching.DispatcherQueue.GetForCurrentThread();
        if (dispatcher is not null)
        {
            dispatcher.TryEnqueue(
                Microsoft.UI.Dispatching.DispatcherQueuePriority.Low,
                UpdateTabSelection);
        }
        else
        {
            UpdateTabSelection();
        }
    }

    /* ------------------------------------------------------------------ *
     * 自适应边距（规范 §2.1 硬性规则）
     * ------------------------------------------------------------------ */

    /// <summary>
    /// 窗口宽 ≥ 640 epx 用 24 epx gutter，< 640 用 12 epx。
    ///
    /// 规范把这条列为**硬性规则**（`[LRN:alignment-margin-padding]`：小窗口 12、大窗口 24），
    /// 而 XAML 没有"按宽度取边距"的声明式写法，只能用 <c>SizeChanged</c>。
    /// 只在跨过阈值时赋值，避免每次尺寸变化都触发一次布局失效。
    /// </summary>
    private void OnPageRootSizeChanged(object sender, SizeChangedEventArgs e)
    {
        var narrow = e.NewSize.Width < 640;
        var target = narrow ? 12d : 24d;

        if (Math.Abs(PageRoot.Padding.Left - target) < 0.5)
        {
            return;
        }

        PageRoot.Padding = new Thickness(target);
    }

    /* ------------------------------------------------------------------ *
     * 页签
     * ------------------------------------------------------------------ */

    private void BuildTabBar()
    {
        TabBar.Items.Clear();
        for (var i = 0; i < DetailTabs.All.Length; i++)
        {
            var key = DetailTabs.All[i];
            TabBar.Items.Add(new SelectorBarItem
            {
                Text = DetailTabs.Label(key),
                Tag = key,
                IsSelected = i == 0,
            });
        }
    }

    /// <summary>延迟创建 4 个子视图：只在实例确实存在后才建，避免空态下白跑一遍构造。</summary>
    private void EnsureTabs()
    {
        if (_tabsReady)
        {
            return;
        }

        var plugins = new PluginsView();
        var settings = new InstanceSettingsView();
        var saves = new SavesView();
        var logs = new LogsView();

        foreach (var view in new FrameworkElement[] { plugins, settings, saves, logs })
        {
            view.Visibility = Visibility.Collapsed;
            TabHost.Children.Add(view);
        }

        _tabs.Add(new TabEntry(DetailTabs.Plugins, DetailTabs.Label(DetailTabs.Plugins), plugins));
        _tabs.Add(new TabEntry(DetailTabs.Settings, DetailTabs.Label(DetailTabs.Settings), settings));
        _tabs.Add(new TabEntry(DetailTabs.Saves, DetailTabs.Label(DetailTabs.Saves), saves));
        _tabs.Add(new TabEntry(DetailTabs.Logs, DetailTabs.Label(DetailTabs.Logs), logs));

        _tabsReady = true;
    }

    /// <summary>
    /// 把选中项切到 <see cref="_currentTab"/>，**并同步一次可见性**。
    ///
    /// 为什么必须在这里也设一次 <c>Visibility</c>：<c>SelectorBar</c> 在"选中项本来就是它"时
    /// **不会**触发 <c>SelectionChanged</c>。装载路径上 `_currentTab` 初始值就是 <c>plugins</c>，
    /// 而 <see cref="BuildTabBar"/> 也已把第一项设为 <c>IsSelected = true</c>，于是事件永远不会来 ——
    /// 只靠事件驱动可见性会让 4 个子视图全部停在 <c>Collapsed</c>，
    /// 表现为"页头与页签都在、内容区一片空白"（实测截图确认）。
    /// 把可见性收敛到本方法后，无论事件来不来，装载后都有且只有一个视图可见。
    /// </summary>
    private void UpdateTabSelection()
    {
        _suppressTabEvents = true;
        try
        {
            foreach (var entry in _tabs)
            {
                entry.View.Visibility = entry.Key == _currentTab ? Visibility.Visible : Visibility.Collapsed;
            }

            foreach (var item in TabBar.Items)
            {
                if (item is SelectorBarItem barItem && barItem.Tag as string == _currentTab)
                {
                    TabBar.SelectedItem = barItem;
                    return;
                }
            }
        }
        finally
        {
            _suppressTabEvents = false;
        }
    }

    private async void OnTabChanged(SelectorBar sender, SelectorBarSelectionChangedEventArgs args)
    {
        // 装载完成前的标签事件一律忽略（含 XAML 默认 IsSelected 的异步派发），
        // 否则它会把 _currentTab 覆盖回「插件」，让带参数导航的页签失效。
        if (!_tabsReady || _suppressTabEvents || sender.SelectedItem is not SelectorBarItem { Tag: string tab })
        {
            return;
        }

        if (tab == _currentTab)
        {
            return;
        }

        await SwitchTabAsync(tab);
    }

    /// <summary>
    /// 切到指定页签（页签点击与「查看日志」按钮共用一条路径）。
    ///
    /// 离开设置页前确认未保存编辑；用户选择留下时把选中项回退，避免"页签跳了但内容没换"。
    /// </summary>
    private async Task SwitchTabAsync(string tab)
    {
        var previous = _currentTab;

        if (previous == DetailTabs.Settings
            && FindTab(DetailTabs.Settings)?.View is InstanceSettingsView settings
            && settings.HasUnsavedEdits)
        {
            var leave = await settings.ConfirmLeaveAsync();
            if (!leave)
            {
                // 回退选中态（ContentDialog 是模态的，期间用户点不到页签，这里只需同步 UI）
                _currentTab = previous;
                UpdateTabSelection();
                return;
            }
        }

        _currentTab = tab;

        foreach (var entry in _tabs)
        {
            entry.View.Visibility = entry.Key == _currentTab ? Visibility.Visible : Visibility.Collapsed;
        }

        await LoadCurrentTabAsync();
    }

    /// <summary>崩溃原因条上的「查看日志」：直接切到日志页签（用户不用自己找）。</summary>
    private async void OnViewCrashLogClick(object sender, RoutedEventArgs e)
    {
        if (!_tabsReady || _currentTab == DetailTabs.Logs)
        {
            return;
        }

        await SwitchTabAsync(DetailTabs.Logs);
        UpdateTabSelection();
    }

    private TabEntry? FindTab(string key)
    {
        foreach (var entry in _tabs)
        {
            if (entry.Key == key)
            {
                return entry;
            }
        }

        return null;
    }

    /// <summary>
    /// 装载当前页签。子视图各自做了"重复装载"保护
    /// （日志页若重复订阅一次就会把同一行渲染两遍，所以那边用 <c>_subscribed</c> 守住）。
    /// </summary>
    private async Task LoadCurrentTabAsync()
    {
        if (_instance is null)
        {
            return;
        }

        var entry = FindTab(_currentTab);
        if (entry is null)
        {
            return;
        }

        var id = _instance.Meta.Id;
        var name = _instance.Meta.Name;

        switch (_currentTab)
        {
            case DetailTabs.Plugins when entry.View is PluginsView plugins:
                await plugins.LoadAsync(id, name);
                break;

            case DetailTabs.Settings when entry.View is InstanceSettingsView settings:
                await settings.LoadAsync(_instance);
                break;

            case DetailTabs.Saves when entry.View is SavesView saves:
                await saves.LoadAsync(id, name);
                break;

            case DetailTabs.Logs when entry.View is LogsView logs:
                logs.Load(id, name);
                break;
        }
    }

    /* ------------------------------------------------------------------ *
     * 页头与主操作
     * ------------------------------------------------------------------ */

    private void Render()
    {
        if (_instance is null)
        {
            return;
        }

        var meta = _instance.Meta;
        var runtime = _runtime ?? _instance.Runtime;

        Header.Title = meta.Name;
        Header.Description = BuildDescription(_instance, runtime);

        RenderProblemBar(_instance);
        RenderCrashBar(runtime);
        RenderPrimaryAction(_instance, runtime);

        var parts = new List<string>
        {
            $"目录名：{meta.DirName}",
            $"profile：{meta.Profile.Name}",
            $"引擎：{meta.Engine.Version}",
            $"插件数：{_instance.PluginCount}",
            $"启动次数：{meta.LaunchCount}",
            $"最近启动：{Formatters.FormatRelative(meta.LastLaunchedAt)}",
        };

        if (runtime.State == InstanceStateValues.Running)
        {
            parts.Add($"开始运行：{Formatters.FormatRelative(runtime.StartedAt)}");
        }

        StatusText.Text = string.Join(" · ", parts);
    }

    /// <summary>
    /// 降级/异常提示。
    ///
    /// 契约（<c>contracts.ts:141-148</c>）硬性要求：<c>problem</c> 非空时必须显示 ——
    /// 否则用户看到的是"一张完全正常的页面，却怎么都启动不了"。
    /// </summary>
    private void RenderProblemBar(InstanceSummary instance)
    {
        if (!string.IsNullOrWhiteSpace(instance.Problem))
        {
            ProblemBar.Title = "该实例处于降级状态";
            ProblemBar.Message = instance.Problem;
            ProblemBar.IsOpen = true;
            return;
        }

        if (!instance.EngineInstalled)
        {
            ProblemBar.Title = "引擎未安装";
            ProblemBar.Message = $"引擎版本 {instance.Meta.Engine.Version} 尚未在本地安装，实例无法启动。请到「引擎版本」页安装后再试。";
            ProblemBar.IsOpen = true;
            return;
        }

        if (!instance.Present)
        {
            ProblemBar.Title = "实例目录缺失";
            ProblemBar.Message = "实例目录不存在（可能被移动或删除），启动会失败。";
            ProblemBar.IsOpen = true;
            return;
        }

        ProblemBar.IsOpen = false;
    }

    /// <summary>
    /// 崩溃原因条：只有"崩溃且后端给了原因"时才出现。
    ///
    /// 原文整段呈现（可滚动、可选中），不在代码里截断 —— 用户要能把 dsh 的报错原文
    /// 复制出去查；限高交给 XAML 里的 <c>ScrollViewer.MaxHeight</c>。没有 <c>lastError</c>
    /// 时收起，不留一条空壳提示（规范 §9.4：不得给假保证，也不得给空信息）。
    /// </summary>
    private void RenderCrashBar(InstanceRuntime runtime)
    {
        var crashed = string.Equals(runtime.State, InstanceStateValues.Crashed, StringComparison.Ordinal);
        var text = runtime.LastError;

        if (!crashed || string.IsNullOrWhiteSpace(text))
        {
            CrashBar.IsOpen = false;
            CrashText.Text = string.Empty;
            return;
        }

        CrashText.Text = text;
        CrashBar.IsOpen = true;
    }

    private void RenderPrimaryAction(InstanceSummary instance, InstanceRuntime runtime)
    {
        var presentation = StatePresentation.For(runtime.State);

        PrimaryActionText.Text = presentation.ActionText;
        PrimaryActionButton.IsEnabled = presentation.ActionEnabled && instance.Present && instance.EngineInstalled;
        ActionRing.IsActive = presentation.Busy;
        ActionRing.Visibility = presentation.Busy ? Visibility.Visible : Visibility.Collapsed;

        // 「打开界面」只在已有探测地址时出现；没有地址却给按钮会点出一个空白页
        OpenUiButton.Visibility = string.IsNullOrEmpty(runtime.Url) ? Visibility.Collapsed : Visibility.Visible;
    }

    private static string BuildDescription(InstanceSummary instance, InstanceRuntime runtime)
    {
        var parts = new List<string> { StatePresentation.Label(runtime.State) };

        if (runtime.Port is { } port)
        {
            parts.Add($"端口 {port}");
        }

        if (!string.IsNullOrEmpty(runtime.Url))
        {
            parts.Add(runtime.Url!);
        }

        // 崩溃原文**不**进页头：它是整段 stderr（可能近千字符），会把页头撑成十几行，
        // 右列的动作按钮随之错位，而详情页根 Grid 不能滚动，日志区会被挤没。
        // 原因改由 Row1 的 CrashBar 呈现（可滚动、可复制、一键跳日志页签）。
        if (runtime.State == InstanceStateValues.Crashed)
        {
            parts.Add("上次启动异常退出，原因见下方提示条");
        }

        if (!instance.Present)
        {
            parts.Add("目录缺失");
        }

        return string.Join(" · ", parts);
    }

    private async void OnPrimaryActionClick(object sender, RoutedEventArgs e)
    {
        if (_instance is null)
        {
            return;
        }

        var state = (_runtime ?? _instance.Runtime).State;
        if (state is InstanceStateValues.Starting or InstanceStateValues.Stopping)
        {
            return;
        }

        PrimaryActionButton.IsEnabled = false;
        try
        {
            if (state == InstanceStateValues.Running)
            {
                await StopAsync();
            }
            else
            {
                await LaunchAsync();
            }
        }
        finally
        {
            if (_instance is not null)
            {
                RenderPrimaryAction(_instance, _runtime ?? _instance.Runtime);
            }
        }
    }

    private async Task LaunchAsync()
    {
        if (_instance is null)
        {
            return;
        }

        var result = await AppServices.Bridge.CallAsync<LaunchResult>(
            Channels.InstanceLaunch,
            new LaunchRequest { InstanceId = _instance.Meta.Id });

        if (!result.Ok)
        {
            ShowError("启动实例失败", result.Error ?? "未知错误");
            AppServices.Toast.Error($"启动 {_instance.Meta.Name} 失败", result.Error);
            return;
        }

        ErrorBar.IsOpen = false;
        AppServices.Toast.Success($"正在启动 {_instance.Meta.Name}");

        await RefreshRuntimeQuietAsync(_instance);
        Render();

        var runtime = _runtime ?? _instance.Runtime;
        if (_instance.Meta.Launch.AutoOpenBrowser && !string.IsNullOrEmpty(runtime.Url))
        {
            OpenExternal(runtime.Url!);
        }
    }

    private async Task StopAsync()
    {
        if (_instance is null)
        {
            return;
        }

        var result = await AppServices.Bridge.CallAsync<BridgeVoid>(Channels.InstanceStop, _instance.Meta.Id);
        if (!result.Ok)
        {
            ShowError("停止实例失败", result.Error ?? "未知错误");
            AppServices.Toast.Error($"停止 {_instance.Meta.Name} 失败", result.Error);
            return;
        }

        ErrorBar.IsOpen = false;
        AppServices.Toast.Success($"正在停止 {_instance.Meta.Name}");

        await RefreshRuntimeQuietAsync(_instance);
        Render();
    }

    private async void OnOpenFolderClick(object sender, RoutedEventArgs e)
    {
        if (_instance is null)
        {
            return;
        }

        var result = await AppServices.Bridge.CallAsync<BridgeVoid>(
            Channels.InstanceOpenFolder,
            _instance.Meta.Id,
            InstanceFolderValues.Root);

        if (!result.Ok)
        {
            AppServices.Toast.Error("无法打开实例目录", result.Error);
        }
    }

    private void OnOpenUiClick(object sender, RoutedEventArgs e)
    {
        var url = (_runtime ?? _instance?.Runtime)?.Url;
        if (!string.IsNullOrEmpty(url))
        {
            OpenExternal(url!);
        }
    }

    /// <summary>
    /// 用系统浏览器打开界面地址。
    ///
    /// 协议 §3.3 要求 C# 侧**独立再校验一次** scheme（不信任 Node 传来的值），
    /// 这里复用 <c>CoreBridge.IsAllowedExternalUrl</c>，与外壳走同一条判定。
    /// </summary>
    private void OpenExternal(string url)
    {
        if (!CoreBridge.IsAllowedExternalUrl(url, out var reason))
        {
            ShowError("界面地址不可打开", reason ?? "该地址不是 http/https。");
            return;
        }

        _ = AppServices.Bridge.CallAsync<BridgeVoid>(Channels.AppOpenExternal, url);
    }

    private void OnBackClick(object sender, RoutedEventArgs e) => AppServices.Navigation.GoBack();

    private void OnBackAccelerator(KeyboardAccelerator sender, KeyboardAcceleratorInvokedEventArgs args)
    {
        args.Handled = true;
        AppServices.Navigation.GoBack();
    }

    private async void OnRetryMissingClick(object sender, RoutedEventArgs e)
    {
        await AppServices.State.RefreshInstancesAsync();

        if (AppServices.State.FindInstance(_instanceId) is null)
        {
            ShowMissing($"实例 {_instanceId} 仍不在实例列表中。");
            return;
        }

        await LoadAsync();
    }

    /* ------------------------------------------------------------------ *
     * 空态与错误
     * ------------------------------------------------------------------ */

    private void ShowMissing(string message)
    {
        _instance = null;

        MissingText.Text = message;
        MissingState.Visibility = Visibility.Visible;

        // 空态下把页头/页签/内容整块收起来，避免"半张页面 + 半张空态"
        Header.Visibility = Visibility.Collapsed;
        TabBar.Visibility = Visibility.Collapsed;
        TabHost.Visibility = Visibility.Collapsed;
        ProblemBar.IsOpen = false;
        CrashBar.IsOpen = false;
        ErrorBar.IsOpen = false;
        StatusText.Text = string.Empty;
    }

    private void ShowError(string title, string message)
    {
        ErrorBar.Title = title;
        ErrorBar.Message = message;
        ErrorBar.IsOpen = true;
    }

    /* ------------------------------------------------------------------ *
     * 订阅
     * ------------------------------------------------------------------ */

    private void AttachSubscriptions()
    {
        if (_subscriptionsAttached)
        {
            return;
        }

        AppServices.State.InstancesChanged += OnInstancesChanged;
        AppServices.Bridge.LogStateChanged += OnLogStateChanged;
        _subscriptionsAttached = true;
    }

    private void DetachSubscriptions()
    {
        if (!_subscriptionsAttached)
        {
            return;
        }

        AppServices.State.InstancesChanged -= OnInstancesChanged;
        AppServices.Bridge.LogStateChanged -= OnLogStateChanged;
        _subscriptionsAttached = false;
    }

    /// <summary>实例列表变化：本实例可能被外部删除/改名，必须重新判定并切到空态。</summary>
    private void OnInstancesChanged(object? sender, EventArgs e)
    {
        if (string.IsNullOrEmpty(_instanceId))
        {
            return;
        }

        var instance = AppServices.State.FindInstance(_instanceId);
        if (instance is null)
        {
            ShowMissing($"实例 {_instanceId} 已不在实例列表中（可能被外部删除或改名）。");
            return;
        }

        if (_instance is null)
        {
            // 之前是空态、现在又出现了（用户点了"刷新列表"）
            _ = LoadAsync();
            return;
        }

        _instance = instance;
        _runtime = instance.Runtime;
        Render();
    }

    /// <summary>
    /// <c>log:state</c> 是**粗粒度全量快照**（协议 §2.4），且推送可能来自后台读线程，
    /// 因此必须回 UI 线程再碰控件。
    /// </summary>
    private void OnLogStateChanged(object? sender, InstanceRuntime runtime)
    {
        if (!string.Equals(runtime.InstanceId, _instanceId, StringComparison.Ordinal))
        {
            return;
        }

        DispatcherQueue.TryEnqueue(() =>
        {
            _runtime = runtime;

            if (_instance is null)
            {
                return;
            }

            // 就地覆盖运行时字段：左栏与 P1 持有同一个实例对象，
            // 整体替换会让那两处继续显示旧值（ObservableCollection 不为元素内部字段变化发通知）
            _instance.Runtime.State = runtime.State;
            _instance.Runtime.Pid = runtime.Pid;
            _instance.Runtime.StartedAt = runtime.StartedAt;
            _instance.Runtime.Url = runtime.Url;
            _instance.Runtime.Port = runtime.Port;
            _instance.Runtime.ExitCode = runtime.ExitCode;
            _instance.Runtime.LastError = runtime.LastError;

            Render();
        });
    }

    /// <summary>
    /// 拉一次该实例的最新聚合状态并**就地**更新共享的 <see cref="InstanceSummary"/>。
    ///
    /// 静默失败：这是"补充信息"而非用户主动触发的操作，失败不该弹错误条
    /// （实例不存在的情况由调用方用列表判定处理）。
    /// </summary>
    private async Task RefreshRuntimeQuietAsync(InstanceSummary instance)
    {
        var result = await AppServices.Bridge.CallAsync<InstanceSummary>(Channels.InstanceGet, instance.Meta.Id);
        if (!result.Ok || result.Value is null)
        {
            return;
        }

        var fresh = result.Value;

        instance.Runtime.State = fresh.Runtime.State;
        instance.Runtime.Pid = fresh.Runtime.Pid;
        instance.Runtime.StartedAt = fresh.Runtime.StartedAt;
        instance.Runtime.Url = fresh.Runtime.Url;
        instance.Runtime.Port = fresh.Runtime.Port;
        instance.Runtime.ExitCode = fresh.Runtime.ExitCode;
        instance.Runtime.LastError = fresh.Runtime.LastError;

        instance.Present = fresh.Present;
        instance.EngineInstalled = fresh.EngineInstalled;
        instance.PluginCount = fresh.PluginCount;
        instance.Problem = fresh.Problem;

        // 就地改了共享对象必须自报版本：列表页的重建判据对"旧快照=已变异的同一个对象"
        // 比较不出差异，不递增版本卡片会停在旧值（如装完插件仍显示旧依赖数）。
        AppServices.State.MarkInstancesMutated();

        _runtime = instance.Runtime;
    }
}

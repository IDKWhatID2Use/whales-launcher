using Microsoft.UI.Composition.SystemBackdrops;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Navigation;
using WhalesLauncher.Models;
using WhalesLauncher.Services;
using WhalesLauncher.Shell;
using Windows.Graphics;
using WinRT.Interop;

namespace WhalesLauncher;

/// <summary>
/// 应用主窗口（外壳），结构依据视觉规范 §9.1。
///
/// 职责边界：窗口框架 + 全局导航 + 应用菜单 + 右侧日志抽屉 + 全局浮层宿主与宿主方法。
/// 页面自身的内容一律由 <c>Views/**</c> 负责 —— 外壳不碰 Frame 里那一层。
///
/// 与旧实现（<c>src/renderer/shell.ts</c> + <c>titlebar.ts</c>）的关系：旧实现自绘标题栏、
/// 并用 WCO（Window Controls Overlay）给系统三按钮让位；WinUI 3 用官方
/// <see cref="Microsoft.UI.Xaml.Controls.TitleBar"/> 控件，三按钮与拖拽区都由框架提供，
/// 因此那部分自绘代码整体作废（不是"移植"）。
/// </summary>
public sealed partial class MainWindow : Window
{
    /// <summary>初始尺寸与最小尺寸（规范 §2.3：最小 1024 保证左栏始终处于 Expanded）。</summary>
    private const int InitialWidth = 1280;
    private const int InitialHeight = 840;
    private const int MinimumWidth = 1024;
    private const int MinimumHeight = 720;

    private readonly NavigationService _navigation;
    private readonly InstanceRail _rail;
    private readonly LogDrawer _logDrawer;

    /// <summary>程序性改选中项时置位，避免 SelectionChanged 递归导航。</summary>
    private bool _syncingSelection;

    /// <summary>首屏装载只做一次（Loaded 可能重复触发）。</summary>
    private bool _startupDone;

    /// <summary>等待后端装配的轮询计时器（装配完成后立刻停掉并置空）。</summary>
    private Microsoft.UI.Dispatching.DispatcherQueueTimer? _readyTimer;

    private string _currentRoute = RouteKeys.Instances;
    private object? _currentParameter;

    public MainWindow()
    {
        InitializeComponent();

        Title = "WhalesLauncher";
        ConfigureWindow();

        _navigation = new NavigationService(ContentFrame);

        // 页面通过 AppServices.Navigation 导航（约定 §4：视图不持有外壳引用）
        AppServices.AttachNavigation(_navigation);

        // 浮层宿主（§9.10）：Toast 需要宿主；ContentDialog 需要 XamlRoot（在 Loaded 后挂）
        AppServices.Toast.Attach(ToastLayer);

        _rail = new InstanceRail(RootGrid.Resources);
        Nav.MenuItemsSource = _rail.Items;

        // 底部固定入口（§9.1）：引擎版本管理 / 全局设置。
        // 同样走"数据对象 + MenuItemTemplate"：NavigationViewItem 会被套上该模板并让绑定失败，
        // 实测会画出"空头像框 + 空警示图标"的垃圾行（见 RailEntry 类注释）。
        Nav.FooterMenuItemsSource = _rail.FooterItems;

        _logDrawer = new LogDrawer(
            RootGrid,
            LogDrawer,
            LogToggle,
            LogErrorBadge,
            LogSourceBox,
            LogFollowToggle,
            OpenLogFolderButton,
            CopyAllButton,
            LogSurface,
            LogCountText);

        // 以 Frame 自身的导航结果为准：NavigationService.GoBack 不更新它的 CurrentRoute，
        // 若外壳跟着 NavigationService 走，返回后会显示上一个页面的副标题与选中项。
        ContentFrame.Navigated += OnFrameNavigated;
        RootGrid.Loaded += OnRootLoaded;
        RootGrid.ActualThemeChanged += OnActualThemeChanged;
        Closed += OnWindowClosed;

        UpdateThemeButton();

        // 首屏：实例列表（§9.1「无实例」时的空态由该页负责）
        _navigation.Navigate(RouteKeys.Instances);

        // 审计深链：设 WHALES_SMOKE_ROUTE 可让应用直接进入指定页面。
        // 目的：让「逐页视觉审计」能无人值守地截到任意页面 —— 此前 P4 存档页
        // 因 SelectorBar 不响应合成鼠标点击而拿不到截图（见交付报告 §5.1 L1）。
        // 形如：instances | engines | create | settings | detail/first/saves
        ApplySmokeRoute();
    }

    /// <summary>
    /// 读取 <c>WHALES_SMOKE_ROUTE</c> 并导航（仅用于 QA / 自动化截图，未设该变量时是空操作）。
    ///
    /// 支持的取值：<c>instances</c> / <c>engines</c> / <c>create</c> / <c>settings</c> /
    /// <c>detail/first/&lt;tab&gt;</c>（<c>first</c> 表示左栏第一个实例，避免脚本硬编码实例 id）。
    /// 任何无法识别或无法完成的取值都静默保持首屏，绝不影响正常启动。
    ///
    /// <b>为什么要等</b>：本方法在外壳构造末尾调用，而外壳是"先建窗口、后装后端"
    /// （<c>App.xaml.cs</c>），此时实例列表还没装载，<c>detail/first</c> 取不到 id。
    /// 因此对依赖数据的取值做一次短轮询，等就绪后再导航。
    /// </summary>
    private void ApplySmokeRoute()
    {
        var raw = Environment.GetEnvironmentVariable("WHALES_SMOKE_ROUTE");
        if (string.IsNullOrWhiteSpace(raw))
        {
            return;
        }

        // 判断"数据是否已就绪"必须看 AppState.IsInitialized，而不是 AppServices.IsReady。
        // IsReady 只说明服务已装配，而装载是在装配之后异步跑的；只看 IsReady 会在
        // 实例列表还没渲染完时就导航，内容区停在加载态（空数据根下必现，实测）。
        //
        // 为什么**所有**深链都要等：不只是 detail/first 需要数据。实测 settings /
        // engines / create 三个路由同样会在装载完成前被导航，表现是标题栏副标题已经
        // 切到目标页面、内容区却仍是"正在读取实例列表…"。缺陷因此与路由无关，
        // 而与"导航早于装载结束"有关。
        var ready = AppServices.IsReady
            && (AppServices.State.IsInitialized || AppServices.State.BackendDown);

        if (ready)
        {
            NavigateSmokeRoute(raw);
            return;
        }

        // 等首次装载结束（最多 60 秒）。等待期间若后端断开，InitializeAsync 的收尾
        // 或 MarkBackendDown 都会置位，因此不会永久空等。
        var tries = 0;
        var queue = Microsoft.UI.Dispatching.DispatcherQueue.GetForCurrentThread();
        if (queue is null)
        {
            return;
        }

        var timer = queue.CreateTimer();
        timer.Interval = TimeSpan.FromMilliseconds(300);
        timer.IsRepeating = true;
        timer.Tick += (_, _) =>
        {
            tries += 1;
            if (!AppServices.IsReady)
            {
                timer.Stop();
                return;
            }

            if (AppServices.State.IsInitialized || AppServices.State.BackendDown)
            {
                timer.Stop();
                NavigateSmokeRoute(raw);
            }
            else if (tries > 200)
            {
                timer.Stop();
            }
        };
        timer.Start();
    }

    /// <summary>执行深链导航（取值见 <see cref="ApplySmokeRoute"/>）。</summary>
    private void NavigateSmokeRoute(string raw)
    {
        try
        {
            var parts = raw.Split('/', StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 0)
            {
                return;
            }

            switch (parts[0].ToLowerInvariant())
            {
                // 显式列出首屏路由。此前没有这一条，靠 default 的空操作"恰好"不显形 ——
                // 一旦首屏顺序变化，`WHALES_SMOKE_ROUTE=instances` 会静默变成空操作，
                // 自动化脚本拿到的是"看起来对但没人保证"的首屏。
                case "instances":
                    _navigation.Navigate(RouteKeys.Instances);
                    break;

                case "detail" when parts.Length >= 2:
                    var id = parts[1];
                    if (string.Equals(id, "first", StringComparison.OrdinalIgnoreCase))
                    {
                        id = AppServices.IsReady ? FirstInstanceId() : string.Empty;
                    }

                    if (!string.IsNullOrEmpty(id))
                    {
                        _navigation.NavigateToDetail(id, parts.Length >= 3 ? parts[2] : DetailTabs.Plugins);
                    }

                    break;

                case "engines":
                    _navigation.Navigate(RouteKeys.Engines);
                    break;

                case "create":
                    _navigation.Navigate(RouteKeys.Create);
                    break;

                case "settings":
                    _navigation.Navigate(RouteKeys.Settings);
                    break;

                default:
                    break;
            }
        }
        catch
        {
            // QA 深链失败不应影响正常启动
        }
    }

    /// <summary>取左栏第一个实例的稳定 id（深链 <c>detail/first/...</c> 用）。</summary>
    private static string FirstInstanceId()
    {
        foreach (var item in AppServices.State.Instances)
        {
            if (item.Meta is { } meta && !string.IsNullOrEmpty(meta.Id))
            {
                return meta.Id;
            }
        }

        return string.Empty;
    }

    /* ------------------------------------------------------------------ *
     * 窗口框架
     * ------------------------------------------------------------------ */

    private void ConfigureWindow()
    {
        // 官方 TitleBar 控件要求把标题栏折进客户区；规范 §6.1 明确"必须在代码里设"（写在 XAML 会报错）
        ExtendsContentIntoTitleBar = true;

        var hwnd = WindowNative.GetWindowHandle(this);
        var appWindow = AppWindow.GetFromWindowId(Microsoft.UI.Win32Interop.GetWindowIdFromWindow(hwnd));

        appWindow.Resize(new SizeInt32(InitialWidth, InitialHeight));

        if (appWindow.Presenter is OverlappedPresenter presenter)
        {
            presenter.PreferredMinimumWidth = MinimumWidth;
            presenter.PreferredMinimumHeight = MinimumHeight;
        }

        // Mica 作窗口底面（规范 §3.3）：内容层再用 LayerFillColorDefaultBrush 叠一层。
        // 系统不支持 Mica 时（Windows 10 / 系统关闭透明效果）退回实色兜底层 —— 否则窗口会是黑底。
        if (MicaController.IsSupported())
        {
            SystemBackdrop = new MicaBackdrop();
        }
        else
        {
            BackdropFallback.Visibility = Visibility.Visible;
        }
    }

    /* ------------------------------------------------------------------ *
     * 启动编排
     * ------------------------------------------------------------------ */

    private async void OnRootLoaded(object sender, RoutedEventArgs e)
    {
        // ContentDialog 必须设 XamlRoot（§9.10.1）；Loaded 是 XamlRoot 可用的最早时机
        if (RootGrid.XamlRoot is not null)
        {
            AppServices.Dialogs.Attach(RootGrid.XamlRoot);
        }

        // 日志抽屉也要等 Loaded：它需要 DispatcherQueue 建刷新计时器
        _logDrawer.Attach();

        if (!AppServices.IsReady)
        {
            // App.xaml.cs 是"先立窗口、再后台装配后端"的设计（见其类注释）：Loaded 常常早于装配完成。
            // AppServices 没有"就绪"事件，所以这里用一次轻量轮询等待装配，
            // 而不是把外壳永久停在降级态（§9.1 要求窗口先渲染、数据后到）。
            WaitForBackend();
            return;
        }

        await EnterBackendReadyAsync();
    }

    /// <summary>后端装配完成后：注册宿主方法、订阅状态与推送、装载首屏数据与菜单。</summary>
    private async Task EnterBackendReadyAsync()
    {
        try
        {
            // 宿主方法统一由外壳注册一次（协议 §3.3）：分散注册会互相覆盖
            ShellHostMethods.Register(AppServices.Bridge, this);

            AppServices.Bridge.BackendExited += OnBackendExited;
            AppServices.State.InstancesChanged += OnInstancesChanged;
            AppServices.State.ConfigChanged += OnConfigChanged;
            _logDrawer.SubscribeToBackend();

            await LoadStartupStateAsync();
        }
        catch (Exception ex)
        {
            // async void 路径上的异常会直接崩进程：这里兜住并让用户看见（§9.0 错误不得只进日志）
            AppServices.Toast.Error("外壳初始化失败", ex.Message);
        }
    }

    /// <summary>
    /// 等待 App.xaml.cs 完成后端装配（每 250ms 查一次，最多 30s）。
    /// 之所以轮询：<see cref="AppServices"/> 没有暴露"已装配"事件，而外壳又不能永久停在降级态。
    /// </summary>
    private void WaitForBackend()
    {
        var waited = TimeSpan.Zero;
        var timer = RootGrid.DispatcherQueue.CreateTimer();
        _readyTimer = timer;
        timer.Interval = TimeSpan.FromMilliseconds(250);
        timer.IsRepeating = true;

        timer.Tick += async (_, _) =>
        {
            if (AppServices.IsReady)
            {
                timer.Stop();
                _readyTimer = null;
                await EnterBackendReadyAsync();
                return;
            }

            waited += TimeSpan.FromMilliseconds(250);
            if (waited < TimeSpan.FromSeconds(30))
            {
                return;
            }

            timer.Stop();
            _readyTimer = null;
            AppServices.Toast.Warning("后端尚未就绪", "实例列表与应用菜单暂时不可用。");
            RebuildRail();
        };

        timer.Start();
    }

    private async Task LoadStartupStateAsync()
    {
        if (_startupDone)
        {
            return;
        }

        _startupDone = true;

        // 只拉外壳真正需要的东西（配置里的主题 + 实例列表）。
        // 若 Lead 的 App.xaml.cs 已装载过（Config 非空），这里不重复请求。
        if (AppServices.State.Config is null)
        {
            var config = await AppServices.State.LoadConfigAsync();
            if (!config.Ok)
            {
                AppServices.Toast.Error("读取配置失败", config.Error);
            }
        }

        ApplyThemeFromConfig();

        if (AppServices.State.Instances.Count == 0)
        {
            var list = await AppServices.State.RefreshInstancesAsync();
            if (!list.Ok)
            {
                // §9.0：ok:false 必须呈现到界面，文案用后端原文
                AppServices.Toast.Error("实例列表加载失败", list.Error);
            }
        }

        RebuildRail();
        _logDrawer.RebuildSources();

        await LoadAppMenuAsync();
    }

    private async Task LoadAppMenuAsync()
    {
        var result = await AppServices.Bridge.CallAsync<MenuNode[]>(Channels.AppMenu);
        var nodes = result.Value;

        if (!result.Ok || nodes is null)
        {
            AppServices.Toast.Error("应用菜单加载失败", result.Error ?? "后端未返回菜单数据。");
            return;
        }

        AppMenuBuilder.Populate(AppMenuBar, nodes, ExecuteMenuCommandAsync);
    }

    /// <summary>
    /// 菜单命令回传（契约 <c>app:menuCommand</c>）。外壳**不实现**任何菜单命令，
    /// 只把 MenuNode.id 交回后端 —— 命令表在 Node 侧，界面抄一份就是第二份定义。
    /// </summary>
    private async Task ExecuteMenuCommandAsync(string id)
    {
        var result = await AppServices.Bridge.CallVoidAsync(Channels.AppMenuCommand, id);
        if (!result.Ok)
        {
            AppServices.Toast.Error("菜单命令执行失败", result.Error);
        }
    }

    private void OnInstancesChanged(object? sender, EventArgs e)
    {
        RebuildRail();
        _logDrawer.RebuildSources();
    }

    private void OnConfigChanged(object? sender, EventArgs e)
    {
        // P8 改了主题也要立刻反映到外壳（含标题栏按钮文字）
        ApplyThemeFromConfig();
    }

    private void OnBackendExited(object? sender, string reason)
    {
        // 后端断开是外壳级的状态，必须让用户看见（§9.0：错误不得只进日志）
        RootGrid.DispatcherQueue.TryEnqueue(() => AppServices.Toast.Error("后端已断开", reason));
    }

    /* ------------------------------------------------------------------ *
     * 左栏
     * ------------------------------------------------------------------ */

    private void RebuildRail()
    {
        _rail.Rebuild(AppServices.IsReady ? AppServices.State.Instances : null, InstanceFilter.Text);
        SyncRailSelection();
    }

    private void OnInstanceFilterChanged(AutoSuggestBox sender, AutoSuggestBoxTextChangedEventArgs args) =>
        RebuildRail();

    private void OnNavSelectionChanged(NavigationView sender, NavigationViewSelectionChangedEventArgs args)
    {
        if (_syncingSelection)
        {
            return;
        }

        if (args.SelectedItem is not RailEntry row)
        {
            return;
        }

        switch (row.Kind)
        {
            case RailEntryKind.Instance:
                _navigation.NavigateToDetail(row.InstanceId, DetailTabs.Plugins);
                break;

            case RailEntryKind.NewInstance:
                _navigation.Navigate(RouteKeys.Create);
                break;

            case RailEntryKind.EngineVersions:
                _navigation.Navigate(RouteKeys.Engines);
                break;

            case RailEntryKind.Settings:
                _navigation.Navigate(RouteKeys.Settings);
                break;

            default:
                // 「分隔线」与「无匹配实例」不可导航：把选中项退回当前路由对应的行，
                // 避免留下一个假的选中态（点了没反应比点错更让人困惑）
                SyncRailSelection();
                break;
        }
    }

    /// <summary>把左栏选中项同步到当前路由（导航后重建集合会丢掉选中态，必须显式恢复）。</summary>
    private void SyncRailSelection()
    {
        _syncingSelection = true;
        try
        {
            Nav.SelectedItem = _currentRoute switch
            {
                RouteKeys.Detail when _currentParameter is DetailNavArgs args => _rail.Find(args.InstanceId),
                RouteKeys.Engines => _rail.FindFooter(RailEntryKind.EngineVersions),
                RouteKeys.Settings => _rail.FindFooter(RailEntryKind.Settings),
                _ => null,
            };
        }
        finally
        {
            _syncingSelection = false;
        }
    }

    /* ------------------------------------------------------------------ *
     * 导航与标题栏
     * ------------------------------------------------------------------ */

    private void OnFrameNavigated(object sender, NavigationEventArgs e)
    {
        _currentRoute = RouteOf(e.SourcePageType);
        _currentParameter = e.Parameter;

        AppTitleBar.Subtitle = SubtitleFor(_currentRoute, e.Parameter);

        // 规范 §6.1 的返回按钮只在详情页显示；这里放宽为"任何非首屏路由且可后退"——
        // 因为 §9.1 的左栏没有"实例列表"入口，若 P6/P7/P8 也隐藏返回，首屏之后就没有
        // 任何路径能回到实例列表（P1 将不可达）。已在回复中登记该偏离。
        AppTitleBar.IsBackButtonVisible = ContentFrame.CanGoBack && _currentRoute != RouteKeys.Instances;

        SyncRailSelection();
    }

    private void OnBackRequested(Microsoft.UI.Xaml.Controls.TitleBar sender, object args) => _navigation.GoBack();

    /// <summary>把页面类型反查成路由键：Frame 是外壳唯一可信的"当前在哪一页"来源。</summary>
    private static string RouteOf(Type? pageType)
    {
        if (pageType == typeof(Views.InstancesPage)) return RouteKeys.Instances;
        if (pageType == typeof(Views.InstanceDetailPage)) return RouteKeys.Detail;
        if (pageType == typeof(Views.EnginesPage)) return RouteKeys.Engines;
        if (pageType == typeof(Views.WizardPage)) return RouteKeys.Create;
        if (pageType == typeof(Views.SettingsPage)) return RouteKeys.Settings;
        return string.Empty;
    }

    private static string SubtitleFor(string route, object? parameter) => route switch
    {
        RouteKeys.Instances => "实例",
        RouteKeys.Detail => parameter is DetailNavArgs args ? $"实例详情 · {DetailTabs.Label(args.Tab)}" : "实例详情",
        RouteKeys.Engines => "引擎版本管理",
        RouteKeys.Create => "新建实例",
        RouteKeys.Settings => "全局设置",
        _ => string.Empty,
    };

    private void OnLogAcceleratorInvoked(KeyboardAccelerator sender, KeyboardAcceleratorInvokedEventArgs args)
    {
        // Ctrl+L 开合日志抽屉（与旧渲染层同款快捷键，见 frontend-survey §8.1 第 7 条）
        args.Handled = true;
        LogToggle.IsChecked = LogToggle.IsChecked != true;
    }

    private void OnCloseLogDrawerClick(object sender, RoutedEventArgs e) => LogToggle.IsChecked = false;

    /* ------------------------------------------------------------------ *
     * 主题（规范 §3.4）
     * ------------------------------------------------------------------ */

    private void ApplyThemeFromConfig()
    {
        var config = AppServices.IsReady ? AppServices.State.Config : null;

        // 契约的 theme 只有 dark | light（缺 'system'，规范 §11 U18 已登记）；
        // 配置尚未装载时保持 Default（跟随系统），**不**把 Default 冒充成浅色。
        RootGrid.RequestedTheme = config?.Theme switch
        {
            ThemeValues.Light => ElementTheme.Light,
            ThemeValues.Dark => ElementTheme.Dark,
            _ => ElementTheme.Default,
        };

        UpdateThemeButton();
    }

    private async void OnThemeButtonClick(object sender, RoutedEventArgs e)
    {
        var current = RootGrid.RequestedTheme == ElementTheme.Default
            ? RootGrid.ActualTheme
            : RootGrid.RequestedTheme;

        var next = current == ElementTheme.Dark ? ThemeValues.Light : ThemeValues.Dark;
        RootGrid.RequestedTheme = next == ThemeValues.Light ? ElementTheme.Light : ElementTheme.Dark;

        // 写入配置：主题是 launcher.json 的一部分，重启后必须还在
        if (!AppServices.IsReady)
        {
            return;
        }

        var result = await AppServices.State.SaveConfigAsync(new { theme = next });
        if (!result.Ok)
        {
            AppServices.Toast.Error("主题保存失败", result.Error);
        }
    }

    private void OnActualThemeChanged(FrameworkElement sender, object args) => UpdateThemeButton();

    private void UpdateThemeButton()
    {
        var (label, tooltip) = RootGrid.RequestedTheme switch
        {
            ElementTheme.Light => ("浅色", "当前浅色主题，点击切换到深色"),
            ElementTheme.Dark => ("深色", "当前深色主题，点击切换到浅色"),
            _ => ("跟随系统", "当前跟随系统主题，点击切换到浅色或深色"),
        };

        ThemeLabel.Text = label;
        ToolTipService.SetToolTip(ThemeButton, tooltip);
        AutomationProperties.SetName(ThemeButton, $"切换深浅色主题（{label}）");
    }

    /* ------------------------------------------------------------------ *
     * 清理
     * ------------------------------------------------------------------ */

    private void OnWindowClosed(object sender, WindowEventArgs args) => Detach();

    /// <summary>窗口关闭时解绑所有订阅（简报 §4.9：订阅必须成对解除）。</summary>
    private void Detach()
    {
        _readyTimer?.Stop();
        _readyTimer = null;

        _logDrawer.Detach();
        ContentFrame.Navigated -= OnFrameNavigated;

        if (!AppServices.IsReady)
        {
            return;
        }

        AppServices.Bridge.BackendExited -= OnBackendExited;
        AppServices.State.InstancesChanged -= OnInstancesChanged;
        AppServices.State.ConfigChanged -= OnConfigChanged;
    }
}

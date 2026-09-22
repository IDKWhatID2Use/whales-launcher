using System.Collections.ObjectModel;
using System.Globalization;
using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using WhalesLauncher.Models;
using WhalesLauncher.Services;
using Windows.UI;

namespace WhalesLauncher.Views;

/// <summary>
/// P1 实例列表（视觉规范 §9.2）。应用首屏。
///
/// 对应旧实现 <c>src/renderer/views/instances.ts</c>（755 行）：
/// 旧版是「静态头部 + 动态区域」的手工 DOM 重建 + <c>util/clock.ts</c> 的定时器刷 DOM 文本；
/// WinUI 侧改为 <see cref="GridView"/> + <see cref="ObservableCollection{T}"/>（局部刷新，
/// 搜索框与滚动位置不丢），定时器只负责"重算 → 重新取值"。
///
/// 架构约束（约定 §9）：视图不直接持有 <c>CoreBridge</c>，一律经
/// <see cref="AppServices.State"/> 与 <see cref="AppServices.Bridge"/>。
/// </summary>
public sealed partial class InstancesPage : Page, System.ComponentModel.INotifyPropertyChanged
{
    /// <summary>
    /// 轮询间隔。取值理由：一个 Node 请求 + 目录枚举，实测成本远低于 1 次磁盘刷新；
    /// 4 s 与旧实现时钟的秒级刷新配合，既能让人眼觉得"状态是活的"，又不会打满 IO。
    /// 没有"可能变化"的实例时定时器根本不会启动（见 <see cref="SyncTimer"/>），因此空闲时零开销。
    /// </summary>
    private static readonly TimeSpan WatchInterval = TimeSpan.FromSeconds(4);

    /// <summary>搜索防抖。取值理由：旧实现每次 keydown 全量重排；卡片网格比旧 DOM 重，250 ms 是"打字不停顿但不抖"的常用值。</summary>
    private static readonly TimeSpan SearchDebounce = TimeSpan.FromMilliseconds(250);

    /// <summary>
    /// 实例包导入/导出用的超时。
    ///
    /// 默认的 30 秒不够：导入要按包内清单重装依赖（`pluginAdd` → npm/pnpm），
    /// 本地缓存缺失时一次 `npm install` 就可能跑几分钟；导出要写 zip（大实例的
    /// 日志与工作区可能几百 MB）。超时在此处放宽到 30 分钟 —— 用户全程能看到
    /// 顶部 ProgressBar，不存在"界面像卡死"的问题。
    /// </summary>
    private static readonly TimeSpan PackTimeout = TimeSpan.FromMinutes(30);

    /// <summary>
    /// 排序项顺序必须与 XAML 里 <c>SortBox</c> 的 <c>ComboBoxItem</c> 一致。
    /// </summary>
    private static readonly string[] SortKeys = { "recent", "name", "created", "plugins" };

    private readonly ObservableCollection<InstanceCard> _cards = new();
    private readonly DispatcherTimer _tickTimer = new();   // 1 s：刷新"最近启动"相对时间
    private readonly DispatcherTimer _watchTimer = new();  // 4 s：轮询运行态
    private readonly DispatcherTimer _searchTimer = new(); // 250 ms：搜索防抖

    private List<InstanceSummary> _all = new();
    private List<InstanceSummary> _visible = new();

    /// <summary>
    /// 上次重建卡片时的 <see cref="AppState.InstancesVersion"/>。
    ///
    /// 为什么版本比较是**必需的**、不能只靠 <see cref="CardDataEqual"/>：后端推送帧
    /// （<c>log:state</c> → ApplyRuntime）会**就地变异** <see cref="_all"/> 里的共享对象，
    /// 变异后旧快照与新快照是同一个实例 —— 引用比较恒等、字段比较也恒等，事后无从察觉。
    /// 变更侧（AppState）在变异时递增版本，这里记下重建时的版本；
    /// 版本不等 ⇒ 底层动过 ⇒ 即使比较结果"相等"也必须重建。
    /// 反向（版本相等但字段不等）由 <see cref="SameCards"/> 兜住 —— instance:list 换新对象。
    /// </summary>
    private long _cardsVersion;
    private string _query = string.Empty;
    private string _status = "all";
    private string _sort = "recent";
    private string? _lastError;
    private bool _loading;
    private bool _initialized;

    /// <summary>实例包导入/导出是否正在进行（两者互斥：同一时刻只允许一个长时间对话框 + 落盘任务）。</summary>
    private bool _packBusy;

    /// <summary>
    /// 界面是否已经装配完成。
    ///
    /// 为什么必须有这道门闩：XAML 里 `SortBox` 的 `SelectedIndex="0"`（以及 SelectorBar 的
    /// `IsSelected="True"`）会在 <c>InitializeComponent()</c> **执行期间**就触发
    /// `SelectionChanged` —— 那时 <c>InitializeComponent</c> 还没把后面的 `x:Name` 字段赋值完，
    /// 处理器里一旦用到 `InstanceGrid` 之类的字段就会 NRE；而这次 NRE 发生在
    /// `Frame.Navigate()`（MainWindow 构造函数内）里，会直接冒到 `OnLaunched`，
    /// 让 WinUI 抛 <c>STATUS_STOWED_EXCEPTION (0xC000027B)</c>，**应用连窗口都出不来**。
    /// </summary>
    private bool _ready;

    /// <summary>
    /// 卡片「更多」菜单里的「导出实例包…」是否可用（导入/导出期间禁用）。
    ///
    /// 为什么放在页面上而不是卡片视图模型上：这是**页面级**的忙状态（同一时刻只允许
    /// 一个实例包任务），若塞进 <see cref="InstanceCard"/>，每张卡都要各自跟着变，
    /// 而它们无法感知别的卡片在做什么 —— 那样必然出现"两个实例同时导出"的竞态。
    /// 卡片模板用 <c>{Binding PackMenuEnabled, ElementName=RootGrid}</c> 借用这一个开关。
    /// </summary>
    public bool PackMenuEnabled
    {
        get => _packMenuEnabled;
        set
        {
            if (_packMenuEnabled == value) return;
            _packMenuEnabled = value;
            OnPropertyChanged(nameof(PackMenuEnabled));
        }
    }

    private bool _packMenuEnabled = true;

    /// <summary>
    /// <c>{Binding}</c> 需要的变更通知。
    ///
    /// 本页只有一个走经典绑定（而非 x:Bind）的属性 —— <see cref="PackMenuEnabled"/>，
    /// 因为卡片菜单项在 <c>DataTemplate</c> 里，x:Bind 的数据根是 <see cref="InstanceCard"/>，
    /// 取不到页面上的属性（XAML 注释里已说明同类取舍）。经典绑定必须自己发通知。
    /// </summary>
    public event System.ComponentModel.PropertyChangedEventHandler? PropertyChanged;

    private void OnPropertyChanged(string name) =>
        PropertyChanged?.Invoke(this, new System.ComponentModel.PropertyChangedEventArgs(name));

    public InstancesPage()
    {
        InitializeComponent();

        InstanceGrid.ItemsSource = _cards;

        _tickTimer.Interval = TimeSpan.FromSeconds(1);
        _tickTimer.Tick += OnTick;

        _watchTimer.Interval = WatchInterval;
        _watchTimer.Tick += OnWatchTick;

        _searchTimer.Interval = SearchDebounce;
        _searchTimer.Tick += OnSearchTick;

        SizeChanged += OnPageSizeChanged;
        RootGrid.ActualThemeChanged += OnActualThemeChanged;
    }

    protected override void OnNavigatedTo(Microsoft.UI.Xaml.Navigation.NavigationEventArgs e)
    {
        base.OnNavigatedTo(e);

        // 外壳在 App.OnLaunched 里**先建窗口、后装后端**（见 App.xaml.cs 注释）。本页是首屏，
        // 因此到达这里时 AppServices 可能还没装配：此时只把空态画出来，由 RefreshAsync 的重试
        // 把数据补上。直接访问 AppServices.State 会抛 InvalidOperationException，
        // 而本页的 OnNavigatedTo 跑在 Frame.Navigate 内，异常会一路冒到 OnLaunched，应用直接死。
        var servicesReady = AppServices.IsReady;

        if (servicesReady)
        {
            AppServices.State.InstancesChanged += OnInstancesChanged;
            _all = AppServices.State.Instances.ToList();
        }

        _initialized = _all.Count > 0;

        // 门闩在首次渲染前打开：此前的 SelectionChanged 一律被 Render 丢弃（见 _ready 注释）
        _ready = true;

        _tickTimer.Start();
        LayoutStates();
        Render();

        _ = RefreshAsync(showProgress: true);
    }

    protected override void OnNavigatedFrom(Microsoft.UI.Xaml.Navigation.NavigationEventArgs e)
    {
        base.OnNavigatedFrom(e);

        // 硬性要求（简报 §4.9）：离开页面必须解绑事件与停表，否则页面常驻内存。
        _ready = false;
        if (AppServices.IsReady)
        {
            AppServices.State.InstancesChanged -= OnInstancesChanged;
        }
        _tickTimer.Stop();
        _watchTimer.Stop();
        _searchTimer.Stop();
        RootGrid.ActualThemeChanged -= OnActualThemeChanged;
    }

    /* ------------------------------------------------------------------ *
     * 数据装载与刷新
     * ------------------------------------------------------------------ */

    /// <summary>
    /// 刷新实例列表。
    ///
    /// 「不阻塞、不闪烁」的两个细节（规范 §9.2「刷新」行）：
    /// 首屏没有卡片时才显示居中 ProgressRing；已有数据时只在工具条右侧放不定量 ProgressBar。
    /// </summary>
    private async Task RefreshAsync(bool showProgress, int attempt = 0)
    {
        // 后端尚未装配（首屏窗口先出来）：短暂等待后重试，不在界面上报错 ——
        // 这不是失败，只是"还没轮到我们"，App 会在几秒内完成桥接装配。
        if (!AppServices.IsReady)
        {
            if (attempt < 12)
            {
                await Task.Delay(250);
                await RefreshAsync(showProgress, attempt + 1);
            }

            return;
        }

        if (_loading) return;
        _loading = true;

        // 首次加载（无任何数据）用居中 ProgressRing；后续刷新用顶部 ProgressBar，不清空已有卡片。
        //
        // 网格的可见性**不在此处动**：曾有一行 `InstanceGrid.Visibility = Collapsed`，
        // 请求返回后的 Render 才设回 Visible —— 而 4 秒轮询（OnWatchTick）每次都会走这里，
        // 网格在整个桥接请求期间消失，表现为"实例卡片每 4 秒闪一下"。
        // 首屏时网格本身就是 Collapsed（XAML 默认且 _cards 为空），Render 负责其后的一切切换。
        FirstLoadPanel.Visibility = _all.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        RefreshBar.Visibility = showProgress ? Visibility.Visible : Visibility.Collapsed;

        try
        {
            var result = await AppServices.State.RefreshInstancesAsync();

            if (!result.Ok)
            {
                // 硬性要求（简报 §4.5）：错误必须可见，且用 result.Error 原文（用户要能复制）。
                _lastError = result.Error;
                SetStatusBar(ErrorBar, true, result.Error ?? string.Empty);
            }
            else
            {
                _lastError = null;
                SetStatusBar(ErrorBar, false, string.Empty);
                _all = AppServices.State.Instances.ToList();
                _initialized = true;
            }
        }
        catch (Exception ex)
        {
            // 桥接进程断开时 CoreBridge 也可能抛；此时界面必须仍然可用。
            _lastError = ex.Message;
            SetStatusBar(ErrorBar, true, ex.Message);
        }
        finally
        {
            _loading = false;
            RefreshBar.Visibility = Visibility.Collapsed;

            // 即使这次失败了也算"首屏已过"：否则后端一直不可用时，页面会永久停在转圈上，
            // 而错误 InfoBar 已经给出原因，应当让用户看到空态 + 错误（可操作），而不是无信息地转圈。
            _initialized = true;
            LayoutStates();
            Render();
        }
    }

    private void OnInstancesChanged(object? sender, EventArgs e)
    {
        // 事件在 UI 线程触发（AppState 已把后端推送汇入 UI 线程，页面自身的异步链也都在 UI 线程）；
        // 仍走 TryEnqueue 兜底，避免未来有订阅方改到后台线程时静默失效（约定 §8「跨线程更新 UI」）。
        if (DispatcherQueue.HasThreadAccess)
        {
            ApplyStateSnapshot();
        }
        else
        {
            DispatcherQueue.TryEnqueue(ApplyStateSnapshot);
        }
    }

    private void ApplyStateSnapshot()
    {
        var next = AppServices.State.Instances.ToList();
        if (StateChanged(_all, next))
        {
            _all = next;
        }

        LayoutStates();
        Render();
    }

    /// <summary>
    /// 运行态是否发生变化。只在"变化"时替换快照，避免每 4 秒重建全部卡片
    /// （重建会打断用户正在悬停/展开的卡片）。
    /// </summary>
    private static bool StateChanged(List<InstanceSummary> current, List<InstanceSummary> next)
    {
        if (current.Count != next.Count) return true;

        for (var i = 0; i < next.Count; i += 1)
        {
            var a = current[i];
            var b = next[i];
            if (!string.Equals(a.Meta?.Id, b.Meta?.Id, StringComparison.Ordinal)) return true;
            if (!string.Equals(a.Runtime?.State, b.Runtime?.State, StringComparison.Ordinal)) return true;
            if (!string.Equals(a.Runtime?.Url, b.Runtime?.Url, StringComparison.Ordinal)) return true;
            if (a.Runtime?.Port != b.Runtime?.Port) return true;
            if (a.Runtime?.Pid != b.Runtime?.Pid) return true;
            if (!string.Equals(a.Problem, b.Problem, StringComparison.Ordinal)) return true;
            if (!string.Equals(a.Meta?.LastLaunchedAt, b.Meta?.LastLaunchedAt, StringComparison.Ordinal)) return true;
            if (a.PluginCount != b.PluginCount) return true;
            if (a.Present != b.Present || a.EngineInstalled != b.EngineInstalled) return true;
        }

        return false;
    }

    /* ------------------------------------------------------------------ *
     * 定时器
     * ------------------------------------------------------------------ */

    private void OnTick(object? sender, object e)
    {
        // 只重算 + 重新取值：不清空集合（清了会闪、也会丢滚动位置与焦点）。
        RefreshRelativeTimes();
    }

    private void OnWatchTick(object? sender, object e)
    {
        _ = RefreshAsync(showProgress: false);
    }

    private void OnSearchTick(object? sender, object e)
    {
        _searchTimer.Stop();
        Render();
    }

    /// <summary>
    /// 让卡片上的相对时间跟着走。
    ///
    /// 旧实现是「单定时器 + querySelectorAll('[data-elapsed]') 批量改文本」；
    /// WinUI 侧直接替换 <see cref="InstanceCard"/> 的同一个不可变属性 —— 集合成员未变，
    /// 容器与滚动位置都不会动，只有 <c>x:Bind</c> 重新取值。
    /// </summary>
    private void RefreshRelativeTimes()
    {
        foreach (var card in _cards)
        {
            if (card.Summary.Meta is null) continue;

            var value = Formatters.FormatRelative(card.Summary.Meta.LastLaunchedAt);
            if (!string.Equals(card.LastLaunchedText, value, StringComparison.Ordinal))
            {
                card.LastLaunchedText = value;

                // 阅读器摘要尾部是同一段相对时间，跟着一起改（StateLabel 等其余部分
                // 只在重建时变化，重建时会重算整串）。
                card.MetaSummary =
                    $"{card.Name}，{card.StateLabel}，{card.EngineVersion}，{card.PluginText}，{value}";
            }
        }
    }

    /// <summary>仅当存在"状态还可能变"的实例时才轮询：全静止时停表，空闲不产生任何后端调用。</summary>
    private void SyncTimer()
    {
        var needed = _all.Exists(MayStillChange);
        if (needed)
        {
            if (!_watchTimer.IsEnabled) _watchTimer.Start();
        }
        else if (_watchTimer.IsEnabled)
        {
            _watchTimer.Stop();
        }
    }

    /// <summary>
    /// 这张卡的状态是否**还可能变**（据此决定要不要继续 4 秒轮询）。
    ///
    /// 判据是「当前状态自称还握着一个进程」，而不是"最近 N 分钟内崩过"：
    ///
    ///  - <c>starting</c> / <c>stopping</c>：过渡态，必然还会变；
    ///  - <c>running</c>：可能下一秒就崩 —— 这是本页唯一无法从推送得知的转变
    ///    （`log:state` 只在启动/停止/退出时推，而"进程被外部杀掉"或"dsh 自己崩"
    ///    由 core 的退出链推最后一帧，界面必须还有一种兜底手段）；
    ///  - <c>crashed</c> / <c>stopping</c> 但 <c>pid</c> 还在：进程还没被真正回收，状态未定。
    ///
    /// 一旦进入 <c>stopped</c> / <c>crashed</c> 且 <c>pid</c> 为 null，后端已经给出终态，
    /// 轮询立刻停止 —— 既不会为静态实例白跑请求，也不会出现"崩溃后卡片永远不变红"
    /// （旧实现的按时间窗口判定会在窗口外停表，崩溃状态若错过那一帧就再也补不上）。
    /// </summary>
    private static bool MayStillChange(InstanceSummary summary)
    {
        var runtime = summary.Runtime;
        var state = runtime?.State;

        if (string.Equals(state, InstanceStateValues.Starting, StringComparison.Ordinal) ||
            string.Equals(state, InstanceStateValues.Stopping, StringComparison.Ordinal))
        {
            return true;
        }

        // running 或者"自称还有进程"的崩溃态：进程仍在，状态随时可能落定。
        return runtime?.Pid is not null && runtime.Pid > 0;
    }

    /* ------------------------------------------------------------------ *
     * 呈现
     * ------------------------------------------------------------------ */

    /// <summary>
    /// 决定内容区显示哪一块（网格 / 首屏加载 / 两种空态）之外的"页级状态"。
    ///
    /// 网格与空态的具体选择在 <see cref="Render"/> 里 —— 它要用到筛选后的可见集合。
    /// 这里只处理三件与可见集合无关的事：错误条、降级条的开合，以及轮询表是否该跑。
    /// </summary>
    private void LayoutStates()
    {
        ErrorBar.IsOpen = _lastError is not null;
        if (_lastError is not null)
        {
            ErrorBar.Message = _lastError;
        }

        SyncTimer();
    }

    /// <summary>
    /// 按搜索词 / 状态 / 排序算出可见集合，并把模型映射为卡片视图模型。
    ///
    /// <paramref name="force"/>：跳过"内容未变"短路强制重建全部卡片。唯一调用方是
    /// 主题切换 —— 卡片的画笔/样式（<see cref="InstanceCardPaint"/>）是构造时取的缓存，
    /// 主题变了必须换新实例才会重新取色。
    /// </summary>
    private void Render(bool force = false)
    {
        // 初始化期的 SelectionChanged 会先于字段赋值触发（见 _ready 注释）：
        // 这时直接返回，等 OnNavigatedTo 里的首次 Render 再画。
        if (!_ready) return;

        var next = FilterAndSort();
        var version = AppServices.IsReady ? AppServices.State.InstancesVersion : 0L;

        // 内容未变则不重建（StateChanged 防线之外的第二道闸）：
        // `instance:list` 每次成功都发 InstancesChanged（AppState 不判变化就 Invoke），
        // 且 RefreshAsync 的 finally 与 ApplyStateSnapshot 会对同一批数据连跳两次 Render；
        // Clear+Add 会重建全部 GridView 容器 —— 悬停、滚动位置与背景被重置，肉眼即"卡片闪动"。
        // 两个条件各堵一条变化路径：版本（推送帧就地变异共享对象，字段比较探测不到，
        // 见 _cardsVersion 注释）；字段比较（instance:list 换新对象但内容没变，据此跳过）。
        if (force || version != _cardsVersion || !SameCards(_visible, next))
        {
            _cards.Clear();
            foreach (var summary in next)
            {
                _cards.Add(new InstanceCard(summary));
            }

            _cardsVersion = version;
        }

        _visible = next;

        var hasAny = _all.Count > 0;
        var hasVisible = _visible.Count > 0;

        // 首屏（还没有任何数据）用居中 ProgressRing；一旦有数据就不再回到这个状态
        FirstLoadPanel.Visibility = !_initialized && !hasAny ? Visibility.Visible : Visibility.Collapsed;

        InstanceGrid.Visibility = hasVisible ? Visibility.Visible : Visibility.Collapsed;
        // 两种空态严格区分：一个实例都没有 ≠ 筛掉了（规范 §9.2「空态」）
        EmptyPanel.Visibility = _initialized && !hasAny ? Visibility.Visible : Visibility.Collapsed;
        EmptyFilterPanel.Visibility = hasAny && !hasVisible ? Visibility.Visible : Visibility.Collapsed;

        // 筛选提示条：仅在"筛掉了东西"时出现，并说明是谁挡住的
        var narrowed = hasAny && !hasVisible;
        FilterBar.IsOpen = narrowed;
        if (narrowed)
        {
            FilterBar.Message = $"没有实例匹配当前搜索或筛选条件（共 {_all.Count} 个实例）。";
        }

        EmptyFilterHint.Text = _query.Length > 0
            ? $"没有实例匹配「{_query}」。换个关键词，或切换状态筛选。"
            : "当前状态筛选下没有实例。切换筛选条件试试。";

        UpdateDegradeBar();
    }

    /// <summary>
    /// 两份可见序列是否对应同一批卡片内容（逐位比较，顺序敏感）。
    ///
    /// 与 <see cref="StateChanged"/> 分工不同：那个判"要不要替换 _all 快照"（运行态字段），
    /// 这个判"要不要重建卡片容器" —— 比较范围是**卡片构造与筛选排序实际读取的字段**
    /// （见 <see cref="CardDataEqual"/>）。名字/图标/强调色变了也必须重建，否则改完不显示。
    /// </summary>
    private static bool SameCards(List<InstanceSummary> current, List<InstanceSummary> next)
    {
        if (current.Count != next.Count) return false;

        for (var i = 0; i < next.Count; i += 1)
        {
            if (!CardDataEqual(current[i], next[i])) return false;
        }

        return true;
    }

    /// <summary>
    /// 两张卡片背后的模型在**界面可见层面**是否相等。
    ///
    /// 字段清单 = InstanceCard 构造函数读取的全部数据 + FilterAndSort/排序读取的字段：
    /// 任一不同就意味着重建后像素会变，必须重建；全同则重建纯属闪动源。
    /// 字符串一律 Ordinal（与本文件其余比较一致）；Meta/Runtime 允许为 null（JSON 可置 null）。
    /// </summary>
    private static bool CardDataEqual(InstanceSummary? a, InstanceSummary? b)
    {
        if (ReferenceEquals(a, b)) return true;
        if (a is null || b is null) return false;

        return a.Present == b.Present
            && a.EngineInstalled == b.EngineInstalled
            && a.PluginCount == b.PluginCount
            && string.Equals(a.Problem, b.Problem, StringComparison.Ordinal)
            && string.Equals(a.Meta?.Id, b.Meta?.Id, StringComparison.Ordinal)
            && string.Equals(a.Meta?.Name, b.Meta?.Name, StringComparison.Ordinal)
            && string.Equals(a.Meta?.DirName, b.Meta?.DirName, StringComparison.Ordinal)
            && string.Equals(a.Meta?.Icon, b.Meta?.Icon, StringComparison.Ordinal)
            && string.Equals(a.Meta?.Color, b.Meta?.Color, StringComparison.Ordinal)
            && string.Equals(a.Meta?.Engine?.Version, b.Meta?.Engine?.Version, StringComparison.Ordinal)
            && string.Equals(a.Meta?.Profile?.Template, b.Meta?.Profile?.Template, StringComparison.Ordinal)
            && string.Equals(a.Meta?.CreatedAt, b.Meta?.CreatedAt, StringComparison.Ordinal)
            && string.Equals(a.Meta?.LastLaunchedAt, b.Meta?.LastLaunchedAt, StringComparison.Ordinal)
            && string.Equals(a.Runtime?.State, b.Runtime?.State, StringComparison.Ordinal)
            && string.Equals(a.Runtime?.Url, b.Runtime?.Url, StringComparison.Ordinal)
            && a.Runtime?.Port == b.Runtime?.Port
            && string.Equals(a.Runtime?.LastError, b.Runtime?.LastError, StringComparison.Ordinal);
    }

    private List<InstanceSummary> FilterAndSort()
    {
        var query = _query.Trim().ToLowerInvariant();
        var filtered = new List<InstanceSummary>();

        foreach (var summary in _all)
        {
            if (!MatchesStatus(summary)) continue;

            if (query.Length > 0)
            {
                // 可搜索字段沿用旧实现（instances.ts 的 haystack）：名称、备注、目录名、引擎版本、模板
                var haystack = string.Join(
                    ' ',
                    summary.Meta?.Name,
                    summary.Meta?.Note,
                    summary.Meta?.DirName,
                    summary.Meta?.Engine?.Version,
                    summary.Meta?.Profile?.Template).ToLowerInvariant();

                if (!haystack.Contains(query, StringComparison.Ordinal)) continue;
            }

            filtered.Add(summary);
        }

        filtered.Sort(CompareBySort);
        return filtered;
    }

    private bool MatchesStatus(InstanceSummary summary)
    {
        var state = summary.Runtime?.State;

        switch (_status)
        {
            case "running":
                // 与旧实现一致：启动中也算"运行中"，否则点完启动卡片会瞬间消失
                return string.Equals(state, InstanceStateValues.Running, StringComparison.Ordinal) ||
                       string.Equals(state, InstanceStateValues.Starting, StringComparison.Ordinal);

            case "stopped":
                return string.Equals(state, InstanceStateValues.Stopped, StringComparison.Ordinal) ||
                       string.Equals(state, InstanceStateValues.Crashed, StringComparison.Ordinal);

            case "attention":
                return NeedsAttention(summary);

            default:
                return true;
        }
    }

    /// <summary>
    /// 是否需要用户处理。
    ///
    /// 单一判定来源（沿用旧 instances.ts 的 <c>needsAttention</c>）：筛选器与降级提示条共用，
    /// 避免"筛选里有、提示条里没有"的不一致。core 的 <c>problem</c> 必须算进来 ——
    /// 契约注释明确说它的用途就是"让用户知道这张卡为什么启动不了"。
    /// </summary>
    private static bool NeedsAttention(InstanceSummary summary) =>
        !summary.Present ||
        !summary.EngineInstalled ||
        !string.IsNullOrWhiteSpace(summary.Problem);

    private int CompareBySort(InstanceSummary a, InstanceSummary b)
    {
        switch (_sort)
        {
            case "name":
                return string.Compare(a.Meta?.Name, b.Meta?.Name, StringComparison.CurrentCulture);

            case "created":
                return CompareTime(b.Meta?.CreatedAt, a.Meta?.CreatedAt); // 新的在前

            case "plugins":
                return b.PluginCount.CompareTo(a.PluginCount);           // 多的在前

            default: // recent
                return CompareTime(b.Meta?.LastLaunchedAt, a.Meta?.LastLaunchedAt);
        }
    }

    /// <summary>比较两个 ISO 时间；无法解析（含 null）一律当 0：与旧实现 <c>Date.parse(...) || 0</c> 同义。</summary>
    private static int CompareTime(string? left, string? right)
    {
        var l = ParseOffset(left)?.ToUnixTimeMilliseconds() ?? 0L;
        var r = ParseOffset(right)?.ToUnixTimeMilliseconds() ?? 0L;
        return l.CompareTo(r);
    }

    private static DateTimeOffset? ParseOffset(string? iso) =>
        DateTimeOffset.TryParse(iso, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var value)
            ? value
            : null;

    /// <summary>页内降级提示：把"需要处理"的实例名与首条原因汇总到一条 Warning InfoBar。</summary>
    private void UpdateDegradeBar()
    {
        var attention = _all.FindAll(NeedsAttention);
        if (attention.Count == 0)
        {
            DegradeBar.IsOpen = false;
            return;
        }

        var names = string.Join('、', attention.Take(3).Select(item => item.Meta?.Name ?? "(未命名)"));
        var suffix = attention.Count > 3 ? $" 等 {attention.Count} 个" : string.Empty;

        // problem 原文优先（契约硬性要求），否则说明是目录缺失/引擎未安装；
        // 无论哪种，卡片内都还有一份更具体的说明，这里只做"一眼看到要处理什么"的总览。
        var first = attention.Find(item => !string.IsNullOrWhiteSpace(item.Problem))?.Problem;
        var detail = !string.IsNullOrWhiteSpace(first)
            ? first
            : "实例目录缺失或引擎未安装，卡片上的主操作已被禁用。";

        DegradeBar.Message = $"{names}{suffix}：{detail}";
        DegradeBar.IsOpen = true;
    }

    private static void SetStatusBar(InfoBar bar, bool open, string message)
    {
        bar.IsOpen = open;
        bar.Message = message;
    }

    /// <summary>
    /// 主按钮是否用强调色。
    ///
    /// 为什么不能永远用强调色：深色主题下 <c>AccentButtonStyle</c> 的目标色是按浅色主题算的，
    /// 强调按钮在深色下对比度不足。因此这里按"当前实际主题"取用：浅色或未知时用强调色；
    /// 显式深色时退回默认按钮以保证对比度。
    /// 取当前主题优先读配置，配置未装载（跟随系统）时读注册表，与旧实现
    /// <c>nativeTheme.shouldUseDarkColors</c> 的语义一致。
    ///
    /// 与 <see cref="InstanceCardPaint"/> 同文件但跨类，故为 <c>internal</c>。
    /// </summary>
    internal static bool IsDarkTheme()
    {
        var theme = AppServices.IsReady ? AppServices.State.Config?.Theme : null;
        if (string.Equals(theme, "dark", StringComparison.OrdinalIgnoreCase)) return true;
        if (string.Equals(theme, "light", StringComparison.OrdinalIgnoreCase)) return false;

        using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(
            @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
        return key?.GetValue("AppsUseLightTheme") is int value && value == 0;
    }

    private void OnActualThemeChanged(FrameworkElement sender, object args)
    {
        // 主题切换后语义色要重新取：语义画笔按主题走，缓存的旧画笔会滞留（约定 §6 的同类问题）。
        InstanceCardPaint.Reset();
        // 必须强制重建：卡片数据可能一字未变（内容短路会跳过），但画笔/主按钮样式是构造时取的，
        // 不换新实例就不会按新主题重新取色。
        Render(force: true);
    }

    /* ------------------------------------------------------------------ *
     * 头部与工具栏事件
     * ------------------------------------------------------------------ */

    private void OnPageSizeChanged(object sender, SizeChangedEventArgs e)
    {
        // 规范 §2.1：窗口宽 ≥ 640 epx → gutter 24；< 640 → 12。
        var pad = e.NewSize.Width >= 640 ? 24 : 12;
        RootGrid.Padding = new Thickness(pad);
    }

    private void OnRefreshClick(object sender, RoutedEventArgs e) => _ = RefreshAsync(showProgress: true);

    /// <summary>
    /// 页头「导入实例包」：选包 → 导入 → 刷新列表。
    ///
    /// 选文件由 Node 侧反向调用宿主方法 <c>host:pickPackFile</c> 完成
    /// （协议 §3.3：页面**不直接**碰 <c>host:</c>，只在业务通道里表达意图），
    /// 因此用户取消选择时后端返回 null —— 那是取消，不是错误。
    /// </summary>
    private async void OnImportPackClick(object sender, RoutedEventArgs e)
    {
        if (_packBusy) return;

        _packBusy = true;
        PackMenuEnabled = false;
        // 导入可能要重装依赖（数分钟），用顶部不定量进度条表达"正在处理"，
        // 而不是把界面卡住或只给一个看不到进度的对话框。
        RefreshBar.Visibility = Visibility.Visible;

        try
        {
            var result = await AppServices.Bridge.CallAsync<ImportResult>(
                Channels.PackImport,
                PackTimeout);

            if (!result.Ok)
            {
                AppServices.Toast.Error("导入实例包失败", result.Error);
                return;
            }

            // 用户取消选择包文件：后端按契约返回 null（不是失败），静默收场。
            if (result.Value is null)
            {
                return;
            }

            var imported = result.Value;
            var warnings = imported.Warnings is { Count: > 0 }
                ? string.Join("\n", imported.Warnings)
                : null;

            // 导入成功但有告警（例如引擎版本未安装已自动回退）时必须让用户看见，
            // 否则他会拿着一个"看起来正常、一启动就报错"的实例。用 Warning 而不是 Success。
            if (warnings is not null)
            {
                AppServices.Toast.Warning($"已导入实例「{imported.Name}」，但有需要注意的项。", warnings);
            }
            else
            {
                AppServices.Toast.Success($"已导入实例「{imported.Name}」。");
            }
        }
        catch (Exception ex)
        {
            // 桥接进程断开时 CallAsync 也可能抛；界面必须仍然可用。
            AppServices.Toast.Error("导入实例包失败", ex.Message);
        }
        finally
        {
            _packBusy = false;
            PackMenuEnabled = true;
            RefreshBar.Visibility = Visibility.Collapsed;
        }

        // 导入会新增实例（可能还改动了引擎绑定），刷新列表让新卡片立刻出现。
        await RefreshAsync(showProgress: false);
    }

    private void OnCreateClick(object sender, RoutedEventArgs e) =>
        AppServices.Navigation.Navigate(RouteKeys.Create);

    private void OnClearFilterClick(object sender, RoutedEventArgs e)
    {
        SearchBox.Text = string.Empty;
        _query = string.Empty;
        _status = "all";
        StatusFilter.SelectedItem = FilterAll;
        Render();
    }

    private void OnSearchTextChanged(AutoSuggestBox sender, AutoSuggestBoxTextChangedEventArgs args)
    {
        if (args.Reason != AutoSuggestionBoxTextChangeReason.UserInput) return;

        _query = sender.Text ?? string.Empty;

        // 防抖：每次按键都全量重排会让大列表掉帧（搜索框本身不失焦，见 XAML 注释）
        _searchTimer.Stop();
        _searchTimer.Start();
    }

    private void OnStatusFilterChanged(SelectorBar sender, SelectorBarSelectionChangedEventArgs args)
    {
        if (sender.SelectedItem?.Tag is string tag && tag.Length > 0)
        {
            _status = tag;
        }

        Render();
    }

    private void OnSortChanged(object sender, SelectionChangedEventArgs e)
    {
        var index = SortBox.SelectedIndex;
        if (index >= 0 && index < SortKeys.Length)
        {
            _sort = SortKeys[index];
        }

        Render();
    }

    /* ------------------------------------------------------------------ *
     * 卡片事件
     * ------------------------------------------------------------------ */

    private void OnPrimaryActionClick(object sender, RoutedEventArgs e)
    {
        var card = CardOf(sender);
        if (card is null) return;

        switch (card.State)
        {
            case InstanceStateValues.Stopped:
            case InstanceStateValues.Crashed:
                _ = LaunchAsync(card);
                break;
            case InstanceStateValues.Running:
                _ = StopAsync(card);
                break;
            default:
                // starting / stopping：按钮此时是禁用的，仅防御性兜底
                break;
        }
    }

    private void OnOpenUiClick(object sender, RoutedEventArgs e)
    {
        var card = CardOf(sender);
        if (card is null) return;

        _ = OpenUiAsync(card);
    }

    private void OnDetailClick(object sender, RoutedEventArgs e)
    {
        var card = CardOf(sender);
        if (card is null) return;

        AppServices.Navigation.NavigateToDetail(card.Summary.Meta.Id, DetailTabs.Plugins);
    }

    private void OnCardMenuClick(object sender, RoutedEventArgs e)
    {
        var card = CardOf(sender);
        if (card is null) return;

        var action = sender is FrameworkElement { Tag: string tag } ? tag : string.Empty;

        switch (action)
        {
            case "toggle":
                OnPrimaryActionClick(sender, e);
                return;
            case "openUi":
                _ = OpenUiAsync(card);
                return;
            case "detail":
                AppServices.Navigation.NavigateToDetail(card.Summary.Meta.Id, DetailTabs.Plugins);
                return;
            case "edit":
                AppServices.Navigation.NavigateToDetail(card.Summary.Meta.Id, DetailTabs.Settings);
                return;
            case "refresh":
                _ = RefreshAsync(showProgress: false);
                return;
            case "export":
                _ = ExportPackAsync(card);
                return;
            case "remove":
                _ = RemoveAsync(card);
                return;
        }

        if (Array.IndexOf(InstanceFolderValues.All, action) >= 0)
        {
            _ = OpenFolderAsync(card, action);
        }
    }

    /// <summary>
    /// 从被点击的元素向上找到承载卡片的容器，再取回该卡片的视图模型。
    ///
    /// 为什么走 DataContext 而不是给每个控件起名字：菜单项在 DataTemplate 里由 <c>Button</c>
    /// 唤出，x:Bind 的数据根是 <see cref="InstanceCard"/>，取不到 Page 上的命令属性（见 XAML 注释）。
    /// </summary>
    private static InstanceCard? CardOf(object? sender)
    {
        var element = sender as FrameworkElement;
        while (element is not null)
        {
            if (element.DataContext is InstanceCard card) return card;
            element = element.Parent as FrameworkElement;
        }

        return null;
    }

    /* ------------------------------------------------------------------ *
     * 实例操作（经 Bridge 通道，参数形状对齐 src/main/ipc.ts）
     * ------------------------------------------------------------------ */

    private async Task LaunchAsync(InstanceCard card)
    {
        var id = card.Summary.Meta.Id;

        var result = await AppServices.Bridge.CallAsync<LaunchResult>(
            Channels.InstanceLaunch,
            new LaunchRequest { InstanceId = id, AppArgs = null });

        if (result.Ok)
        {
            AppServices.Toast.Success($"实例「{card.Summary.Meta.Name}」已启动。");
        }
        else
        {
            AppServices.Toast.Error($"启动失败：{card.Summary.Meta.Name}", result.Error);
        }

        // 无论成败都重新拉一次：失败时按钮必须回到可点状态（规范 §9.2「错误」行）
        await RefreshAsync(showProgress: false);
    }

    private async Task StopAsync(InstanceCard card)
    {
        var id = card.Summary.Meta.Id;

        var result = await AppServices.Bridge.CallVoidAsync(Channels.InstanceStop, id);

        if (result.Ok)
        {
            AppServices.Toast.Success($"实例「{card.Summary.Meta.Name}」已停止。");
        }
        else
        {
            AppServices.Toast.Error($"停止失败：{card.Summary.Meta.Name}", result.Error);
        }

        await RefreshAsync(showProgress: false);
    }

    private async Task OpenFolderAsync(InstanceCard card, string which)
    {
        var result = await AppServices.Bridge.CallVoidAsync(
            Channels.InstanceOpenFolder,
            card.Summary.Meta.Id,
            which);

        if (!result.Ok)
        {
            AppServices.Toast.Error("打开目录失败", result.Error);
        }
    }

    private async Task OpenUiAsync(InstanceCard card)
    {
        var url = card.Summary.Runtime?.Url;
        if (string.IsNullOrWhiteSpace(url)) return;

        // 为什么走 host 方法而不是 Process.Start：桥接协议 §3.3 的 host:openExternal
        // 已由 Node 侧校验协议并复用既有 host 实现，安全边界只有一处。
        var result = await AppServices.Bridge.CallVoidAsync(Channels.AppOpenExternal, url);
        if (!result.Ok)
        {
            AppServices.Toast.Error("打开界面失败", result.Error);
        }
    }

    /// <summary>
    /// 卡片「更多 → 导出实例包…」：把该实例导出成 zip。
    ///
    /// 保存位置由 Node 侧通过宿主方法 <c>host:saveFile</c> 弹出系统"另存为"获得
    /// （默认落在系统下载目录），用户取消时后端返回 null —— 取消不是错误。
    /// </summary>
    private async Task ExportPackAsync(InstanceCard card)
    {
        var summary = card.Summary;
        if (_packBusy)
        {
            AppServices.Toast.Info("正在处理上一个实例包操作，请稍候。");
            return;
        }

        _packBusy = true;
        PackMenuEnabled = false;
        RefreshBar.Visibility = Visibility.Visible;

        BridgeResult<string> result;
        try
        {
            result = await AppServices.Bridge.CallAsync<string>(
                Channels.PackExport,
                PackTimeout,
                summary.Meta.Id);
        }
        catch (Exception ex)
        {
            AppServices.Toast.Error("导出实例包失败", ex.Message);
            return;
        }
        finally
        {
            _packBusy = false;
            PackMenuEnabled = true;
            RefreshBar.Visibility = Visibility.Collapsed;
        }

        if (!result.Ok)
        {
            AppServices.Toast.Error("导出实例包失败", result.Error);
            return;
        }

        // null = 用户在"另存为"里取消；静默，不报错。
        if (string.IsNullOrWhiteSpace(result.Value))
        {
            return;
        }

        AppServices.Toast.Success(
            $"已导出实例「{summary.Meta.Name}」的实例包。",
            $"保存位置：{result.Value}");

        // 把新写的包直接亮给用户看：这是"导出成功"唯一不需要用户再操作的确认方式。
        // 走宿主方法 host:openPath（协议 §3.3）而不是 Process.Start —— 路径存在性校验
        // 与打开动作都在 ShellHostMethods 里收口，页面不自建第二条打开外部路径的路径。
        // Node 侧已保证 zip 与其目录存在，因此这里的失败只影响"顺手打开"，不影响导出结果。
        // 全限定名是必需的：本文件的画笔代码用了 Microsoft.UI.Xaml.Shapes（Ellipse 等），
        // 那个命名空间里也有一个 Path，直接写 Path 会 CS0104 二义。
        var folder = System.IO.Path.GetDirectoryName(result.Value);
        if (!string.IsNullOrEmpty(folder))
        {
            var open = await AppServices.Bridge.CallVoidAsync(Channels.Host.OpenPath, new { path = folder });
            if (!open.Ok)
            {
                // 只是"打开目录"没成功，导出本身已经完成 —— 不要用错误提示惊吓用户。
                AppServices.Toast.Info("实例包已导出，但未能自动打开所在文件夹。", open.Error);
            }
        }
    }

    private async Task RemoveAsync(InstanceCard card)
    {
        var summary = card.Summary;
        var id = summary.Meta.Id;

        // 运行中的实例后端会直接拒绝删除（ipc.ts L124-126），这里先给出更前置的文案，
        // 避免用户点完才知道要停止。
        var state = summary.Runtime?.State;
        if (!string.Equals(state, InstanceStateValues.Stopped, StringComparison.Ordinal) &&
            !string.Equals(state, InstanceStateValues.Crashed, StringComparison.Ordinal))
        {
            AppServices.Toast.Warning($"实例「{summary.Meta.Name}」正在运行，请先停止后再删除。");
            return;
        }

        var confirmed = await AppServices.Dialogs.ConfirmAsync(
            "删除实例",
            $"确定要删除实例「{summary.Meta.Name}」吗？\n\n" +
            "这会从启动器中移除该实例的记录与运行数据，且不可撤销。实例目录的物理文件会被保留，" +
            "需要时可在文件管理器中自行清理。",
            primaryText: "删除实例",
            closeText: "取消",
            destructive: true);

        if (!confirmed) return;

        // 第二个参数对应 ipc.ts L127 的 mustBoolean(deleteFiles)；false = 保留磁盘文件（更安全的默认）。
        var result = await AppServices.Bridge.CallVoidAsync(Channels.InstanceRemove, id, false);

        if (result.Ok)
        {
            AppServices.Toast.Success($"已删除实例「{summary.Meta.Name}」。");
        }
        else
        {
            AppServices.Toast.Error("删除失败", result.Error);
        }

        await RefreshAsync(showProgress: false);
    }

    /* ------------------------------------------------------------------ *
     * 卡片视图模型
     * ------------------------------------------------------------------ */

}

/// <summary>
/// 一张卡片的呈现模型。
///
/// 为什么不让 XAML 直接绑 <see cref="InstanceSummary"/>：卡片外观是"五态 × 有无 problem ×
/// 有无降级"的组合，直接绑模型会把这些分支散到十几个 <c>IValueConverter</c> 里；
/// 收成一个不可变模型后，XAML 只剩布局，状态映射只有这一处实现（规范 §1.3 允许）。
///
/// 属性是 get/set（而非只读）：<c>x:Bind</c> 的 OneWay 需要 setter 才能回写；定时器只改
/// <see cref="LastLaunchedText"/> 一个字段，其余在卡片重建时一次性算好。
///
/// <see cref="LastLaunchedText"/> 必须经 <see cref="INotifyPropertyChanged"/> 通知：
/// 卡片不再随 4 秒轮询无谓重建（见 Render 的内容短路）后，"最近启动 X 分钟前"只能靠
/// 每秒定时器 + OneWay 绑定就地更新 —— 否则文本会停在卡片创建那一刻。
/// 其余属性仅在构造时赋值，OneTime 绑定在重建时取值，无需通知。
/// </summary>
public sealed class InstanceCard : System.ComponentModel.INotifyPropertyChanged
{
    public event System.ComponentModel.PropertyChangedEventHandler? PropertyChanged;

    public InstanceCard(InstanceSummary summary)
    {
        Summary = summary;

        var meta = summary.Meta ?? new InstanceMeta();
        var runtime = summary.Runtime ?? new InstanceRuntime();

        Name = string.IsNullOrWhiteSpace(meta.Name) ? "(未命名)" : meta.Name;
        DirName = meta.DirName ?? string.Empty;
        EngineVersion = $"引擎 {meta.Engine?.Version ?? "未知"}";
        PluginText = $"{summary.PluginCount} 个依赖";
        LastLaunchedText = Formatters.FormatRelative(meta.LastLaunchedAt);
        MetaSummary = $"{Name}，{LabelOf(StateOf(runtime))}，{EngineVersion}，{PluginText}，{LastLaunchedText}";

        State = StateOf(runtime);
        StateLabel = LabelOf(State);
        StateDot = InstanceCardPaint.For(State);
        BusyActive = IsBusy(State);
        BusyVisibility = BusyActive ? Visibility.Visible : Visibility.Collapsed;
        AvatarText = AvatarOf(meta);
        AccentTint = InstanceCardPaint.Tint(meta.Color);

        // 端口 / URL：运行中显示 `:端口`（旧实现同款），有 URL 时换成地址并提供 ToolTip 全文
        var url = runtime.Url;
        if (!string.IsNullOrWhiteSpace(url))
        {
            EndpointLabel = url;
            EndpointTooltip = $"界面地址：{url}";
        }
        else if (runtime.Port is int port)
        {
            EndpointLabel = $":{port.ToString(CultureInfo.InvariantCulture)}";
            EndpointTooltip = $"监听端口（多实例自动避让）：{port.ToString(CultureInfo.InvariantCulture)}";
        }
        else
        {
            EndpointLabel = string.Empty;
            EndpointTooltip = string.Empty;
        }

        OpenUiVisibility = string.Equals(State, InstanceStateValues.Running, StringComparison.Ordinal)
            ? Visibility.Visible
            : Visibility.Collapsed;
        OpenUiEnabled = !string.IsNullOrWhiteSpace(url);
        OpenUiTooltip = OpenUiEnabled
            ? $"在浏览器中打开 {url}"
            : (OpenUiVisibility == Visibility.Visible ? "尚未探测到界面地址" : "实例未运行");

        var problem = ProblemOf(summary);
        ProblemText = Shorten(problem, ProblemMaxChars);
        ProblemTooltip = problem;
        ProblemVisibility = string.IsNullOrWhiteSpace(ProblemText)
            ? Visibility.Collapsed
            : Visibility.Visible;

        DegradedText = DegradedOf(summary);
        DegradedVisibility = DegradedText.Length > 0 ? Visibility.Visible : Visibility.Collapsed;

        var primary = PrimaryOf(State, summary);
        PrimaryText = primary.Text;
        PrimaryEnabled = primary.Enabled;
        PrimaryTooltip = primary.Tooltip;
        PrimaryStyle = primary.Accent ? InstanceCardPaint.AccentButtonStyle : null;
    }

    public InstanceSummary Summary { get; }

    public string Name { get; }

    public string DirName { get; }

    public string EngineVersion { get; }

    public string PluginText { get; }

    private string _lastLaunchedText = string.Empty;

    /// <summary>随定时器重算，见 <see cref="RefreshRelativeTimes"/>。setter 发变更通知（OneWay 绑定需要）。</summary>
    public string LastLaunchedText
    {
        get => _lastLaunchedText;
        set
        {
            if (string.Equals(_lastLaunchedText, value, StringComparison.Ordinal)) return;
            _lastLaunchedText = value;
            PropertyChanged?.Invoke(
                this,
                new System.ComponentModel.PropertyChangedEventArgs(nameof(LastLaunchedText)));
        }
    }

    private string _metaSummary = string.Empty;

    /// <summary>
    /// 卡片的屏幕阅读器摘要。尾部拼了相对时间，因此与 <see cref="LastLaunchedText"/> 同步
    /// 由 <see cref="RefreshRelativeTimes"/> 就地更新（OneWay 绑定）—— 否则卡片不再随
    /// 4 秒轮询重建后，这段摘要会冻结在创建那一刻。
    /// </summary>
    public string MetaSummary
    {
        get => _metaSummary;
        set
        {
            if (string.Equals(_metaSummary, value, StringComparison.Ordinal)) return;
            _metaSummary = value;
            PropertyChanged?.Invoke(
                this,
                new System.ComponentModel.PropertyChangedEventArgs(nameof(MetaSummary)));
        }
    }

    public string State { get; }

    public string StateLabel { get; set; }

    public Brush? StateDot { get; set; }

    public bool BusyActive { get; set; }

    public Visibility BusyVisibility { get; set; }

    public string AvatarText { get; set; }

    public Brush? AccentTint { get; set; }

    public string EndpointLabel { get; set; }

    public string EndpointTooltip { get; set; }

    public Visibility OpenUiVisibility { get; set; }

    public bool OpenUiEnabled { get; set; }

    public string OpenUiTooltip { get; set; }

    public string ProblemText { get; set; }

    /// <summary>
    /// 卡片上那条原因条的完整文本（卡片里显示的是截断版，全文放 ToolTip）。
    ///
    /// 为什么要截断：崩溃时 <c>runtime.lastError</c> 的首行也可能是近千字符的单行
    /// （dsh 把整条错误链写成一行，KREA2 实测）。InfoBar 的 Message 会整段换行，
    /// 结果卡片被撑成大半屏、操作按钮被推到看不见的地方 —— 用户反馈的"按钮位置不美观"
    /// 与"日志看不全"有一部分就是它。
    /// </summary>
    public string ProblemTooltip { get; set; }

    /// <summary>卡片原因条的最大字符数（再长就截断，全文进 ToolTip）。</summary>
    private const int ProblemMaxChars = 120;

    /// <summary>超长文本截断为「前 N 字符 + …」。</summary>
    private static string Shorten(string text, int max)
    {
        if (text.Length <= max)
        {
            return text;
        }

        return string.Concat(text.AsSpan(0, max), "…");    }

    public Visibility ProblemVisibility { get; set; }

    public string DegradedText { get; set; }

    public Visibility DegradedVisibility { get; set; }

    public string PrimaryText { get; set; }

    public bool PrimaryEnabled { get; set; }

    public string PrimaryTooltip { get; set; }

    public Style? PrimaryStyle { get; set; }

    private static string StateOf(InstanceRuntime runtime)
    {
        var state = runtime.State;
        return string.IsNullOrWhiteSpace(state) ? InstanceStateValues.Stopped : state;
    }

    private static bool IsBusy(string state) =>
        string.Equals(state, InstanceStateValues.Starting, StringComparison.Ordinal) ||
        string.Equals(state, InstanceStateValues.Stopping, StringComparison.Ordinal);

    private static string LabelOf(string state) => state switch
    {
        InstanceStateValues.Running => "运行中",
        InstanceStateValues.Starting => "启动中",
        InstanceStateValues.Stopping => "停止中",
        InstanceStateValues.Crashed => "已崩溃",
        InstanceStateValues.Stopped => "已停止",
        _ => state,
    };

    /// <summary>emoji 优先，没有就用名称首字（旧实现 <c>avatar()</c> 同款规则）。</summary>
    private static string AvatarOf(InstanceMeta meta)
    {
        if (!string.IsNullOrWhiteSpace(meta.Icon)) return meta.Icon!;

        var name = meta.Name?.Trim();
        if (string.IsNullOrEmpty(name)) return "?";

        // 用 StringInfo 而不是 name[0]：emoji / 代理对首字取半会得到乱码
        var enumerator = StringInfo.GetTextElementEnumerator(name);
        return enumerator.MoveNext() ? enumerator.GetTextElement() : "?";
    }

    /// <summary>
    /// 卡片上那条黄色原因条要显示什么。
    ///
    /// 两个来源，按"更贴近用户当下处境"排序：
    ///  1. <c>summary.Problem</c> —— core 的目录级降级标记（目录缺失 / 记录损坏 / 清单损坏），
    ///     契约要求必须显示，且它是"这张卡为什么用不了"的根因；
    ///  2. <c>runtime.lastError</c> —— **上一次启动失败的说明**。
    ///
    /// 第 2 条是本次补上的：进程崩掉后卡片会立刻变红（由后端推送驱动），但如果只有
    /// 一个「已崩溃」三个字，用户仍然得点开日志才知道原因，等于把"看得见状态"和
    /// "知道怎么办"拆成了两步。core 在异常退出时已经把可操作的中文提示放在
    /// `lastError` 首行（例如"端口 3080 已被占用：…请加 --port"），这里直接呈现它。
    /// 只取首行：`lastError` 首行是提示、其后是 stderr 原文与候选列表，卡片放不下也不该放。
    /// </summary>
    private static string ProblemOf(InstanceSummary summary)
    {
        if (!string.IsNullOrWhiteSpace(summary.Problem)) return summary.Problem!;

        var runtime = summary.Runtime;
        var state = runtime?.State;
        if (!string.Equals(state, InstanceStateValues.Crashed, StringComparison.Ordinal)) return string.Empty;

        var answer = FirstLine(runtime?.LastError);
        return answer.Length > 0 ? $"上次启动异常退出：{answer}" : "上次启动异常退出，请在详情页的日志里查看原因。";
    }

    /// <summary>取多行文本的首个非空行（去掉 <c>\r</c>，避免卡片里出现方框）。</summary>
    private static string FirstLine(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return string.Empty;

        foreach (var raw in text.Split('\n'))
        {
            var line = raw.TrimEnd('\r').Trim();
            if (line.Length > 0) return line;
        }

        return string.Empty;
    }

    /// <summary>
    /// 降级说明：与旧实现 <c>instances.ts</c> 的徽标集合同义（目录缺失 / 记录异常 / 引擎未安装），
    /// 但按规范 §9.2「主按钮禁用并说明原因」合并成一行 —— 卡片里不放三枚徽标。
    /// </summary>
    private static string DegradedOf(InstanceSummary summary)
    {
        var reasons = new List<string>();

        if (!summary.Present) reasons.Add("实例目录不存在，可能已被移动或删除。");
        if (!summary.EngineInstalled) reasons.Add($"本地未安装引擎 {summary.Meta?.Engine?.Version ?? "未知"}，请先在「引擎版本」中安装。");

        return string.Join(' ', reasons);
    }

    /// <summary>五态 → 主按钮（文案 / 可用性 / 样式 / 提示）。映射依据规范 §9.2 的状态映射表。</summary>
    private static (string Text, bool Enabled, string Tooltip, bool Accent) PrimaryOf(string state, InstanceSummary summary)
    {
        // 引擎未安装时后端一定会拒绝启动（ipc.ts L142-146），这里直接禁用并说明原因
        if (!summary.EngineInstalled && !string.Equals(state, InstanceStateValues.Running, StringComparison.Ordinal))
        {
            return ("引擎未安装", false, $"本地未安装引擎 {summary.Meta?.Engine?.Version ?? "未知"}，请先在「引擎版本」中安装后再启动。", false);
        }

        if (!summary.Present)
        {
            return ("目录缺失", false, "实例目录不存在，无法启动。请检查该目录是否被移动或删除。", false);
        }

        return state switch
        {
            InstanceStateValues.Running => ("停止", true, "停止该实例", false),
            InstanceStateValues.Starting => ("启动中…", false, "实例正在启动，请稍候。", false),
            InstanceStateValues.Stopping => ("停止中…", false, "实例正在停止，请稍候。", false),
            InstanceStateValues.Crashed => ("重新启动", true, "上一次运行异常退出，点击重新启动。", true),
            _ => ("启动", true, "启动该实例", true),
        };
    }
}

/* ------------------------------------------------------------------ *
 * 画笔（实例强调色 + 语义状态色）
 * ------------------------------------------------------------------ */

/// <summary>
/// 卡片用到的画笔。
///
/// 两套来源，各有理由：
/// 1. <b>实例强调色</b>：<c>meta.color</c> 是**用户数据**（契约 §42「主题强调色，形如 #5B8DEF」），
///    不是设计令牌，无法用 <c>{ThemeResource}</c> 表达；规范 §9.2 也明示"底色由 meta.color 生成的
///    单色底"。这里把它降为 10% 不透明度的淡色底，叠在卡片底上，浅深主题都可读。
/// 2. <b>语义状态色</b>：一律用规范 §9.10.2 表格里登记的内置键（Success / Caution / Critical /
///    Attention）。
///
/// 缓存的原因：语义画笔是主题相关的，主题切换时必须丢弃（见 <c>Reset</c>），
/// 否则高对比 / 浅深切换后状态点会滞留旧色（约定 §6 的同类问题）。
/// </summary>
internal static class InstanceCardPaint
{
    private static readonly Dictionary<string, Brush> StateBrushes = new(StringComparer.Ordinal);
    private static readonly Dictionary<string, Brush> TintBrushes = new(StringComparer.OrdinalIgnoreCase);
    private static Style? _accentStyle;

    /// <summary>主按钮的强调样式（按当前主题取用，理由见 <see cref="IsDarkTheme"/>）。</summary>
    internal static Style? AccentButtonStyle =>
        InstancesPage.IsDarkTheme() ? null : (_accentStyle ??= Application.Current.Resources["AccentButtonStyle"] as Style);

    internal static Brush For(string state)
    {
        lock (StateBrushes)
        {
            if (StateBrushes.TryGetValue(state, out var cached)) return cached;

            var key = state switch
            {
                InstanceStateValues.Running => "SystemFillColorSuccessBrush",
                InstanceStateValues.Starting => "SystemFillColorAttentionBrush",
                InstanceStateValues.Stopping => "SystemFillColorAttentionBrush",
                InstanceStateValues.Crashed => "SystemFillColorCriticalBrush",
                _ => "TextFillColorTertiaryBrush",
            };

            var brush = ResourceBrush(key);
            StateBrushes[state] = brush;
            return brush;
        }
    }

    /// <summary>实例色的 10% 淡底（<c>#1A</c> = 26/255 ≈ 10%）。解析失败时退回中性底，不抛。</summary>
    internal static Brush Tint(string? color)
    {
        if (string.IsNullOrWhiteSpace(color)) return Neutral();

        lock (TintBrushes)
        {
            if (TintBrushes.TryGetValue(color, out var cached)) return cached;

            var brush = Parse(color) is Color parsed
                ? new SolidColorBrush(Color.FromArgb(0x1A, parsed.R, parsed.G, parsed.B))
                : Neutral();

            TintBrushes[color] = brush;
            return brush;
        }
    }

    private static Brush Neutral()
    {
        lock (StateBrushes)
        {
            if (StateBrushes.TryGetValue("__neutral__", out var cached)) return cached;

            var brush = ResourceBrush("CardBackgroundFillColorSecondaryBrush");
            StateBrushes["__neutral__"] = brush;
            return brush;
        }
    }

    /// <summary>主题切换后丢弃缓存（缓存里是主题相关画笔，留着就会滞留旧色）。</summary>
    internal static void Reset()
    {
        lock (StateBrushes)
        {
            StateBrushes.Clear();
        }

        lock (TintBrushes)
        {
            TintBrushes.Clear();
        }

        _accentStyle = null;
    }

    private static Brush ResourceBrush(string key) =>
        Application.Current.Resources.TryGetValue(key, out var value) && value is Brush brush
            ? brush
            : new SolidColorBrush(Colors.Gray);
    /// <summary>解析 <c>#RRGGBB</c> / <c>#AARRGGBB</c>；其余形式（rgb()、颜色名）按解析失败处理。</summary>
    private static Color? Parse(string text)
    {
        var value = text.Trim();
        if (!value.StartsWith('#')) return null;

        var hex = value[1..];
        if (hex.Length == 3)
        {
            hex = string.Concat(hex[0], hex[0], hex[1], hex[1], hex[2], hex[2]);
        }

        if (hex.Length == 6) hex = "FF" + hex;
        if (hex.Length != 8) return null;

        return uint.TryParse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var packed)
            ? Color.FromArgb(
                (byte)((packed >> 24) & 0xFF),
                (byte)((packed >> 16) & 0xFF),
                (byte)((packed >> 8) & 0xFF),
                (byte)(packed & 0xFF))
            : null;
    }
}

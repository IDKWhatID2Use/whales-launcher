using System.Collections.ObjectModel;
using WhalesLauncher.Models;

namespace WhalesLauncher.Services;

/// <summary>
/// 单一状态源。取代旧 <c>src/renderer/data/store.ts</c>。
///
/// 与旧实现的关键差异：旧 store **直接 import toast**（状态层耦合 UI），
/// 这里改为只发事件，由视图层决定怎么提示 —— 这样状态层可脱离 UI 测试。
/// </summary>
public sealed class AppState
{
    private readonly CoreBridge _bridge;

    /// <summary>
    /// 把桥接推送汇入 UI 线程的调度器；未挂载时退化为"直接在调用线程上应用"（见 <see cref="AttachRuntimePushes"/>）。
    /// </summary>
    private Microsoft.UI.Dispatching.DispatcherQueue? _dispatcher;

    public AppState(CoreBridge bridge)
    {
        _bridge = bridge;
    }

    /// <summary>实例列表。左栏与 P1 共享同一份集合。</summary>
    public ObservableCollection<InstanceSummary> Instances { get; } = new();

    /// <summary>引擎版本列表。</summary>
    public ObservableCollection<EngineInfo> Engines { get; } = new();

    public LauncherConfig? Config { get; private set; }

    public NodeRuntimeReport? NodeRuntime { get; private set; }

    public string AppVersion { get; private set; } = string.Empty;

    /// <summary>后端是否探测失败（后端断开时界面仍须可用，只做能力降级）。</summary>
    public bool BackendDown { get; private set; }

    /// <summary>后端断开的原因，用于界面提示。</summary>
    public string? BackendDownReason { get; private set; }

    /// <summary>
    /// 首次装载是否已经**结束**（无论成功还是失败）。
    ///
    /// 为什么需要它：<see cref="AppServices.IsReady"/> 只表示"服务已装配"，
    /// 而 <see cref="InitializeAsync"/> 是**在装配之后才异步跑的**（见 <c>App.xaml.cs</c>
    /// 的 <c>BootBackendAsync</c>）。审计深链若在装配完成时就导航，目标页面会在
    /// 实例列表尚未渲染完时被创建 —— 实测表现为：标题栏副标题已切到目标页面，
    /// 内容区却仍停在"正在读取实例列表…"的加载态（空数据根下必现，因为此时桥接
    /// 初始化更慢）。深链的等待条件因此必须用这个属性，而不是 IsReady。
    /// </summary>
    public bool IsInitialized { get; private set; }

    /// <summary>首次装载结束时触发（含失败与后端断开两种收尾）。</summary>
    public event EventHandler? Initialized;

    public event EventHandler? InstancesChanged;

    public event EventHandler? EnginesChanged;

    public event EventHandler? ConfigChanged;

    /// <summary>
    /// 启动装载：版本 → 配置 → 实例 → 引擎。
    ///
    /// 与旧实现一致，**任何一步失败都不阻止界面出现**：WinUI 外壳先渲染，
    /// 失败信息经事件交给视图层用 InfoBar / toast 呈现。
    /// </summary>
    public async Task InitializeAsync()
    {
        try
        {
            await LoadVersionAsync();
            await LoadConfigAsync();
            await RefreshInstancesAsync();
            await RefreshEnginesAsync();
        }
        finally
        {
            // 放在 finally：即使某一步抛错，等待者也不能被永久挂住。
            MarkInitialized();
        }
    }

    public async Task LoadVersionAsync()
    {
        var result = await _bridge.CallAsync<string>(Channels.AppVersion);
        if (result.Ok && result.Value is not null)
        {
            AppVersion = result.Value;
        }
    }

    public async Task<BridgeResult<LauncherConfig>> LoadConfigAsync()
    {
        var result = await _bridge.CallAsync<LauncherConfig>(Channels.LauncherGetConfig);
        if (result.Ok && result.Value is not null)
        {
            Config = result.Value;
            ConfigChanged?.Invoke(this, EventArgs.Empty);
        }

        return result;
    }

    public async Task<BridgeResult<LauncherConfig>> SaveConfigAsync(object patch)
    {
        var result = await _bridge.CallAsync<LauncherConfig>(Channels.LauncherSetConfig, patch);
        if (result.Ok && result.Value is not null)
        {
            Config = result.Value;
            ConfigChanged?.Invoke(this, EventArgs.Empty);
        }

        return result;
    }

    public async Task<BridgeResult<InstanceSummary[]>> RefreshInstancesAsync()
    {
        var result = await _bridge.CallAsync<InstanceSummary[]>(Channels.InstanceList);
        if (result.Ok && result.Value is not null)
        {
            ReplaceAll(Instances, result.Value);
            InstancesChanged?.Invoke(this, EventArgs.Empty);
        }

        return result;
    }

    public async Task<BridgeResult<EngineInfo[]>> RefreshEnginesAsync()
    {
        var result = await _bridge.CallAsync<EngineInfo[]>(Channels.EngineList);
        if (result.Ok && result.Value is not null)
        {
            ReplaceAll(Engines, result.Value);
            EnginesChanged?.Invoke(this, EventArgs.Empty);
        }

        return result;
    }

    /// <summary>
    /// 接住后端推来的 <c>log:state</c>（协议 §2.4）：实例运行时状态一变，界面**不用等轮询**。
    ///
    /// 为什么必须有这条：<c>instance:list</c> 是运行态的唯一事实源，但它只在被请求时才给出答案。
    /// 进程崩掉（或被杀）之后没有任何人再去问，卡片就会一直停在「运行中」，直到用户手动点「刷新」。
    /// Node 侧其实一直在推 —— core 的退出链会推最后一帧 <c>crashed</c> 快照，桥接层也把
    /// <c>log:state</c> 分派成了 <see cref="CoreBridge.LogStateChanged"/> 事件 —— 缺的只是这里的订阅。
    ///
    /// 线程模型：事件在桥接读线程上触发，而订阅方（外壳左栏、实例列表、详情页）都要碰 XAML，
    /// 因此统一经调度器切到 UI 线程后再改集合、再发通知（约定 §8），
    /// 避免"后台线程改 ObservableCollection"这类只在偶发时序下爆炸的问题。
    /// </summary>
    /// <param name="dispatcher">主窗口的 UI 调度器；为 null 时退化为同步应用（测试/无窗口场景）。</param>
    public void AttachRuntimePushes(Microsoft.UI.Dispatching.DispatcherQueue? dispatcher)
    {
        _dispatcher = dispatcher;
        _bridge.LogStateChanged += OnRuntimePushed;
    }

    /// <summary>解绑推送（窗口关闭时调用，避免桥接进程在读线程上回调到已释放的对象）。</summary>
    public void DetachRuntimePushes() => _bridge.LogStateChanged -= OnRuntimePushed;

    private void OnRuntimePushed(object? sender, InstanceRuntime runtime)
    {
        var dispatcher = _dispatcher;

        if (dispatcher is null)
        {
            ApplyRuntime(runtime);
            return;
        }

        // 队列已满/调度器已关闭时**必须**有个兜底：漏掉这一帧就等于回到"要手动刷新"的老问题。
        if (!dispatcher.TryEnqueue(() => ApplyRuntime(runtime)))
        {
            ApplyRuntime(runtime);
        }
    }

    /// <summary>
    /// 用推送来的快照就地更新对应实例的运行时状态。
    ///
    /// 只改**一个字段**（<c>Runtime</c>），不动集合：集合成员没变，卡片容器、滚动位置与
    /// 当前悬停状态都不会被重建，只是 <c>x:Bind</c> 重新取值 —— 与定时器刷新"最近启动"
    /// 文案用的是同一条思路。
    /// </summary>
    private void ApplyRuntime(InstanceRuntime runtime)
    {
        if (string.IsNullOrEmpty(runtime.InstanceId)) return;

        foreach (var item in Instances)
        {
            if (!string.Equals(item.Meta?.Id, runtime.InstanceId, StringComparison.Ordinal)) continue;

            // 状态与关键字段都没变就不发通知：桥接在启动过程中会推多帧
            // （starting → running → 端口/URL 回填），其中重复帧不该引起任何重绘。
            if (!RuntimeChanged(item.Runtime, runtime)) return;

            item.Runtime = runtime;
            InstancesChanged?.Invoke(this, EventArgs.Empty);
            return;
        }
    }

    /// <summary>
    /// 两份运行态快照是否有界面可见的差异。
    ///
    /// 比较范围就是卡片上会显示的东西（状态点/状态文字/端口/地址/主按钮可用性），
    /// 外加 <c>lastError</c>（崩溃原因）。刻意**不**比较 <c>startedAt</c>：它只在启动那一帧写一次，
    /// 而推进它的那几帧必然已经由 <c>state</c> 或 <c>pid</c> 的变化带到。
    /// </summary>
    private static bool RuntimeChanged(InstanceRuntime? current, InstanceRuntime next)
    {
        if (current is null) return true;

        return !string.Equals(current.State, next.State, StringComparison.Ordinal)
            || current.Pid != next.Pid
            || current.Port != next.Port
            || !string.Equals(current.Url, next.Url, StringComparison.Ordinal)
            || current.ExitCode != next.ExitCode
            || !string.Equals(current.LastError, next.LastError, StringComparison.Ordinal);
    }

    /// <summary>按稳定 id 查实例；不存在返回 null。</summary>
    public InstanceSummary? FindInstance(string? id)
    {
        if (string.IsNullOrEmpty(id)) return null;
        foreach (var item in Instances)
        {
            if (item.Meta?.Id == id) return item;
        }
        return null;
    }

    public void MarkBackendDown(string reason)
    {
        BackendDown = true;
        BackendDownReason = reason;

        // 后端已经不可用，装载不可能再继续：立刻放行等待者，否则深链会空等到超时。
        MarkInitialized();
    }

    /// <summary>幂等地标记"首次装载已结束"并通知等待者。</summary>
    private void MarkInitialized()
    {
        if (IsInitialized)
        {
            return;
        }

        IsInitialized = true;
        Initialized?.Invoke(this, EventArgs.Empty);
    }

    /// <summary>就地替换集合内容，保持 ObservableCollection 实例不变（绑定不会断）。</summary>
    private static void ReplaceAll<T>(ObservableCollection<T> target, IReadOnlyList<T> source)
    {
        target.Clear();
        foreach (var item in source)
        {
            target.Add(item);
        }
    }
}

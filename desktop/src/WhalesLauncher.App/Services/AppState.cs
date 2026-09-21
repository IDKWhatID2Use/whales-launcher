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
        await LoadVersionAsync();
        await LoadConfigAsync();
        await RefreshInstancesAsync();
        await RefreshEnginesAsync();
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

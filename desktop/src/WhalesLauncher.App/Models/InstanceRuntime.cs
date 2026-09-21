namespace WhalesLauncher.Models;

/// <summary>
/// 实例运行时状态。与 <c>instance.json</c> 无关，只活在进程内存里。
/// 来源：<c>src/shared/contracts.ts:110-129</c>。
///
/// 也是 <c>log:state</c> 推送事件的载荷（协议 §2.4），界面据此刷新卡片状态与按钮可用性。
/// </summary>
public sealed class InstanceRuntime
{
    public string InstanceId { get; set; } = string.Empty;

    /// <summary>取值见 <see cref="InstanceStateValues"/>。</summary>
    public string State { get; set; } = InstanceStateValues.Stopped;

    /// <summary>进程 PID，未运行时为 null。</summary>
    public int? Pid { get; set; }

    /// <summary>启动时间（ISO 8601），未运行为 null。</summary>
    public string? StartedAt { get; set; }

    /// <summary>web profile 探测到的界面地址。</summary>
    public string? Url { get; set; }

    /// <summary>
    /// 本实例**实际**使用的监听端口。
    ///
    /// 启动中先填入分配决策给出的端口；dsh 打印界面地址后再由真实端口覆盖
    /// （<c>--port 0</c> 交内核分配时，只有回读才知道端口号）。非 Web 界面时为 null。
    /// </summary>
    public int? Port { get; set; }

    /// <summary>最近一次退出码。</summary>
    public int? ExitCode { get; set; }

    /// <summary>最近一次启动失败的摘要。</summary>
    public string? LastError { get; set; }
}

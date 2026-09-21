namespace WhalesLauncher.Models;

/// <summary>
/// 一次端口分配决策（同时用于日志、运行时状态与界面展示）。
/// 来源：<c>src/shared/contracts.ts:363-377</c>。
/// </summary>
public sealed class PortDecision
{
    /// <summary>
    /// 交给 dsh 的 <c>--port</c> 值。
    /// <c>0</c> 表示交操作系统分配（区间耗尽时的兜底，保证实例一定起得来）。
    /// </summary>
    public int Port { get; set; }

    /// <summary>期望端口（发生避让前想用的那个）；无期望时为 null。</summary>
    public int? Desired { get; set; }

    /// <summary>期望端口是否因被占用/不可用而发生避让。</summary>
    public bool Avoided { get; set; }

    /// <summary>期望端口的来源，取值见 <see cref="PortSourceValues"/>。</summary>
    public string Source { get; set; } = PortSourceValues.Auto;

    /// <summary>中文说明，直接进实例日志与界面。</summary>
    public string Reason { get; set; } = string.Empty;
}

/// <summary>
/// <c>PortDecision.source</c> 的取值 —— 期望端口的来源，**顺序即优先级**。
/// 来源：<c>src/shared/contracts.ts:360</c>。
/// </summary>
public static class PortSourceValues
{
    /// <summary>用户/实例显式指定。</summary>
    public const string Explicit = "explicit";

    /// <summary>来自跨进程端口台账。</summary>
    public const string Ledger = "ledger";

    /// <summary>自动分配区间。</summary>
    public const string Auto = "auto";

    /// <summary>交操作系统分配（区间耗尽兜底）。</summary>
    public const string Os = "os";

    /// <summary>全部取值（优先级从高到低）。</summary>
    public static readonly string[] All = { Explicit, Ledger, Auto, Os };
}

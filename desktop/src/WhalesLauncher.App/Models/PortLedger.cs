namespace WhalesLauncher.Models;

/// <summary>
/// 端口台账中的一条记录。来源：<c>src/shared/contracts.ts:380-391</c>。
/// </summary>
public sealed class PortRecord
{
    /// <summary>最近一次看到的实例显示名（仅供人工阅读台账）。</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>该实例的首选端口：稳定，不随避让改变，下次启动优先复用它。</summary>
    public int Preferred { get; set; }

    /// <summary>最近一次实际分配到的端口。</summary>
    public int Last { get; set; }

    /// <summary>最近一次拿到的进程 PID；未运行或已退出为 null。</summary>
    public int? Pid { get; set; }

    /// <summary>最后更新时间（ISO 8601）。</summary>
    public string UpdatedAt { get; set; } = string.Empty;
}

/// <summary>
/// 跨进程端口台账（<c>&lt;root&gt;/cache/ports.json</c>）。
/// 来源：<c>src/shared/contracts.ts:399-404</c>。
///
/// 台账用于**持久化期望端口**与**留审计记录**，本身不是互斥手段
/// （读改写做不到原子）；互斥由进程内预留集与操作系统绑定探测保证。
/// </summary>
public sealed class PortLedger
{
    public int SchemaVersion { get; set; }

    /// <summary>实例 → 记录。TS 的 <c>Record&lt;string, PortRecord&gt;</c>。</summary>
    public Dictionary<string, PortRecord> Allocations { get; set; } = new();

    /// <summary>曾被 dsh 以 EADDRINUSE 拒绝过的端口 → 记录时间（短 TTL 内不再优先选用）。</summary>
    public Dictionary<string, string> Failures { get; set; } = new();
}

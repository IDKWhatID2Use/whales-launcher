namespace WhalesLauncher.Models;

/// <summary>
/// Node 运行时解析报告（<c>launcher:detectNode</c> 的返回值）。
/// 来源：<c>src/shared/contracts.ts:460-473</c>。
///
/// 由 core 实际执行探针后得出（绝不按路径名猜测），可在界面直接展示：
/// <c>Ok = false</c> 时 <see cref="Candidates"/> 里每条都带中文失败原因，
/// 用户据此知道"为什么不能用"。
/// </summary>
public sealed class NodeRuntimeReport
{
    /// <summary>是否找到可用的 Node.js。</summary>
    public bool Ok { get; set; }

    /// <summary>最终采用的绝对路径（失败时为 null）。</summary>
    public string? File { get; set; }

    /// <summary>采用的 Node 版本（如 <c>26.3.0</c>）。</summary>
    public string? Version { get; set; }

    /// <summary>采用的来源，取值见 <see cref="NodeRuntimeSourceValues"/>；失败为 null。</summary>
    public string? Source { get; set; }

    /// <summary>全部候选与结论。</summary>
    public List<NodeRuntimeCandidate> Candidates { get; set; } = new();

    /// <summary>面向用户的一句话结论。</summary>
    public string Message { get; set; } = string.Empty;
}

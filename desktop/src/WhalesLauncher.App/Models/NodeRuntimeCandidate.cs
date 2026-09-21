namespace WhalesLauncher.Models;

/// <summary>
/// 单个候选运行时的探测结论。来源：<c>src/shared/contracts.ts:439-452</c>。
/// </summary>
public sealed class NodeRuntimeCandidate
{
    /// <summary>候选可执行文件路径。</summary>
    public string File { get; set; } = string.Empty;

    /// <summary>该候选的来源，取值见 <see cref="NodeRuntimeSourceValues"/>。</summary>
    public string Source { get; set; } = NodeRuntimeSourceValues.Path;

    /// <summary>是否可用于运行 dsh。</summary>
    public bool Ok { get; set; }

    /// <summary>探测到的 Node 版本（失败时为 null）。</summary>
    public string? Version { get; set; }

    /// <summary>探测到的 Electron 版本（只有 Electron 宿主才有值）。</summary>
    public string? Electron { get; set; }

    /// <summary>不可用原因（中文；可用时为 null）。</summary>
    public string? Reason { get; set; }
}

/// <summary>
/// <c>NodeRuntimeSource</c> 的取值 —— Node 运行时的来源，**顺序即解析优先级**。
/// 来源：<c>src/shared/contracts.ts:436</c>。
/// </summary>
public static class NodeRuntimeSourceValues
{
    /// <summary>环境变量 <c>WHALES_NODE_PATH</c>。</summary>
    public const string Env = "env";

    /// <summary>全局设置里的 <c>nodePath</c>。</summary>
    public const string Config = "config";

    /// <summary>启动器自身进程（开发模式下就是真 node）。</summary>
    public const string Current = "current";

    /// <summary>系统 PATH。</summary>
    public const string Path = "path";

    /// <summary>常见安装位置。</summary>
    public const string Common = "common";

    /// <summary>全部取值（优先级从高到低）。</summary>
    public static readonly string[] All = { Env, Config, Current, Path, Common };
}

namespace WhalesLauncher.Models;

/// <summary>
/// 启动器根下的关键路径（core 的 <c>corePaths(root)</c> 投影）。
/// 来源：<c>src/shared/contracts.ts:735-744</c>。
///
/// 跨边界 DTO：core 是同步函数，但 Node 侧可经桥接暴露；界面只读展示，绝不自行拼接路径。
/// </summary>
public sealed class CorePaths
{
    public string Root { get; set; } = string.Empty;

    public string InstancesDir { get; set; } = string.Empty;

    public string EnginesDir { get; set; } = string.Empty;

    public string SharedDir { get; set; } = string.Empty;

    public string SharedSessionsDir { get; set; } = string.Empty;

    public string SharedWorkspacesDir { get; set; } = string.Empty;

    public string CacheDir { get; set; } = string.Empty;

    public string ConfigFile { get; set; } = string.Empty;
}

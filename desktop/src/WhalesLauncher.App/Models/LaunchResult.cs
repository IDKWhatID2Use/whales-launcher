namespace WhalesLauncher.Models;

/// <summary>
/// 启动结果。来源：<c>src/shared/contracts.ts:340-346</c>。
/// </summary>
public sealed class LaunchResult
{
    public int Pid { get; set; }

    /// <summary>实际使用的 DSH_HOME。</summary>
    public string DshHome { get; set; } = string.Empty;

    /// <summary>实际使用的工作目录。</summary>
    public string Cwd { get; set; } = string.Empty;
}

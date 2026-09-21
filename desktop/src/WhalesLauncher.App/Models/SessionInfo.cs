namespace WhalesLauncher.Models;

/// <summary>
/// 会话（存档）信息。来源：<c>src/shared/contracts.ts:319-328</c>。
/// </summary>
public sealed class SessionInfo
{
    public string Id { get; set; } = string.Empty;

    /// <summary>会话最后修改时间（ISO 8601）。</summary>
    public string UpdatedAt { get; set; } = string.Empty;

    /// <summary>会话目录绝对路径。</summary>
    public string Dir { get; set; } = string.Empty;

    /// <summary>归属的 workspace 编码目录名。</summary>
    public string WorkspaceKey { get; set; } = string.Empty;

    /// <summary>目录体积（字节），未知为 null。</summary>
    public long? SizeBytes { get; set; }
}

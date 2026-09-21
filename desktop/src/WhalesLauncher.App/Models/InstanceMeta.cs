namespace WhalesLauncher.Models;

/// <summary>
/// 实例元数据 —— <c>instance.json</c> 的形状，也是跨桥接的主 DTO。
/// 来源：<c>src/shared/contracts.ts:33-69</c>（字段逐条镜像，未增删）。
///
/// 嵌套对象（engine / profile / workspace / saves / settings / credentials / launch）
/// 各成型为独立类型，见同名文件。
/// </summary>
public sealed class InstanceMeta
{
    public int SchemaVersion { get; set; }

    /// <summary>稳定标识，重命名/移动不变。</summary>
    public string Id { get; set; } = string.Empty;

    /// <summary>显示名，可含中文与空格。</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>目录名，同时用作 dsh profile 名；必须通过 dsh 的 profile 名校验。</summary>
    public string DirName { get; set; } = string.Empty;

    /// <summary>emoji 或 null。</summary>
    public string? Icon { get; set; }

    /// <summary>主题强调色，形如 <c>#5B8DEF</c>。</summary>
    public string Color { get; set; } = string.Empty;

    public string Note { get; set; } = string.Empty;

    public InstanceEngine Engine { get; set; } = new();

    public InstanceProfile Profile { get; set; } = new();

    public ShareModeSetting Workspace { get; set; } = new();

    public ShareModeSetting Saves { get; set; } = new();

    public ShareModeSetting Settings { get; set; } = new();

    public CredentialsModeSetting Credentials { get; set; } = new();

    public InstanceLaunch Launch { get; set; } = new();

    /// <summary>创建时间（ISO 8601 字符串）。</summary>
    public string CreatedAt { get; set; } = string.Empty;

    /// <summary>最近一次启动时间（ISO 8601），从未启动为 null。</summary>
    public string? LastLaunchedAt { get; set; }

    public int LaunchCount { get; set; }
}

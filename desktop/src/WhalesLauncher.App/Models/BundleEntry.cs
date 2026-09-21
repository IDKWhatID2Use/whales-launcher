namespace WhalesLauncher.Models;

/// <summary>
/// 组合包（bundle）：参与配置树组合的插件包。
/// 来源：<c>src/shared/contracts.ts:172-180</c>。
/// </summary>
public sealed class BundleEntry
{
    public string Name { get; set; } = string.Empty;

    public bool Enabled { get; set; }

    public string? Description { get; set; }

    /// <summary>版本号，来自 dependencies 或 null。</summary>
    public string? Version { get; set; }

    /// <summary>是否随 dsh 安装提供（内置组合包）。</summary>
    public bool Builtin { get; set; }
}

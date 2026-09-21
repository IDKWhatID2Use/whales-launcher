namespace WhalesLauncher.Models;

/// <summary>
/// 一次本地插件安装的结果（<c>plugin:install</c> 的返回值）。
/// 来源：<c>src/shared/contracts.ts:299-313</c>。
/// </summary>
public sealed class PluginInstallResult
{
    public string Name { get; set; } = string.Empty;

    public string? Version { get; set; }

    /// <summary>落盘后的插件目录（<c>home/plugins/&lt;name&gt;</c>）。</summary>
    public string Dir { get; set; } = string.Empty;

    /// <summary>写入 profile 依赖项的规格，如 <c>file:../../plugins/&lt;name&gt;</c>。</summary>
    public string Spec { get; set; } = string.Empty;

    /// <summary>是否已加入 <c>dsh.profile.bundles</c>。</summary>
    public bool RegisteredBundle { get; set; }

    /// <summary>依赖是否已链接进 <c>node_modules</c>。</summary>
    public bool Linked { get; set; }

    public PluginInventory Inventory { get; set; } = new();

    /// <summary>非致命提示（如「包内没有 bundle patch，将以普通依赖安装」）。</summary>
    public List<string> Warnings { get; set; } = new();
}

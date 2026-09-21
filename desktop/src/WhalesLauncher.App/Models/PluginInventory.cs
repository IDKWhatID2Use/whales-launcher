namespace WhalesLauncher.Models;

/// <summary>
/// profile 的插件总览。来源：<c>src/shared/contracts.ts:197-202</c>。
/// </summary>
public sealed class PluginInventory
{
    public List<BundleEntry> Bundles { get; set; } = new();

    public List<PluginEntry> Dependencies { get; set; } = new();

    /// <summary>profile 目录绝对路径。</summary>
    public string ProfileDir { get; set; } = string.Empty;
}

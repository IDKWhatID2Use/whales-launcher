namespace WhalesLauncher.Models;

/// <summary>
/// 普通插件依赖。来源：<c>src/shared/contracts.ts:183-195</c>。
/// </summary>
public sealed class PluginEntry
{
    public string Name { get; set; } = string.Empty;

    public string? Version { get; set; }

    /// <summary>在 node_modules 中是否真实存在。</summary>
    public bool Installed { get; set; }

    /// <summary>
    /// profile <c>dependencies</c> 里的原始规格（如 <c>link:D:\dev\x</c>、
    /// <c>file:../../plugins/x</c>、<c>github:o/r</c>）。
    ///
    /// 界面靠它区分「随实例搬运的相对 file:」与「指向本机绝对路径的 link:」，
    /// 因此**不能**用 node_modules 里读到的版本号代替。
    /// </summary>
    public string? Spec { get; set; }
}

namespace WhalesLauncher.Models;

/// <summary>
/// <c>InstanceMeta.profile</c> 的嵌套对象：dsh profile 名与创建时使用的随附模板。
/// 来源：<c>src/shared/contracts.ts:50-55</c>。
/// </summary>
public sealed class InstanceProfile
{
    /// <summary>profile 名（<c>$DSH_HOME/profiles/&lt;name&gt;</c>）。</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>创建时使用的随附模板，如 <c>web</c>；取值见 <see cref="BundleTemplates"/>。</summary>
    public string Template { get; set; } = string.Empty;
}

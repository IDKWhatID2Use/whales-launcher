namespace WhalesLauncher.Models;

/// <summary>
/// 实例包清单（<c>&lt;实例&gt;.whalepack.zip</c> 内的 manifest）。
/// 来源：<c>src/shared/contracts.ts:479-491</c>。
/// </summary>
public sealed class PackManifest
{
    public int SchemaVersion { get; set; }

    /// <summary>固定字面值 <c>whalelauncher-pack</c>，用于识别本启动器的实例包。</summary>
    public string Kind { get; set; } = KindValue;

    /// <summary>导出时间（ISO 8601）。</summary>
    public string ExportedAt { get; set; } = string.Empty;

    public string LauncherVersion { get; set; } = string.Empty;

    /// <summary>
    /// 实例的可搬运子集：<c>Pick&lt;InstanceMeta, 'name' | 'icon' | 'color' | 'note' | 'engine' | 'profile' | 'launch'&gt;</c>。
    /// </summary>
    public PackManifestInstance Instance { get; set; } = new();

    /// <summary>需要重装的依赖包名与版本范围（TS 的 <c>Record&lt;string, string&gt;</c>）。</summary>
    public Dictionary<string, string> Requirements { get; set; } = new();

    /// <summary>需要重新登记的组合包名。</summary>
    public List<string> Bundles { get; set; } = new();

    /// <summary><see cref="Kind"/> 的定值。契约里是字面量类型 <c>'whalelauncher-pack'</c>。</summary>
    public const string KindValue = "whalelauncher-pack";
}

/// <summary>
/// <c>PackManifest.instance</c> 的嵌套对象。
/// 来源：<c>src/shared/contracts.ts:484-487</c>；复用 <see cref="InstanceMeta"/> 的 engine/profile/launch 形状。
/// </summary>
public sealed class PackManifestInstance
{
    public string Name { get; set; } = string.Empty;

    public string? Icon { get; set; }

    public string Color { get; set; } = string.Empty;

    public string Note { get; set; } = string.Empty;

    public InstanceEngine Engine { get; set; } = new();

    public InstanceProfile Profile { get; set; } = new();

    public InstanceLaunch Launch { get; set; } = new();
}

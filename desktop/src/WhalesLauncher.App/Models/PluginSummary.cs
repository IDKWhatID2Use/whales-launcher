namespace WhalesLauncher.Models;

/// <summary>
/// 本地插件在实例内的落点与启用状态（<c>plugin:listLocal</c> 的元素）。
/// 来源：<c>src/shared/contracts.ts:237-270</c>。
/// </summary>
public sealed class PluginSummary
{
    public string Name { get; set; } = string.Empty;

    public string? Version { get; set; }

    /// <summary>实例内插件目录绝对路径（<c>home/plugins/&lt;name&gt;</c>）。</summary>
    public string Dir { get; set; } = string.Empty;

    /// <summary>来源，取值见 <see cref="PluginOriginValues"/>。</summary>
    public string Origin { get; set; } = PluginOriginValues.Unknown;

    /// <summary>
    /// 是否被 profile 的 <c>dsh.profile.bundles</c> 收录。
    ///
    /// false 表示它已作为普通依赖安装，但**不会**参与配置树组合 —— 典型情况是
    /// 包内没有声明 <c>dsh.bundle.patch</c>（纯客户端插件），或用户手动停用了它。
    /// </summary>
    public bool Enabled { get; set; }

    /// <summary>包内是否声明了 <c>dsh.bundle.patch</c>。</summary>
    public bool HasBundlePatch { get; set; }

    /// <summary>包内是否声明了 <c>dsh.client</c>（有 Web 界面部分）。</summary>
    public bool HasClient { get; set; }

    /// <summary>来自包内 <c>package.json</c> 的 description（可空）。</summary>
    public string? Description { get; set; }

    /// <summary><c>dsh.bundle.patch</c> 指向的文件在包内是否存在。</summary>
    public bool PatchFileExists { get; set; }

    /// <summary>依赖规格（相对 <c>file:</c> 或 <c>link:</c>），用于识别外部引用。</summary>
    public string? Spec { get; set; }

    /// <summary>
    /// 是否由启动器安装（<c>.whales-plugins.json</c> 账本里有记录）。
    ///
    /// 界面据此对"启动器亲自装过"的插件给出明确状态：第三方自检可能报失败，
    /// 但账本 + 文件系统的事实说明它已就位。
    /// </summary>
    public bool? InstalledByLauncher { get; set; }

    /// <summary>账本记录：来源类型与来源标识（zip 路径 / GitHub 地址 / 源目录）。</summary>
    public PluginInstalledVia? InstalledVia { get; set; }
}

/// <summary><c>PluginSummary.installedVia</c> 的嵌套对象。来源：<c>src/shared/contracts.ts:269</c>。</summary>
public sealed class PluginInstalledVia
{
    /// <summary>来源类型（archive / github / folder）。</summary>
    public string Kind { get; set; } = string.Empty;

    /// <summary>来源标识（zip 路径 / GitHub 地址 / 源目录），可能为 null。</summary>
    public string? Source { get; set; }

    /// <summary>安装时间（ISO 8601）。</summary>
    public string At { get; set; } = string.Empty;
}

/// <summary><c>PluginSummary.origin</c> 的取值。来源：<c>src/shared/contracts.ts:243</c>。</summary>
public static class PluginOriginValues
{
    /// <summary>来自 zip 包。</summary>
    public const string Archive = "archive";

    /// <summary>来自 GitHub 仓库。</summary>
    public const string Github = "github";

    /// <summary>来自本地文件夹。</summary>
    public const string Folder = "folder";

    /// <summary>手工放入。</summary>
    public const string Manual = "manual";

    /// <summary>来源标记损坏，无法判定。</summary>
    public const string Unknown = "unknown";

    /// <summary>全部取值。</summary>
    public static readonly string[] All = { Archive, Github, Folder, Manual, Unknown };
}

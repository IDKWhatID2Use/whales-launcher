namespace WhalesLauncher.Models;

/// <summary>
/// 本地插件安装来源（<c>plugin:install</c> 的第二个位置参数）。
/// 来源：<c>src/shared/contracts.ts:210-234</c>，是一个**判别联合**（按 <c>kind</c> 分派）。
///
/// 为什么三种形状合成一个类而不是三个子类：契约里的联合靠 <c>kind</c> 字段判别，
/// C# 侧若拆成继承层次，序列化时还得靠多态配置（且 Node 侧只看扁平字段）。
/// 合成一个类后，未使用的字段为 null 且不会外发，落到 JSON 的形状与契约逐字一致。
/// 校验在 Node 侧 <c>mustPluginSource</c>（<c>src/main/ipc.ts:600</c>）执行，未知 kind 直接报错。
/// </summary>
public sealed class PluginSource
{
    /// <summary>取值见 <see cref="PluginSourceKindValues"/>，必填。</summary>
    public string Kind { get; set; } = string.Empty;

    /// <summary><c>kind = archive</c>：插件 zip 绝对路径。</summary>
    public string? File { get; set; }

    /// <summary><c>kind = archive</c>：期望的插件名（可空，空则取包内 <c>package.json</c> 的 name）。</summary>
    public string? Name { get; set; }

    /// <summary><c>kind = github</c>：GitHub 仓库地址或简写。</summary>
    public string? Url { get; set; }

    /// <summary><c>kind = github</c>：已解析的 ref（分支/标签/提交），可空。</summary>
    public string? Ref { get; set; }

    /// <summary><c>kind = folder</c>：本地插件目录绝对路径（含 <c>package.json</c>）。</summary>
    public string? Dir { get; set; }
}

/// <summary><c>PluginSource.kind</c> 的取值。</summary>
public static class PluginSourceKindValues
{
    public const string Archive = "archive";
    public const string Github = "github";
    public const string Folder = "folder";

    /// <summary>全部取值。</summary>
    public static readonly string[] All = { Archive, Github, Folder };
}

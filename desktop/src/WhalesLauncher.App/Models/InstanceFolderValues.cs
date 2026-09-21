namespace WhalesLauncher.Models;

/// <summary>
/// <c>instance:openFolder</c> 的 <c>which</c> 参数取值。
///
/// 契约里只内联声明为方法参数联合类型（<c>src/shared/contracts.ts:638</c>），
/// 校验逻辑在 <c>src/main/ipc.ts</c> 的 <c>openInstanceFolder()</c>（未知值报错并列出可选值）。
/// 界面按这里下传，拼错时 Node 侧会立刻给出中文错误。
/// </summary>
public static class InstanceFolderValues
{
    public const string Root = "root";
    public const string Home = "home";
    public const string Workspace = "workspace";
    public const string Logs = "logs";
    public const string Plugins = "plugins";

    /// <summary>全部取值。</summary>
    public static readonly string[] All = { Root, Home, Workspace, Logs, Plugins };
}

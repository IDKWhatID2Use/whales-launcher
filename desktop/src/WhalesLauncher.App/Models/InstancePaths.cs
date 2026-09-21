namespace WhalesLauncher.Models;

/// <summary>
/// 实例文件系统布局（全部为绝对路径）。
/// 来源：<c>src/shared/contracts.ts:747-765</c>。
///
/// 跨边界 DTO：界面"打开文件夹"需要知道有哪些位置可开，
/// 但真实路径一律以 Node 侧返回为准（<c>instance:openFolder</c> 只传语义键，
/// 见 <see cref="InstanceFolderValues"/>）。
/// </summary>
public sealed class InstancePaths
{
    public string Root { get; set; } = string.Empty;

    public string Home { get; set; } = string.Empty;

    public string Workspace { get; set; } = string.Empty;

    public string Logs { get; set; } = string.Empty;

    public string Sessions { get; set; } = string.Empty;

    public string SettingsFile { get; set; } = string.Empty;

    public string CredentialsFile { get; set; } = string.Empty;

    public string MetaFile { get; set; } = string.Empty;

    public string ProfilesDir { get; set; } = string.Empty;

    public string ProfileDir { get; set; } = string.Empty;

    /// <summary>
    /// 实例内插件目录：<c>&lt;实例&gt;/home/plugins</c>。
    ///
    /// 刻意放在实例 home 之内而不是启动器根目录：实例目录整体复制到别处
    /// （或打包迁移）时，随实例搬运的插件跟着一起走，不会丢。
    /// </summary>
    public string PluginsDir { get; set; } = string.Empty;
}

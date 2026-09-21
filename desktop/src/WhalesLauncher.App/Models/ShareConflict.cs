namespace WhalesLauncher.Models;

/// <summary>
/// 共享资源冲突记录（<c>settings:shareConflicts</c> 的元素）。
/// 来源：<c>src/shared/contracts.ts:514-524</c>。
///
/// 当实例切到共享模式、而本地与共享**都有内容且不同**时，core 会**保留本地并登记一条冲突**，
/// 而不是静默覆盖任何一边（这是曾经的 P1 数据丢失缺陷的修复结果）。
/// 界面必须把这条记录显示出来并让用户显式选择方向，否则问题会从"静默丢数据"变成"静默不生效"。
/// </summary>
public sealed class ShareConflict
{
    public string InstanceId { get; set; } = string.Empty;

    /// <summary>冲突的资源种类；目前只有 <c>settings</c>（见 <see cref="ResourceSettings"/>）。</summary>
    public string Resource { get; set; } = ResourceSettings;

    /// <summary>冲突时保留的一侧，恒为 <c>local</c>（见 <see cref="KeptLocal"/>）。</summary>
    public string Kept { get; set; } = KeptLocal;

    public string LocalFile { get; set; } = string.Empty;

    public string SharedFile { get; set; } = string.Empty;

    /// <summary>core 生成的、可直接展示给用户的说明。</summary>
    public string Message { get; set; } = string.Empty;

    /// <summary><see cref="Resource"/> 的定值（契约里是字面量类型 <c>'settings'</c>）。</summary>
    public const string ResourceSettings = "settings";

    /// <summary><see cref="Kept"/> 的定值（契约里是字面量类型 <c>'local'</c>）。</summary>
    public const string KeptLocal = "local";
}

/// <summary>
/// 冲突的解决方向（<c>settings:resolveShareConflict</c> 的第二个位置参数）。
/// 来源：<c>src/shared/contracts.ts:505</c>。
/// </summary>
public static class ShareConflictResolutionValues
{
    /// <summary>把本地推给共享。</summary>
    public const string UseLocal = "use-local";

    /// <summary>用共享覆盖本地（覆盖前 core 会写备份）。</summary>
    public const string UseShared = "use-shared";

    /// <summary>全部取值。</summary>
    public static readonly string[] All = { UseLocal, UseShared };
}

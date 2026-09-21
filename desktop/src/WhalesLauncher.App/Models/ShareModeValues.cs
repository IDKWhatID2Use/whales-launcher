namespace WhalesLauncher.Models;

/// <summary>
/// <c>ShareMode</c>（资源是否与其它实例共享）的字符串常量集。
///
/// 契约里是字符串联合类型 `'local' | 'shared'`，按约定 §3 **不用 enum**：
/// JSON 里传的就是字符串，引入 enum 只会多一层转换与失败面。
/// 来源：<c>src/shared/contracts.ts:25</c>。
/// </summary>
public static class ShareModeValues
{
    /// <summary>独立：资源落在实例目录内。</summary>
    public const string Local = "local";

    /// <summary>共享：junction 到启动器根下的 shared/。</summary>
    public const string Shared = "shared";

    /// <summary>全部取值（顺序与契约声明一致）。</summary>
    public static readonly string[] All = { Local, Shared };
}

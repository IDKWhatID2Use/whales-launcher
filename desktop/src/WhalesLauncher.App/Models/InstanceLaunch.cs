namespace WhalesLauncher.Models;

/// <summary>
/// <c>InstanceMeta.launch</c> 的嵌套对象：启动行为默认值。
/// 来源：<c>src/shared/contracts.ts:60-65</c>。
/// </summary>
public sealed class InstanceLaunch
{
    /// <summary>
    /// 追加给 dsh 应用层的参数（CLI 第一个无法识别 token 起）。
    /// 契约里是 <c>string[]</c>，C# 用 <see cref="List{T}"/> 便于 XAML 侧增删绑定。
    /// </summary>
    public List<string> AppArgs { get; set; } = new();

    /// <summary>web profile 启动后是否自动打开界面。</summary>
    public bool AutoOpenBrowser { get; set; }
}

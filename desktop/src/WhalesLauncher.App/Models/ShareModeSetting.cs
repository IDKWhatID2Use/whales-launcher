namespace WhalesLauncher.Models;

/// <summary>
/// 「共享模式」开关的通用嵌套形状 <c>{ mode: ShareMode }</c>。
///
/// 契约里 <c>InstanceMeta.workspace / saves / settings</c> 三个字段是**同一形状**
/// （<c>src/shared/contracts.ts:56-58</c>）。C# 侧刻意只镜像一份类型而不是造三个
/// 结构完全相同的类：实例设置页需要把四个隔离维度放在一张表里统一读写，
/// 三个同形异名的类型会逼出三份重复赋值代码。字段语义与契约一一对应，没有增删。
/// （凭证维度形状不同，见 <see cref="CredentialsModeSetting"/>。）
/// </summary>
public sealed class ShareModeSetting
{
    /// <summary>取值见 <see cref="ShareModeValues"/>。</summary>
    public string Mode { get; set; } = ShareModeValues.Local;
}

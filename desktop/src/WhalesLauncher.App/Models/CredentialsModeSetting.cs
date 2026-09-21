namespace WhalesLauncher.Models;

/// <summary>
/// <c>InstanceMeta.credentials</c> 的嵌套对象 <c>{ mode: CredentialsMode }</c>。
/// 来源：<c>src/shared/contracts.ts:59</c>；取值见 <see cref="CredentialsModeValues"/>。
/// </summary>
public sealed class CredentialsModeSetting
{
    public string Mode { get; set; } = CredentialsModeValues.Inherit;
}

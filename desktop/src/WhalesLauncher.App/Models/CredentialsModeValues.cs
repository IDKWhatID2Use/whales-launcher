namespace WhalesLauncher.Models;

/// <summary>
/// <c>CredentialsMode</c>（凭证策略）的字符串常量集。
/// 来源：<c>src/shared/contracts.ts:27</c>。
/// </summary>
public static class CredentialsModeValues
{
    /// <summary>继承主 home（<c>LauncherConfig.primaryHome</c>）。</summary>
    public const string Inherit = "inherit";

    /// <summary>本实例独立。</summary>
    public const string Local = "local";

    /// <summary>全部取值。</summary>
    public static readonly string[] All = { Inherit, Local };
}

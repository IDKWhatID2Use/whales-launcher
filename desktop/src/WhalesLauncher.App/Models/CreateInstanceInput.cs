namespace WhalesLauncher.Models;

/// <summary>
/// 新建实例的入参（<c>instance:create</c> 的第二个位置参数）。
/// 来源：<c>src/shared/contracts.ts:72-88</c>。
///
/// 可选字段为 null 时**不会**出现在请求 JSON 里（与 TS 的 <c>undefined</c> 等价），
/// 由 Node 侧 <c>parseCreateInput</c>（<c>src/main/ipc.ts:646</c>）按"未提供"处理并填默认值。
/// 详见 <c>CoreBridge</c> 的序列化说明。
/// </summary>
public sealed class CreateInstanceInput
{
    public string Name { get; set; } = string.Empty;

    /// <summary>省略时由 core 的 <c>makeDirName</c> 从 name 派生并去重。</summary>
    public string? DirName { get; set; }

    /// <summary>emoji 或 null。</summary>
    public string? Icon { get; set; }

    public string? Color { get; set; }

    public string? Note { get; set; }

    public string EngineVersion { get; set; } = string.Empty;

    /// <summary>dsh 随附模板名：<c>web</c> | <c>headless</c> | <c>sdk</c> | <c>sdk-minimal</c> | <c>acp</c>。</summary>
    public string Template { get; set; } = string.Empty;

    public string? ProfileName { get; set; }

    /// <summary>取值见 <see cref="ShareModeValues"/>；null = 用 core 的默认值。</summary>
    public string? Saves { get; set; }

    /// <summary>取值见 <see cref="ShareModeValues"/>。</summary>
    public string? Settings { get; set; }

    /// <summary>工作区隔离策略：<c>shared</c> 时 junction 到 <c>shared/workspaces/&lt;dirName&gt;</c>。</summary>
    public string? Workspace { get; set; }

    /// <summary>取值见 <see cref="CredentialsModeValues"/>。</summary>
    public string? Credentials { get; set; }
}

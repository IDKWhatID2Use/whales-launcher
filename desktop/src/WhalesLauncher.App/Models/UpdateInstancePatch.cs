namespace WhalesLauncher.Models;

/// <summary>
/// 可更新的字段子集（<c>instance:update</c> 的第二个位置参数）。
/// 来源：<c>src/shared/contracts.ts:91-105</c>（<c>Partial&lt;Pick&lt;InstanceMeta,...&gt;&gt;</c> + 若干附加字段）。
///
/// ⚠️ 与 <c>InstanceMeta</c> 的区别：这里**每个字段的空值都表示「不改动」**，
/// 不表示「改成 null」。原因：Node 侧 <c>parseUpdatePatch</c>（<c>src/main/ipc.ts:696</c>）
/// 是一张**严格白名单**，未列出的字段会直接报"不支持的更新字段"，
/// 因此 C# 侧只序列化真正赋值过的字段（null 一律不外发）。
/// </summary>
public sealed class UpdateInstancePatch
{
    public string? Name { get; set; }

    /// <summary>emoji；null = 不改动（若要清空，见 <c>CoreBridge</c> 的显式 null 用法说明）。</summary>
    public string? Icon { get; set; }

    public string? Color { get; set; }

    public string? Note { get; set; }

    public string? EngineVersion { get; set; }

    public List<string>? AppArgs { get; set; }

    public bool? AutoOpenBrowser { get; set; }

    /// <summary>取值见 <see cref="ShareModeValues"/>。</summary>
    public string? Saves { get; set; }

    /// <summary>取值见 <see cref="ShareModeValues"/>。</summary>
    public string? Settings { get; set; }

    /// <summary>取值见 <see cref="ShareModeValues"/>。</summary>
    public string? Workspace { get; set; }

    /// <summary>取值见 <see cref="CredentialsModeValues"/>。</summary>
    public string? Credentials { get; set; }
}

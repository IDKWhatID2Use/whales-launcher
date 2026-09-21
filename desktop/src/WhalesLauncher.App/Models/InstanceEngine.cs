namespace WhalesLauncher.Models;

/// <summary>
/// <c>InstanceMeta.engine</c> 的嵌套对象：实例绑定的 dsh 引擎版本。
/// 来源：<c>src/shared/contracts.ts:46-49</c>。
///
/// 单独成型（而不是内联）是因为 <c>PackManifest.instance</c> 的
/// <c>Pick&lt;InstanceMeta, 'engine'&gt;</c> 复用了同一形状
/// （<c>src/shared/contracts.ts:484-487</c>）。
/// </summary>
public sealed class InstanceEngine
{
    /// <summary>绑定的 dsh 引擎版本，如 <c>0.1.6-alpha.2</c>。</summary>
    public string Version { get; set; } = string.Empty;
}

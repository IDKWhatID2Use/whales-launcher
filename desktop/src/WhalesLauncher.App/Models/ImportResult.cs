namespace WhalesLauncher.Models;

/// <summary>
/// 实例包导入结果（<c>pack:import</c> 的返回值；用户取消时为 null）。
/// 来源：<c>src/shared/contracts.ts:493-498</c>。
/// </summary>
public sealed class ImportResult
{
    public string InstanceId { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;

    /// <summary>重装依赖时的警告（不阻断导入）。</summary>
    public List<string> Warnings { get; set; } = new();
}

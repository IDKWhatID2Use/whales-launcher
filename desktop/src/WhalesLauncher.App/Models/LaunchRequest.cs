namespace WhalesLauncher.Models;

/// <summary>
/// 启动请求（<c>instance:launch</c> 的唯一位置参数）。
/// 来源：<c>src/shared/contracts.ts:334-338</c>。
/// </summary>
public sealed class LaunchRequest
{
    public string InstanceId { get; set; } = string.Empty;

    /// <summary>一次性覆盖参数，不写回 <c>instance.json</c>；null = 用实例设置里的值。</summary>
    public List<string>? AppArgs { get; set; }
}

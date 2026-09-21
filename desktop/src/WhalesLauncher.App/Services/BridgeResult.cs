namespace WhalesLauncher.Services;

/// <summary>
/// 桥接调用结果 —— 契约 <c>Result&lt;T&gt;</c>（<c>src/shared/contracts.ts:19</c>）的 C# 镜像。
///
/// 判别联合 <c>{ok:true,value} | {ok:false,error}</c> 在 C# 里落成三个属性：
/// <see cref="Ok"/> 为真时读 <see cref="Value"/>，为假时读 <see cref="Error"/>。
/// 协议 §2.3 规定 <see cref="Error"/> 是**面向用户的中文文案**（不是堆栈），可直接进 InfoBar。
///
/// 为什么不用异常：桥接的另一端是进程边界，业务失败（实例不存在、引擎未安装）是**预期结果**，
/// 与"调不通"（进程已退出、超时）必须区分开 —— 后者由 <see cref="CoreBridge"/> 也归到
/// <c>Ok=false</c>，但文案里会明确写"后端已断开/超时"，界面据此提示重启。
/// </summary>
/// <typeparam name="T">返回值的 C# 类型；无返回值的方法用 <see cref="BridgeVoid"/>。</typeparam>
public sealed class BridgeResult<T>
{
    /// <summary>是否成功。</summary>
    public bool Ok { get; init; }

    /// <summary>成功时的返回值；失败时为 <c>default</c>（不要读）。</summary>
    public T? Value { get; init; }

    /// <summary>失败时的中文原因；成功时为 null。</summary>
    public string? Error { get; init; }

    /// <summary>构造成功结果。</summary>
    public static BridgeResult<T> Success(T value) => new() { Ok = true, Value = value };

    /// <summary>构造失败结果。</summary>
    public static BridgeResult<T> Failure(string error) => new() { Ok = false, Error = error };

    /// <summary>诊断用文本（不进 UI）。</summary>
    public override string ToString() => Ok ? $"ok({Value?.ToString() ?? "null"})" : $"err({Error})";
}

/// <summary>
/// <see cref="BridgeResult{T}"/> 的非泛型便捷入口，省去在返回点重复写泛型参数。
/// </summary>
public static class BridgeResult
{
    /// <summary>构造成功结果：<c>BridgeResult.Ok(summary)</c>。</summary>
    public static BridgeResult<T> Ok<T>(T value) => BridgeResult<T>.Success(value);

    /// <summary>构造失败结果：<c>BridgeResult.Fail&lt;InstanceSummary&gt;("...")</c>。</summary>
    public static BridgeResult<T> Fail<T>(string error) => BridgeResult<T>.Failure(error);
}

/// <summary>
/// 「无返回值」的占位类型，对应 TS 的 <c>Promise&lt;Result&lt;void&gt;&gt;</c>
/// （如 <c>instance:stop</c>、<c>settings:write</c>）。
///
/// Node 侧对这类方法返回的 <c>value</c> 是 <c>undefined</c>，JSON 序列化时该键会整个消失；
/// 用 <see cref="CoreBridge.CallVoidAsync"/> 调用即可，不需要读值、只看 <c>Ok</c>。
/// </summary>
public readonly struct BridgeVoid
{
    /// <summary>唯一取值（默认值）。</summary>
    public static readonly BridgeVoid Value = default;
}

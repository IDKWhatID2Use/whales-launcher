namespace WhalesLauncher.Models;

/// <summary>
/// <see cref="InstanceStateValues"/> 的等价别名，字面值全部转发（编译期常量，零运行时开销）。
///
/// 为什么保留两个名字：契约与任务清单用 <c>InstanceState</c> 指代这组常量，而约定 §3 要求
/// 常量类以 <c>Values</c> 结尾 —— 两种写法都让调用点成立，且不存在第二份字面值可漂移。
/// </summary>
public static class InstanceState
{
    public const string Stopped = InstanceStateValues.Stopped;
    public const string Starting = InstanceStateValues.Starting;
    public const string Running = InstanceStateValues.Running;
    public const string Stopping = InstanceStateValues.Stopping;
    public const string Crashed = InstanceStateValues.Crashed;

    /// <summary>全部取值，与 <see cref="InstanceStateValues.All"/> 同一实例。</summary>
    public static readonly string[] All = InstanceStateValues.All;
}

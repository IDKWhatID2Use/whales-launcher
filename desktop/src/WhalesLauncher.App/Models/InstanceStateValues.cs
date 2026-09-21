namespace WhalesLauncher.Models;

/// <summary>
/// <c>InstanceState</c>（实例运行时状态）的字符串常量集。
/// 来源：<c>src/shared/contracts.ts:108</c>。
///
/// 约定名带 <c>Values</c> 后缀（约定 §3）；为照顾按契约名书写的调用点，
/// 另有等价别名 <see cref="InstanceState"/>，两者字面值同源、不会漂移。
/// </summary>
public static class InstanceStateValues
{
    public const string Stopped = "stopped";
    public const string Starting = "starting";
    public const string Running = "running";
    public const string Stopping = "stopping";
    public const string Crashed = "crashed";

    /// <summary>全部取值（顺序与契约联合类型声明一致）。</summary>
    public static readonly string[] All = { Stopped, Starting, Running, Stopping, Crashed };
}

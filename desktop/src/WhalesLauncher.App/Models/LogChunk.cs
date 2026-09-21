namespace WhalesLauncher.Models;

/// <summary>
/// 日志流分片。来源：<c>src/shared/contracts.ts:348-353</c>。
///
/// 既是 <c>log:chunk</c> 推送事件的载荷（协议 §2.4），也是实例日志缓冲的元素类型。
/// </summary>
public sealed class LogChunk
{
    public string InstanceId { get; set; } = string.Empty;

    /// <summary>取值见 <see cref="LogStreamValues"/>。</summary>
    public string Stream { get; set; } = LogStreamValues.System;

    public string Text { get; set; } = string.Empty;

    /// <summary>产生时间（ISO 8601）。</summary>
    public string Ts { get; set; } = string.Empty;
}

/// <summary><c>LogChunk.stream</c> 的取值。来源：<c>src/shared/contracts.ts:350</c> 与 <c>LogSink</c>（<c>:732</c>）。</summary>
public static class LogStreamValues
{
    public const string Stdout = "stdout";
    public const string Stderr = "stderr";

    /// <summary>启动器自己产生的事件（不是子进程的输出）。</summary>
    public const string System = "system";

    /// <summary>全部取值。</summary>
    public static readonly string[] All = { Stdout, Stderr, System };
}

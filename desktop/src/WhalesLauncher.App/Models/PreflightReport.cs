namespace WhalesLauncher.Models;

/// <summary>
/// 环境自检的单项结论取值。来源：<c>src/shared/contracts.ts</c> 的 <c>PreflightStatus</c>。
/// </summary>
public static class PreflightStatusValues
{
    /// <summary>通过。</summary>
    public const string Ok = "ok";

    /// <summary>原本缺失/异常，本次已自动修复。</summary>
    public const string Fixed = "fixed";

    /// <summary>缺失且（按当前选项）没有自动修复。</summary>
    public const string Missing = "missing";

    /// <summary>检查本身失败。</summary>
    public const string Failed = "failed";

    /// <summary>按选项跳过（例：未开启联网探测）。</summary>
    public const string Skipped = "skipped";
}

/// <summary>
/// 环境自检的选项。来源：<c>src/shared/contracts.ts</c> 的 <c>PreflightOptions</c>。
///
/// 全部可空：契约里是可选字段，而 <c>CoreBridge</c> 的序列化会**丢弃 null 属性** ——
/// 因此"没设"与"设成 false"在跨进程语义上可以区分（前者用默认值，后者是显式关闭）。
/// </summary>
public sealed class PreflightOptions
{
    /// <summary>允许自动修复（创建数据目录等）。默认 true。</summary>
    public bool? AutoFix { get; set; }

    /// <summary>允许自动安装缺失的 dsh 引擎（联网，首次数分钟）。默认 false。</summary>
    public bool? InstallEngine { get; set; }

    /// <summary>是否探测 npm registry 连通性。默认 false。</summary>
    public bool? CheckNetwork { get; set; }

    /// <summary>忽略 Node 运行时探测缓存重新探测。默认 false。</summary>
    public bool? RefreshRuntime { get; set; }

    /// <summary>覆盖 npm registry（不传则用全局配置里的）。</summary>
    public string? Registry { get; set; }
}

/// <summary>
/// 单项检查结果。来源：<c>src/shared/contracts.ts</c> 的 <c>PreflightCheck</c>。
/// </summary>
public sealed class PreflightCheck
{
    /// <summary>稳定标识：<c>runtime-dirs</c> / <c>config</c> / <c>node</c> / <c>npm</c> / <c>engine</c> / <c>network</c>。</summary>
    public string Id { get; set; } = string.Empty;

    /// <summary>中文标题（界面直接显示）。</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>结论，取值见 <see cref="PreflightStatusValues"/>。</summary>
    public string Status { get; set; } = PreflightStatusValues.Ok;

    /// <summary>一句话结论。</summary>
    public string Summary { get; set; } = string.Empty;

    /// <summary>细节（路径、版本、候选清单等，可多行）。</summary>
    public string? Detail { get; set; }

    /// <summary>需要用户处理时的下一步建议。</summary>
    public string? Advice { get; set; }

    /// <summary>是否由本次自检自动完成修复。</summary>
    public bool AutoFixed { get; set; }

    /// <summary>自动修复产出的版本号（目前仅引擎自动安装会填）。</summary>
    public string? FixedValue { get; set; }

    /// <summary>是否为"需要用户处理"的结论（界面据此给出警告样式）。</summary>
    public bool NeedsAttention =>
        string.Equals(Status, PreflightStatusValues.Missing, StringComparison.Ordinal)
        || string.Equals(Status, PreflightStatusValues.Failed, StringComparison.Ordinal);
}

/// <summary>
/// 一次完整自检的结果。来源：<c>src/shared/contracts.ts</c> 的 <c>PreflightReport</c>。
/// </summary>
public sealed class PreflightReport
{
    /// <summary>是否为首次自检（此前没有自检状态文件）。</summary>
    public bool FirstRun { get; set; }

    /// <summary>开始时刻（ISO 8601）。</summary>
    public string StartedAt { get; set; } = string.Empty;

    /// <summary>结束时刻（ISO 8601）。</summary>
    public string FinishedAt { get; set; } = string.Empty;

    /// <summary>总耗时（毫秒）。</summary>
    public long ElapsedMs { get; set; }

    /// <summary>被检查的启动器根目录。</summary>
    public string Root { get; set; } = string.Empty;

    /// <summary>依次执行的检查项。</summary>
    public List<PreflightCheck> Checks { get; set; } = new();

    /// <summary>是否没有遗留问题（已自动修复的算通过）。</summary>
    public bool Ok { get; set; }

    /// <summary>本次自动修复的项数。</summary>
    public int FixedCount { get; set; }

    /// <summary>遗留问题项数。</summary>
    public int ProblemCount { get; set; }

    /// <summary>本次自动安装的引擎版本；没装则为 null。</summary>
    public string? InstalledEngineVersion { get; set; }

    /// <summary>面向用户的一句话结论。</summary>
    public string Message { get; set; } = string.Empty;

    /// <summary>按 id 取一个检查项；不存在返回 null。</summary>
    public PreflightCheck? Find(string id)
    {
        foreach (var item in Checks)
        {
            if (string.Equals(item.Id, id, StringComparison.Ordinal)) return item;
        }

        return null;
    }

    /// <summary>耗时的人类可读形式（与 core 的 <c>formatDuration</c> 同一口径）。</summary>
    public string ElapsedText
    {
        get
        {
            if (ElapsedMs < 1000) return $"{ElapsedMs}ms";
            var seconds = ElapsedMs / 1000.0;
            if (seconds < 60) return $"{seconds:0.0}s";
            var minutes = ElapsedMs / 60_000;
            var rest = (ElapsedMs - minutes * 60_000) / 1000;
            return $"{minutes}m{rest}s";
        }
    }
}

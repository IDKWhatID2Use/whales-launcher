namespace WhalesLauncher.Models;

/// <summary>
/// 列表用的聚合视图：元数据 + 运行时 + 三个派生标志。
/// 来源：<c>src/shared/contracts.ts:132-149</c>。
/// </summary>
public sealed class InstanceSummary
{
    public InstanceMeta Meta { get; set; } = new();

    public InstanceRuntime Runtime { get; set; } = new();

    /// <summary>目录是否真实存在。</summary>
    public bool Present { get; set; }

    /// <summary>引擎版本是否已在本地安装。</summary>
    public bool EngineInstalled { get; set; }

    /// <summary>插件数量（dependencies 条目数）。</summary>
    public int PluginCount { get; set; }

    /// <summary>
    /// 异常态说明 —— core 的「降级呈现」机制。
    ///
    /// 当 <c>instance.json</c> 损坏、或实例目录被外部删除/改名时，记录**仍会出现在列表里**
    /// 并带上这条说明（而不是被丢弃，那会让用户觉得"实例凭空消失"）。
    /// 界面**必须**把它显示出来，否则用户看到的是一张完全正常的卡片、却怎么都启动不了。
    /// </summary>
    public string? Problem { get; set; }
}

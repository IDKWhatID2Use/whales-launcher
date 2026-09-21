namespace WhalesLauncher.Shell;

/// <summary>左栏（<c>NavigationView</c> 的菜单项与底部项）里一行的形态。</summary>
public enum RailEntryKind
{
    /// <summary>一个实例。</summary>
    Instance,

    /// <summary>「新建实例」入口（规范 §9.1：实例列表末尾、分隔线之后）。</summary>
    NewInstance,

    /// <summary>实例区与操作区之间的分隔线。</summary>
    Separator,

    /// <summary>
    /// 筛选后没有任何实例时的说明行。
    /// 存在的理由：筛选无结果时若左栏直接变成空白，用户会以为实例丢了；
    /// 必须有一行文字说明"是筛选出来的空"，而不是数据没了。
    /// </summary>
    NoMatch,

    /// <summary>底部入口：引擎版本管理。</summary>
    EngineVersions,

    /// <summary>底部入口：全局设置。</summary>
    Settings,
}

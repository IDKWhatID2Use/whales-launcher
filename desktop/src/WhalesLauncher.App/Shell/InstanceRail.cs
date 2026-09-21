using System.Collections.ObjectModel;
using Microsoft.UI.Xaml;
using WhalesLauncher.Models;

namespace WhalesLauncher.Shell;

/// <summary>
/// 左侧实例栏的数据源（规范 §9.1）。
///
/// 结构（规范原文）：<c>0..n 实例；末尾一个 Separator；再一个"新建实例"</c>，
/// 无实例时**只剩「新建实例」**。
///
/// 为什么用 <c>ObservableCollection&lt;object&gt;</c> 混装三种元素：
/// <c>NavigationViewItem</c> / <c>NavigationViewItemSeparator</c> 都派生自
/// <c>NavigationViewItemBase</c>（即 <c>ListViewItem</c>），作为数据项时是"自己就是容器"，
/// 因此分隔线可以用控件实例，而实例行用数据对象 + <c>MenuItemTemplate</c>。
/// </summary>
public sealed class InstanceRail
{
    private readonly Style? _dotRunning;
    private readonly Style? _dotTransitional;
    private readonly Style? _dotCrashed;
    private readonly Style? _dotStopped;

    public InstanceRail(ResourceDictionary resources)
    {
        ArgumentNullException.ThrowIfNull(resources);

        // 状态点样式在这里取一次引用即可：样式内部的 {ThemeResource} 由框架在元素上求值，
        // 主题切换时会重新解析，所以不需要在换主题时重建这些行。
        _dotRunning = resources["RailDotRunning"] as Style;
        _dotTransitional = resources["RailDotTransitional"] as Style;
        _dotCrashed = resources["RailDotCrashed"] as Style;
        _dotStopped = resources["RailDotStopped"] as Style;
    }

    /// <summary>绑定给 <c>NavigationView.MenuItemsSource</c> 的集合（实例稳定，内容随刷新变化）。</summary>
    public ObservableCollection<object> Items { get; } = new();

    /// <summary>
    /// 绑定给 <c>NavigationView.FooterMenuItemsSource</c> 的底部入口。
    ///
    /// 同样是**数据对象**而不是 <c>NavigationViewItem</c>：自容器项会被套上 MenuItemTemplate，
    /// 导致模板里针对 <see cref="RailEntry"/> 的绑定全部失败（见 <see cref="RailEntry"/> 的类注释）。
    /// </summary>
    public IReadOnlyList<RailEntry> FooterItems { get; } = new[] { RailEntry.EngineVersions(), RailEntry.Settings() };

    /// <summary>
    /// 按当前实例列表与筛选词重建左栏。
    /// </summary>
    /// <param name="instances">状态源里的实例（尚未装载时为 null）。</param>
    /// <param name="filter">筛选词，空表示不过滤。</param>
    public void Rebuild(IReadOnlyList<InstanceSummary>? instances, string? filter)
    {
        var keyword = string.IsNullOrWhiteSpace(filter) ? null : filter.Trim();
        var all = instances ?? Array.Empty<InstanceSummary>();
        var matched = new List<InstanceSummary>();

        foreach (var item in all)
        {
            if (keyword is null || Matches(item, keyword))
            {
                matched.Add(item);
            }
        }

        Items.Clear();

        foreach (var item in matched)
        {
            Items.Add(RailEntry.ForInstance(item, DotStyleFor(item)));
        }

        if (all.Count == 0)
        {
            // 无实例：不画分隔线，只剩「新建实例」（规范 §9.1 空态）
        }
        else if (matched.Count == 0)
        {
            Items.Add(RailEntry.NoMatch(keyword!));
        }
        else
        {
            Items.Add(RailEntry.Separator());
        }

        Items.Add(RailEntry.NewInstance());
    }

    /// <summary>在当前（可能已被筛选的）行里找某实例；找不到返回 null。</summary>
    public RailEntry? Find(string? instanceId)
    {
        if (string.IsNullOrEmpty(instanceId))
        {
            return null;
        }

        foreach (var item in Items)
        {
            if (item is RailEntry { Kind: RailEntryKind.Instance } entry &&
                string.Equals(entry.InstanceId, instanceId, StringComparison.Ordinal))
            {
                return entry;
            }
        }

        return null;
    }

    /// <summary>在底部入口里找一个固定入口（引擎版本管理 / 全局设置）。</summary>
    public RailEntry FindFooter(RailEntryKind kind)
    {
        foreach (var item in FooterItems)
        {
            if (item.Kind == kind)
            {
                return item;
            }
        }

        // FooterItems 是编译期固定两项，走不到这里；抛异常比返回 null 更容易定位拼写错误
        throw new ArgumentOutOfRangeException(nameof(kind), kind, "底部入口只有引擎版本管理与全局设置两项。");
    }

    /// <summary>
    /// 筛选匹配：名称 / 目录名 / 备注 / id 任一命中即可。
    /// 之所以连目录名一起匹配：用户填的是 dsh profile 名（= 目录名），与显示名常常不同。
    /// </summary>
    private static bool Matches(InstanceSummary summary, string keyword)
    {
        var meta = summary.Meta;
        return Contains(meta.Name, keyword)
            || Contains(meta.DirName, keyword)
            || Contains(meta.Note, keyword)
            || Contains(meta.Id, keyword);
    }

    private static bool Contains(string? value, string keyword) =>
        !string.IsNullOrEmpty(value) && value.Contains(keyword, StringComparison.CurrentCultureIgnoreCase);

    private Style? DotStyleFor(InstanceSummary summary) => summary.Runtime.State switch
    {
        InstanceStateValues.Running => _dotRunning,
        InstanceStateValues.Starting or InstanceStateValues.Stopping => _dotTransitional,
        InstanceStateValues.Crashed => _dotCrashed,
        _ => _dotStopped,
    };
}

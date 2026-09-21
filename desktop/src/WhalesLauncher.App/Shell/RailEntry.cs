using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media;
using WhalesLauncher.Models;

namespace WhalesLauncher.Shell;

/// <summary>
/// 左栏一行（实例 / 新建实例 / 分隔线 / 无匹配 / 底部入口）。
///
/// 规范 §6.1 明确禁止在 code-behind 里手工往 <c>NavigationView.MenuItems</c> 塞
/// <c>NavigationViewItem</c>（那样会丢掉模板可替换性）；实测还有一层更硬的原因：
/// <c>NavigationView</c> 会把 <c>MenuItemTemplate</c> 同样套到"自容器"项
/// （<c>NavigationViewItem</c> / <c>NavigationViewItemSeparator</c>）的内容上，
/// 于是模板里针对 <see cref="RailEntry"/> 的 x:Bind 全部失败、各分支停留在默认的
/// <c>Visibility=Visible</c>，画面上出现"空头像框 + 空警示图标 + 假『新建实例』"的垃圾行。
/// 因此**所有行（含分隔线与底部入口）都必须是数据对象**，由同一个模板呈现。
///
/// 对象不可变 + 每次重建：过滤与刷新都换新对象，不需要 INotifyPropertyChanged。
/// </summary>
public sealed class RailEntry
{
    private RailEntry(RailEntryKind kind)
    {
        Kind = kind;
    }

    public RailEntryKind Kind { get; }

    /// <summary>实例稳定 id（仅 <see cref="RailEntryKind.Instance"/> 有值）。</summary>
    public string InstanceId { get; private init; } = string.Empty;

    /// <summary>显示名（实例名或入口标签）。</summary>
    public string Name { get; private init; } = string.Empty;

    /// <summary>头像文字：实例 emoji（<c>meta.icon</c>）或名称首字。</summary>
    public string AvatarText { get; private init; } = string.Empty;

    /// <summary>状态文字（规范 §9.1：状态必须同时有文字，颜色只是辅色）。</summary>
    public string StatusText { get; private init; } = string.Empty;

    /// <summary>悬停提示：把 id / 目录名 / 引擎版本等左栏放不下的信息给全。</summary>
    public string Tooltip { get; private init; } = string.Empty;

    /// <summary>降级说明（<c>InstanceSummary.problem</c> 原文），空串表示正常。</summary>
    public string ProblemText { get; private init; } = string.Empty;

    /// <summary>状态点样式（颜色在 Style 的 Setter 里由 <c>{ThemeResource}</c> 求值）。</summary>
    public Style? DotStyle { get; private init; }

    /// <summary>图标字形（Segoe Fluent Icons），供"入口"型行使用。</summary>
    public string Glyph { get; private init; } = string.Empty;

    /* 模板里的显示开关：NavigationView 只有单一的 MenuItemTemplate（没有模板选择器），
       所以所有行共用一个模板，靠 Visibility 分支区分形态。 */

    public Visibility InstanceVisibility =>
        Kind == RailEntryKind.Instance ? Visibility.Visible : Visibility.Collapsed;

    /// <summary>「图标 + 文字」的入口行：新建实例 / 引擎版本管理 / 全局设置。</summary>
    public Visibility SimpleVisibility =>
        Kind is RailEntryKind.NewInstance or RailEntryKind.EngineVersions or RailEntryKind.Settings
            ? Visibility.Visible
            : Visibility.Collapsed;

    public Visibility SeparatorVisibility =>
        Kind == RailEntryKind.Separator ? Visibility.Visible : Visibility.Collapsed;

    public Visibility NoMatchVisibility =>
        Kind == RailEntryKind.NoMatch ? Visibility.Visible : Visibility.Collapsed;

    /// <summary>有降级说明时才显示警示图标（契约要求 <c>problem</c> 必须可见）。</summary>
    public Visibility ProblemVisibility =>
        string.IsNullOrEmpty(ProblemText) ? Visibility.Collapsed : Visibility.Visible;

    /// <summary>由一条实例摘要构造左栏行。</summary>
    public static RailEntry ForInstance(InstanceSummary summary, Style? dotStyle)
    {
        var meta = summary.Meta;
        var name = string.IsNullOrWhiteSpace(meta.Name) ? meta.DirName : meta.Name;
        var status = InstanceStateText.Label(summary.Runtime.State);

        var tooltip = string.IsNullOrWhiteSpace(summary.Problem)
            ? $"{name}（{meta.DirName}）\n状态：{status}\n引擎：{EngineLabel(meta)}"
            : $"{name}（{meta.DirName}）\n状态：{status}\n引擎：{EngineLabel(meta)}\n异常：{summary.Problem}";

        return new RailEntry(RailEntryKind.Instance)
        {
            InstanceId = meta.Id,
            Name = string.IsNullOrWhiteSpace(name) ? "未命名实例" : name,
            AvatarText = Avatar(meta),
            StatusText = status,
            Tooltip = tooltip,
            ProblemText = summary.Problem ?? string.Empty,
            DotStyle = dotStyle,
        };
    }

    /// <summary>「新建实例」行。</summary>
    public static RailEntry NewInstance() => new(RailEntryKind.NewInstance)
    {
        Name = "新建实例",
        StatusText = "新建实例",
        Tooltip = "创建一个新的 dsh 实例",
        Glyph = "\uE710", // Add
    };

    /// <summary>分隔线（实例区与操作区之间）。</summary>
    public static RailEntry Separator() => new(RailEntryKind.Separator);

    /// <summary>筛选无结果的说明行。</summary>
    public static RailEntry NoMatch(string keyword) => new(RailEntryKind.NoMatch)
    {
        Name = "无匹配实例",
        StatusText = $"没有匹配「{keyword}」的实例",
        Tooltip = "清空筛选框可恢复完整列表",
    };

    /// <summary>底部入口：引擎版本管理。</summary>
    public static RailEntry EngineVersions() => new(RailEntryKind.EngineVersions)
    {
        Name = "引擎版本管理",
        Tooltip = "安装、移除 dsh 引擎版本",
        Glyph = "\uE71D", // AllApps
    };

    /// <summary>底部入口：全局设置。</summary>
    public static RailEntry Settings() => new(RailEntryKind.Settings)
    {
        Name = "全局设置",
        Tooltip = "主题、Node 运行时与其它全局配置",
        Glyph = "\uE713", // Setting
    };

    private static string Avatar(InstanceMeta meta)
    {
        if (!string.IsNullOrWhiteSpace(meta.Icon))
        {
            // IsNullOrWhiteSpace 已排除 null，但编译器不做该流分析，故此处 ! 是安全的（约定 §8）
            return meta.Icon!;
        }

        var name = string.IsNullOrWhiteSpace(meta.Name) ? meta.DirName : meta.Name;
        return string.IsNullOrEmpty(name) ? "?" : name[..1];
    }

    private static string EngineLabel(InstanceMeta meta) =>
        string.IsNullOrWhiteSpace(meta.Engine.Version) ? "未绑定" : meta.Engine.Version;
}

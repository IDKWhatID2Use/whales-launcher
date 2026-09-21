using Microsoft.UI.Xaml;
using WhalesLauncher.Models;

namespace WhalesLauncher.Views.Detail;

/// <summary>
/// 本地插件卡（视觉规范 §9.3 块 B）。
///
/// 规范要求把 <c>hasBundlePatch</c> / <c>hasClient</c> / <c>patchFileExists</c> /
/// <c>installedByLauncher</c> 以「Badge 形式」展示 —— 这些是从 bool 到文本 + 可见性的映射，
/// 集中在投影里做，避免 code-behind 里散落一堆控件赋值。
///
/// 另外规范 §9.3 明确要求：当「<c>installedByLauncher</c> 与自检结论不一致」时给 Warning。
/// 该项目前落在 <see cref="PluginInventory"/>（三块）级别的提示里，此处提供
/// <see cref="NeedsAttention"/> 供上层判定。
/// </summary>
public sealed class LocalPluginRow
{
    public LocalPluginRow(PluginSummary summary)
    {
        Summary = summary;
    }

    public PluginSummary Summary { get; }

    public string Name => Summary.Name;

    public string VersionText => string.IsNullOrEmpty(Summary.Version) ? "版本未知" : Summary.Version;

    public string DescriptionText => Summary.Description ?? string.Empty;

    public Visibility DescriptionVisibility =>
        string.IsNullOrWhiteSpace(Summary.Description) ? Visibility.Collapsed : Visibility.Visible;

    /// <summary>来源徽标文本（zip / GitHub / 文件夹 / 手工 / 来源标记损坏）。</summary>
    public string OriginText => Summary.Origin switch
    {
        PluginOriginValues.Archive => "zip",
        PluginOriginValues.Github => "GitHub",
        PluginOriginValues.Folder => "文件夹",
        PluginOriginValues.Manual => "手工放入",
        _ => "来源标记损坏",
    };

    /// <summary>来源标记损坏时用 Warning 语义，让用户知道"这行不可信"。</summary>
    public bool IsOriginUnknown => Summary.Origin == PluginOriginValues.Unknown || string.IsNullOrEmpty(Summary.Origin);

    public string EnabledText => Summary.Enabled ? "已参与配置树" : "已停用";

    public string BundlePatchText => Summary.HasBundlePatch
        ? (Summary.PatchFileExists ? "bundle patch 就绪" : "bundle patch 缺失")
        : "无 bundle patch";

    public bool IsBundlePatchBroken => Summary.HasBundlePatch && !Summary.PatchFileExists;

    public string ClientText => Summary.HasClient ? "含 Web 界面" : "无 Web 界面";

    /// <summary>
    /// 账本与自检不一致：账本说"启动器亲自装过"，但包内没有 bundle patch 且未参与配置树。
    ///
    /// 契约（<c>contracts.ts:261-267</c>）要求界面给出明确状态：第三方自检可能报失败，
    /// 而账本 + 文件系统的事实说明它已就位。这里把差异显式标出来，而不是让用户自己猜。
    /// </summary>
    public bool NeedsAttention => Summary.InstalledByLauncher == true && !Summary.Enabled && !Summary.HasBundlePatch;

    public Visibility AttentionVisibility => NeedsAttention ? Visibility.Visible : Visibility.Collapsed;

    /// <summary>路径（省略号 + ToolTip 全文，规范 §4.3「路径不断的处理」）。</summary>
    public string ShortDir => Services.Formatters.ShortenPath(Summary.Dir);

    /// <summary>ToolTip 用全文路径。</summary>
    public string Dir => Summary.Dir;
}

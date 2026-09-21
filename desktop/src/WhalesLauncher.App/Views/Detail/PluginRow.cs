using Microsoft.UI.Xaml;
using WhalesLauncher.Models;

namespace WhalesLauncher.Views.Detail;

/// <summary>
/// 依赖表的一行（视觉规范 §9.3 块 C）。
///
/// 为什么要包一层：契约里的 <see cref="PluginEntry"/> 只有 <c>installed</c> 布尔值，
/// 而规范要求「未安装的行整行 <c>TextFillColorSecondaryBrush</c>」、「<c>link:</c> 开头的行
/// 额外给一个『外部引用』徽标」。XAML 无法从 bool 直接产出 Visibility / Brush，
/// 投影放在这里比在 code-behind 里逐行设属性更不容易漂移。
/// </summary>
public sealed class PluginRow
{
    public PluginRow(PluginEntry entry)
    {
        Entry = entry;
    }

    public PluginEntry Entry { get; }

    public string Name => Entry.Name;

    /// <summary>
    /// <c>spec</c> 原文。
    ///
    /// 契约（<c>contracts.ts:188-194</c>）明确：**不能**用 node_modules 里读到的版本号代替 ——
    /// 用户正是靠它区分「随实例搬运的相对 <c>file:</c>」与「指向本机绝对路径的 <c>link:</c>」。
    /// </summary>
    public string SpecText => string.IsNullOrEmpty(Entry.Spec) ? "—" : Entry.Spec;

    public string VersionText => string.IsNullOrEmpty(Entry.Version) ? "—" : Entry.Version;

    public string StatusText => Entry.Installed ? "已安装" : "未安装";

    /// <summary><c>link:</c> 指向本机绝对路径，随实例目录复制到别的机器会失效 —— 必须显式提示。</summary>
    public bool IsExternalReference =>
        Entry.Spec is not null && Entry.Spec.StartsWith("link:", StringComparison.OrdinalIgnoreCase);

    public Visibility ExternalBadgeVisibility => IsExternalReference ? Visibility.Visible : Visibility.Collapsed;

    /// <summary>未安装的行整体用二级文字色（规范 §9.3 块 C）。</summary>
    public bool IsInstalled => Entry.Installed;
}

using System.ComponentModel;
using Microsoft.UI.Xaml;
using WhalesLauncher.Models;

namespace WhalesLauncher.Views.Detail;

/// <summary>
/// 内置组合包行（视觉规范 §9.3 块 A）。
///
/// 只做两件事：把可空的 <c>version</c> 变成「有/无」两种呈现，把 <c>builtin</c> 变成徽标可见性；
/// 并把 <c>Enabled</c> 包成**会发通知**的属性，供开关做 OneWay 绑定。
///
/// 为什么 <c>Enabled</c> 要包一层而不是直接绑 <c>Entry.Enabled</c>：
/// <see cref="BundleEntry"/> 是契约镜像（`Models/**` 属共享层，不可改），它不实现
/// <c>INotifyPropertyChanged</c>。直接 OneWay 绑一个不会发通知的属性，XAML 编译器会给出
/// **WMC1506**（"OneWay 绑定要求至少一步支持变更通知"），而本工程把该告警当错误处理 ——
/// 也就是说这会让整个工程构建失败。包一层后：
/// <list type="bullet">
///   <item><description>乐观更新时我们通过 <see cref="Enabled"/> 同时改模型与界面，语义单一；</description></item>
///   <item><description>后端失败回滚只需再赋一次值，开关自动拨回。</description></item>
/// </list>
/// </summary>
public sealed class BundleRow : INotifyPropertyChanged
{
    public BundleRow(BundleEntry entry)
    {
        Entry = entry;
    }

    public BundleEntry Entry { get; }

    public string VersionText => string.IsNullOrEmpty(Entry.Version) ? "版本未知" : Entry.Version!;

    /// <summary>规范 §9.3 块 A 的「随 dsh 安装」徽标。</summary>
    public Visibility BuiltinBadgeVisibility => Entry.Builtin ? Visibility.Visible : Visibility.Collapsed;

    /// <summary>
    /// 是否启用。写入时同步落到模型（<see cref="BundleEntry.Enabled"/>），
    /// 这样"乐观更新"与"失败回滚"都只需要操作这一个属性。
    /// </summary>
    public bool Enabled
    {
        get => Entry.Enabled;
        set
        {
            if (Entry.Enabled == value)
            {
                return;
            }

            Entry.Enabled = value;
            PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(Enabled)));
        }
    }

    public event PropertyChangedEventHandler? PropertyChanged;
}

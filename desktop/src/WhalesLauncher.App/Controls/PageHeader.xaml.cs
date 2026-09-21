using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace WhalesLauncher.Controls;

/// <summary>
/// 页面页头：标题 + 一句说明 + 本页主操作区。
///
/// 对应视觉规范 §9.0 通用页面骨架的 Row 0。所有页面统一使用，不得自行拼页头。
/// </summary>
public sealed partial class PageHeader : UserControl
{
    public PageHeader()
    {
        InitializeComponent();
        Apply();
    }

    public static readonly DependencyProperty TitleProperty = DependencyProperty.Register(
        nameof(Title),
        typeof(string),
        typeof(PageHeader),
        new PropertyMetadata(string.Empty, OnAnyChanged));

    public static readonly DependencyProperty DescriptionProperty = DependencyProperty.Register(
        nameof(Description),
        typeof(string),
        typeof(PageHeader),
        new PropertyMetadata(null, OnAnyChanged));

    /// <summary>页面标题。对应规范 §9.0 的 <c>TitleTextBlockStyle</c>。</summary>
    public string Title
    {
        get => (string)GetValue(TitleProperty);
        set => SetValue(TitleProperty, value);
    }

    /// <summary>一句话说明。为空时整行隐藏（不占位、不留空白）。</summary>
    public string? Description
    {
        get => (string?)GetValue(DescriptionProperty);
        set => SetValue(DescriptionProperty, value);
    }

    /// <summary>本页主操作区（按钮 / 命令栏）。为空时整列隐藏。</summary>
    public UIElement? Actions
    {
        get => ActionsHost.Content as UIElement;
        set
        {
            ActionsHost.Content = value;
            Apply();
        }
    }

    private static void OnAnyChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
    {
        ((PageHeader)d).Apply();
    }

    private void Apply()
    {
        TitleText.Text = Title ?? string.Empty;

        var hasDescription = !string.IsNullOrWhiteSpace(Description);
        DescriptionText.Text = Description ?? string.Empty;
        DescriptionText.Visibility = hasDescription ? Visibility.Visible : Visibility.Collapsed;

        ActionsHost.Visibility = ActionsHost.Content is null ? Visibility.Collapsed : Visibility.Visible;
    }
}

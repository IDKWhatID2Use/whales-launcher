using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using WhalesLauncher.Models;

namespace WhalesLauncher.Controls;

/// <summary>
/// 环境自检报告的呈现（首次启动的对话框与设置页共用）。
///
/// 设计要点：
///  - **结论先行**：顶部一句话说明"检查了什么、修了什么、还剩什么"，细节在下；
///  - **逐项三通道**：颜色 + 图标 + 状态文字同时表达，色盲用户与高对比模式下同样可读；
///  - **如实**：`advice` 只在真的需要用户动手时出现；没有问题时**不写"环境正常"**
///    （规范 §9.4 禁止假保证式文案 —— 自检只覆盖它检查过的项）。
/// </summary>
public sealed partial class PreflightReportView : UserControl
{
    public PreflightReportView()
    {
        InitializeComponent();
    }

    /// <summary>
    /// 展示一份报告。
    /// @param report 报告（null 表示"还没跑过"）。
    /// @param failureReason 自检本身没跑起来时的原因（非空则显示错误条）。
    /// @param footer 底部补充说明（例如"进度可打开运行日志查看"）。
    /// </summary>
    public void Render(PreflightReport? report, string? failureReason = null, string? footer = null)
    {
        CheckList.Children.Clear();

        if (failureReason is not null)
        {
            FailureBar.Message = failureReason;
            FailureBar.IsOpen = true;
        }
        else
        {
            FailureBar.IsOpen = false;
        }

        FooterText.Text = footer ?? string.Empty;
        FooterText.Visibility = string.IsNullOrWhiteSpace(footer) ? Visibility.Collapsed : Visibility.Visible;

        if (report is null)
        {
            ConclusionText.Text = "尚未运行环境自检。";
            CountersText.Visibility = Visibility.Collapsed;
            return;
        }

        ConclusionText.Text = report.Message;

        var okCount = 0;
        var fixedCount = 0;
        var attentionCount = 0;
        var skippedCount = 0;
        foreach (var check in report.Checks)
        {
            if (check.NeedsAttention) attentionCount += 1;
            else if (string.Equals(check.Status, PreflightStatusValues.Fixed, StringComparison.Ordinal)) fixedCount += 1;
            else if (string.Equals(check.Status, PreflightStatusValues.Skipped, StringComparison.Ordinal)) skippedCount += 1;
            else okCount += 1;
        }

        CountersText.Text =
            $"共 {report.Checks.Count} 项：正常 {okCount} · 自动修复 {fixedCount} · 待处理 {attentionCount}" +
            (skippedCount > 0 ? $" · 未检查 {skippedCount}" : string.Empty) +
            $"（用时 {report.ElapsedText}）";
        CountersText.Visibility = Visibility.Visible;

        foreach (var check in report.Checks)
        {
            CheckList.Children.Add(BuildCheckRow(check));
        }
    }

    /// <summary>构造一行检查结论。</summary>
    private UIElement BuildCheckRow(PreflightCheck check)
    {
        var row = new StackPanel { Spacing = 4 };

        // 第一行：图标 + 标题 + 右侧状态徽标（图标是装饰性的，语义由文字承担）
        var header = new Grid { ColumnSpacing = 8 };
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        var icon = new SymbolIcon
        {
            Symbol = SymbolFor(check.Status),
            Foreground = BrushFor(check.Status),
            VerticalAlignment = VerticalAlignment.Top,
        };
        // 纯装饰图标从无障碍树里摘掉（规范 §8.1）：紧随其后的标题与状态文字已表达全部信息
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetAccessibilityView(
            icon,
            Microsoft.UI.Xaml.Automation.Peers.AccessibilityView.Raw);
        Grid.SetColumn(icon, 0);
        header.Children.Add(icon);

        var title = new TextBlock
        {
            Text = check.Title,
            Style = PageStyle("PreflightRowTitleStyle"),
            TextWrapping = TextWrapping.Wrap,
            VerticalAlignment = VerticalAlignment.Center,
        };
        Grid.SetColumn(title, 1);
        header.Children.Add(title);

        var badge = new TextBlock
        {
            Text = StatusLabel(check.Status),
            Style = PageStyle(BadgeStyleKey(check.Status)),
            VerticalAlignment = VerticalAlignment.Center,
        };
        Grid.SetColumn(badge, 2);
        header.Children.Add(badge);

        row.Children.Add(header);

        var summary = new TextBlock
        {
            Text = check.Summary,
            Style = PageStyle("PreflightRowBodyStyle"),
            TextWrapping = TextWrapping.Wrap,
        };
        row.Children.Add(summary);

        if (!string.IsNullOrWhiteSpace(check.Advice))
        {
            // 建议单独成块并前置"建议："——用户扫一眼就知道哪一行需要自己动手
            row.Children.Add(new TextBlock
            {
                Text = "建议：" + check.Advice,
                Style = PageStyle("PreflightRowMetaStyle"),
                Foreground = (Microsoft.UI.Xaml.Media.Brush)Application.Current.Resources["SystemFillColorCautionBrush"],
                TextWrapping = TextWrapping.Wrap,
            });
        }

        if (!string.IsNullOrWhiteSpace(check.Detail))
        {
            row.Children.Add(new TextBlock
            {
                Text = check.Detail,
                Style = PageStyle("PreflightRowMetaTertiaryStyle"),
                TextWrapping = TextWrapping.Wrap,
                // 细节可能很长（候选清单），截断到可读范围；完整内容在运行日志里
                MaxLines = 8,
                TextTrimming = TextTrimming.CharacterEllipsis,
            });
        }

        return row;
    }

    /// <summary>结论对应的图标（与状态文字、颜色三者一致）。</summary>
    private static Symbol SymbolFor(string status) => status switch
    {
        PreflightStatusValues.Ok => Symbol.Accept,
        PreflightStatusValues.Fixed => Symbol.Repair,
        PreflightStatusValues.Skipped => Symbol.Help,
        _ => Symbol.Important,
    };

    /// <summary>结论对应的状态色。</summary>
    private Microsoft.UI.Xaml.Media.Brush BrushFor(string status) => status switch
    {
        PreflightStatusValues.Ok => Resource("SystemFillColorSuccessBrush"),
        PreflightStatusValues.Fixed => Resource("SystemFillColorSuccessBrush"),
        PreflightStatusValues.Skipped => Resource("TextFillColorTertiaryBrush"),
        _ => Resource("SystemFillColorCriticalBrush"),
    };

    /// <summary>结论对应的中文状态名（三通道里的"文字"那一通道）。</summary>
    private static string StatusLabel(string status) => status switch
    {
        PreflightStatusValues.Ok => "正常",
        PreflightStatusValues.Fixed => "已自动修复",
        PreflightStatusValues.Missing => "缺失",
        PreflightStatusValues.Failed => "失败",
        PreflightStatusValues.Skipped => "未检查",
        _ => status,
    };

    private static string BadgeStyleKey(string status) => status switch
    {
        PreflightStatusValues.Ok => "PreflightBadgeOkStyle",
        PreflightStatusValues.Fixed => "PreflightBadgeOkStyle",
        PreflightStatusValues.Skipped => "PreflightRowMetaTertiaryStyle",
        _ => "PreflightBadgeBadStyle",
    };

    private Microsoft.UI.Xaml.Media.Brush Resource(string key)
        => (Microsoft.UI.Xaml.Media.Brush)Application.Current.Resources[key];

    private Style? PageStyle(string key) => Resources.TryGetValue(key, out var value) ? value as Style : null;
}

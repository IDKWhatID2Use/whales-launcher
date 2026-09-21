using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Navigation;
using WhalesLauncher.Models;
using WhalesLauncher.Services;
using Windows.System;

namespace WhalesLauncher.Views;

/// <summary>
/// P8 全局设置 —— 视觉规范 §9.9。
///
/// 保存策略：**即时保存**（规范 §9.9「设置项保存 → 每项独立保存」）。
/// 开关/单选项改动即写；文本类在失焦或按 Enter 时写 —— 逐击键写盘既产生大量 IO，
/// 又会把半截路径当成非法绝对路径（用户刚敲到 "C:\Us" 就被判错）。页面上明确写出了这条
/// 策略，避免用户去找一个不存在的「保存」按钮。
///
/// 契约缺口（规范 §11 的 U18）：<c>LauncherConfig.theme</c> 只有 dark / light，没有 system。
/// 本页只提供两项并显式说明"不跟随系统"，不使用 <see cref="ElementTheme.Default"/> 冒充浅色。
/// </summary>
public sealed partial class SettingsPage : Page
{
    private bool _ready;

    /// <summary>把配置灌进控件时会触发控件的变更事件，用它屏蔽回环写入。</summary>
    private bool _applying;

    private bool _probing;

    private NodeRuntimeReport? _report;

    public SettingsPage()
    {
        InitializeComponent();
        _ready = true;
    }

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        base.OnNavigatedTo(e);

        // 外壳的主题按钮（或其它页面）改了配置时，本页要跟着回到真实状态
        AppServices.State.ConfigChanged += OnConfigChanged;
        _ = InitializeAsync();
    }

    protected override void OnNavigatedFrom(NavigationEventArgs e)
    {
        // 约定 §8：离开页面必须解绑，否则 AppState 会长期持有本页实例
        AppServices.State.ConfigChanged -= OnConfigChanged;
        base.OnNavigatedFrom(e);
    }

    private async Task InitializeAsync()
    {
        try
        {
            if (AppServices.State.Config is null)
            {
                var loaded = await AppServices.State.LoadConfigAsync();
                if (!loaded.Ok)
                {
                    ShowStatus(InfoBarSeverity.Error, "无法读取启动器配置", loaded.Error ?? "后端未返回原因。");
                }
            }

            if (AppServices.State.Config is not null)
            {
                ApplyConfigToUi(AppServices.State.Config);
            }
            else
            {
                // 拿不到配置不能让页面看起来"是空的"：明确禁用可写控件，避免用户改了却没人接
                SetWritableEnabled(false);
                RootDirBox.Text = "（尚未取得配置）";
            }

            var version = AppServices.State.AppVersion;
            VersionText.Text = version.Length == 0 ? string.Empty : $"启动器版本 {version}";
            VersionText.Visibility = version.Length == 0 ? Visibility.Collapsed : Visibility.Visible;

            await DetectNodeAsync(refresh: false);
        }
        catch (Exception ex)
        {
            ShowStatus(InfoBarSeverity.Error, "全局设置初始化失败", ex.Message);
        }
    }

    private void OnConfigChanged(object? sender, EventArgs e)
    {
        if (AppServices.State.Config is not null)
        {
            ApplyConfigToUi(AppServices.State.Config);
        }
    }

    // ==================================================================
    // 配置 → 界面
    // ==================================================================

    private void ApplyConfigToUi(LauncherConfig config)
    {
        _applying = true;
        try
        {
            ThemeRadios.SelectedIndex = config.Theme == ThemeValues.Light ? 1 : 0;

            // 正在输入的输入框不要覆盖：否则用户打字打到一半会被保存结果"弹回去"，光标丢失
            if (PrimaryHomeBox.FocusState == FocusState.Unfocused)
            {
                PrimaryHomeBox.Text = config.PrimaryHome ?? string.Empty;
            }

            RootDirBox.Text = string.IsNullOrEmpty(config.RootDir) ? "（后端未提供）" : config.RootDir;

            if (RegistryBox.FocusState == FocusState.Unfocused)
            {
                RegistryBox.Text = config.EngineRegistry ?? string.Empty;
            }

            if (NodePathBox.FocusState == FocusState.Unfocused)
            {
                NodePathBox.Text = config.NodePath ?? string.Empty;
            }

            ConfirmDeleteSwitch.IsOn = config.ConfirmOnDelete;
        }
        finally
        {
            _applying = false;
        }

        ApplyThemeToWindow(config.Theme);
    }

    private void SetWritableEnabled(bool enabled)
    {
        ThemeRadios.IsEnabled = enabled;
        PrimaryHomeBox.IsEnabled = enabled;
        RegistryBox.IsEnabled = enabled;
        NodePathBox.IsEnabled = enabled;
        ConfirmDeleteSwitch.IsEnabled = enabled;
    }

    /// <summary>
    /// 把主题落到窗口根元素的 RequestedTheme 上。
    ///
    /// 为什么不逐页设置：RequestedTheme 作用于整棵可视树（标题栏、左栏、内容区一起变），
    /// 这才是"全局主题"的语义。⚠️ 规范 §9.9 把主题项归属本页，但更合适的做法是由外壳持有
    /// 一个 ThemeService —— <c>Services/</c> 下目前还没有它，且不在本页写范围内，
    /// 因此暂由本页承担，已在交付说明里登记。
    /// </summary>
    private static void ApplyThemeToWindow(string theme)
    {
        if (App.MainWindow?.Content is FrameworkElement root)
        {
            root.RequestedTheme = theme == ThemeValues.Light ? ElementTheme.Light : ElementTheme.Dark;
        }
    }

    // ==================================================================
    // 保存
    // ==================================================================

    /// <summary>
    /// 提交一个配置补丁。
    ///
    /// 用 <see cref="Dictionary{TKey,TValue}"/> 而不是匿名对象有两个原因（见 CoreBridge 对 JsonOut 的说明）：
    /// 1. 字典键不会被命名策略改写，键名就是契约里的 camelCase 字面值；
    /// 2. 需要**显式传 null**（把 nodePath 重置为自动探测）时，字典项里的 null 会原样落成 JSON null；
    ///    而**属性**的 null 会被整体丢弃 —— 那会变成"什么都没改"，重置静默失效。
    /// </summary>
    private async Task<bool> SavePatchAsync(Dictionary<string, object?> patch, string successMessage)
    {
        try
        {
            var result = await AppServices.State.SaveConfigAsync(patch);

            if (!result.Ok)
            {
                ShowStatus(InfoBarSeverity.Error, "保存设置失败", result.Error ?? "后端未返回原因。");
                AppServices.Toast.Error("保存设置失败", result.Error);

                // 回滚界面到后端的真实状态：绝不把没生效的值留在控件上
                if (AppServices.State.Config is not null)
                {
                    ApplyConfigToUi(AppServices.State.Config);
                }

                return false;
            }

            if (successMessage.Length > 0)
            {
                AppServices.Toast.Success(successMessage);
            }

            return true;
        }
        catch (Exception ex)
        {
            ShowStatus(InfoBarSeverity.Error, "保存设置失败", ex.Message);
            AppServices.Toast.Error("保存设置失败", ex.Message);
            return false;
        }
    }

    private async void OnThemeSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!_ready || _applying)
        {
            return;
        }

        var theme = ThemeRadios.SelectedIndex == 1 ? ThemeValues.Light : ThemeValues.Dark;
        if (string.Equals(theme, AppServices.State.Config?.Theme, StringComparison.Ordinal))
        {
            return;
        }

        // 先上屏再落盘：主题切换要立刻可见；失败时 SavePatchAsync 会把界面回滚
        ApplyThemeToWindow(theme);
        await SavePatchAsync(new Dictionary<string, object?> { ["theme"] = theme }, "主题已保存");
    }

    private async void OnConfirmDeleteToggled(object sender, RoutedEventArgs e)
    {
        if (!_ready || _applying)
        {
            return;
        }

        var isOn = ConfirmDeleteSwitch.IsOn;
        if (isOn == (AppServices.State.Config?.ConfirmOnDelete ?? true))
        {
            return;
        }

        await SavePatchAsync(
            new Dictionary<string, object?> { ["confirmOnDelete"] = isOn },
            isOn ? "已开启删除前二次确认" : "已关闭删除前二次确认");
    }

    private void OnPrimaryHomeLostFocus(object sender, RoutedEventArgs e)
    {
        if (_ready && !_applying)
        {
            _ = SavePrimaryHomeAsync();
        }
    }

    private void OnRegistryLostFocus(object sender, RoutedEventArgs e)
    {
        if (_ready && !_applying)
        {
            _ = SaveRegistryAsync();
        }
    }

    private void OnNodePathLostFocus(object sender, RoutedEventArgs e)
    {
        if (_ready && !_applying)
        {
            _ = SaveNodePathAsync();
        }
    }

    private async Task SavePrimaryHomeAsync()
    {
        var value = PrimaryHomeBox.Text.Trim();
        if (string.Equals(value, AppServices.State.Config?.PrimaryHome ?? string.Empty, StringComparison.Ordinal))
        {
            return;
        }

        if (value.Length == 0)
        {
            ShowStatus(InfoBarSeverity.Warning, "主 home 不能为空", "它会作为「继承主 home」凭证策略的源目录。");
            return;
        }

        // 后端用 path.isAbsolute 校验；IsPathFullyQualified 与它语义一致（"\x" 这种根相对路径不算绝对）
        if (!Path.IsPathFullyQualified(value))
        {
            ShowStatus(InfoBarSeverity.Warning, "主 home 必须是绝对路径", $"收到：{value}");
            return;
        }

        try
        {
            // 规范 §9.9「主 home 路径变更」：它影响所有「继承主 home」的实例，保存前必须说明影响面
            var confirmed = await AppServices.Dialogs.ConfirmAsync(
                "更改主 home？",
                "所有把凭证策略设为「继承主 home」的实例都会改为读写新目录下的凭证，已登录状态可能失效。",
                "更改",
                "取消");
            if (!confirmed)
            {
                // 用户反悔：把输入框恢复成后端里的真实值，不留一个"看起来改了其实没改"的状态
                PrimaryHomeBox.Text = AppServices.State.Config?.PrimaryHome ?? string.Empty;
                return;
            }
        }
        catch (Exception ex)
        {
            AppServices.Toast.Warning("无法弹出确认对话框", ex.Message);
            return;
        }

        await SavePatchAsync(new Dictionary<string, object?> { ["primaryHome"] = value }, "主 home 已保存");
    }

    private Task SaveRegistryAsync()
    {
        var value = RegistryBox.Text.Trim();
        if (string.Equals(value, AppServices.State.Config?.EngineRegistry ?? string.Empty, StringComparison.Ordinal))
        {
            return Task.CompletedTask;
        }

        if (value.Length == 0)
        {
            ShowStatus(InfoBarSeverity.Warning, "npm registry 不能为空", "引擎版本的查询与安装都要用它。");
            return Task.CompletedTask;
        }

        return SavePatchAsync(new Dictionary<string, object?> { ["engineRegistry"] = value }, "npm registry 已保存");
    }

    private async Task SaveNodePathAsync()
    {
        var value = NodePathBox.Text.Trim();
        var current = AppServices.State.Config?.NodePath ?? string.Empty;
        if (string.Equals(value, current, StringComparison.Ordinal))
        {
            return;
        }

        if (value.Length > 0 && !Path.IsPathFullyQualified(value))
        {
            ShowStatus(InfoBarSeverity.Warning, "Node 路径必须是绝对路径", $"收到：{value}。留空表示自动探测。");
            return;
        }

        // 留空 = 显式重置为自动探测。必须传 JSON null：属性和 null 会被外发策略整个丢掉，
        // 那会变成"什么都没改"，重置静默失效（由 Lead 实测确认，见简报 §5.5）。
        var patch = new Dictionary<string, object?> { ["nodePath"] = value.Length == 0 ? null : value };
        var saved = await SavePatchAsync(
            patch,
            value.Length == 0 ? "Node 路径已重置为自动探测" : "Node 路径已保存");

        if (saved)
        {
            // 后端在 nodePath 变化时会丢掉探测缓存（src/main/config.ts 的既有行为），
            // 所以这里立刻重探一次，让候选列表与新路径一致。
            await DetectNodeAsync(refresh: true);
        }
    }

    private void OnTextBoxKeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key != VirtualKey.Enter || sender is not TextBox box)
        {
            return;
        }

        // 单行输入框里的回车 = "输入结束"，走与失焦完全相同的保存路径
        e.Handled = true;

        if (ReferenceEquals(box, PrimaryHomeBox))
        {
            _ = SavePrimaryHomeAsync();
        }
        else if (ReferenceEquals(box, RegistryBox))
        {
            _ = SaveRegistryAsync();
        }
        else if (ReferenceEquals(box, NodePathBox))
        {
            _ = SaveNodePathAsync();
        }
    }

    // ==================================================================
    // Node 运行时探测
    // ==================================================================

    private void OnRedetectClick(object sender, RoutedEventArgs e) => _ = DetectNodeAsync(refresh: true);

    private async Task DetectNodeAsync(bool refresh)
    {
        if (_probing)
        {
            return;
        }

        SetProbing(true);

        try
        {
            var result = await AppServices.Bridge.CallAsync<NodeRuntimeReport>(Channels.LauncherDetectNode, refresh);

            if (!result.Ok || result.Value is null)
            {
                _report = null;
                RenderUnavailable(result.Error ?? "探测失败，且后端未返回原因。");
                ShowStatus(InfoBarSeverity.Error, "Node 运行时探测失败", result.Error ?? "后端未返回原因。");
                return;
            }

            _report = result.Value;
            RenderReport(_report);
        }
        catch (Exception ex)
        {
            _report = null;
            RenderUnavailable(ex.Message);
            ShowStatus(InfoBarSeverity.Error, "Node 运行时探测失败", ex.Message);
        }
        finally
        {
            SetProbing(false);
        }
    }

    private void SetProbing(bool probing)
    {
        _probing = probing;
        ProbeRing.IsActive = probing;
        ProbeRing.Visibility = probing ? Visibility.Visible : Visibility.Collapsed;
        RedetectButton.IsEnabled = !probing;

        // 规范 §9.9：探测期间候选表要禁用，避免用户对着上一次的结果做判断
        CandidateList.IsEnabled = !probing;
    }

    private void RenderUnavailable(string message)
    {
        NodeConclusionText.Text = message;
        NodeOkIcon.Visibility = Visibility.Collapsed;
        NodeFailIcon.Visibility = Visibility.Visible;
        NodeActiveFileText.Text = "—";
        NodeActiveVersionText.Text = "—";
        NodeActiveSourceText.Text = "—";
        NodeAdviceBar.IsOpen = true;

        CandidateList.Items.Clear();
        CandidateList.Visibility = Visibility.Collapsed;
        CandidateEmptyText.Visibility = Visibility.Visible;
    }

    private void RenderReport(NodeRuntimeReport report)
    {
        NodeConclusionText.Text = report.Message;

        // 成功/失败同时用图标 + 文案表达，不靠颜色单一通道（规范 §8.2）
        NodeOkIcon.Visibility = report.Ok ? Visibility.Visible : Visibility.Collapsed;
        NodeFailIcon.Visibility = report.Ok ? Visibility.Collapsed : Visibility.Visible;

        NodeActiveFileText.Text = string.IsNullOrEmpty(report.File) ? "—" : report.File;
        NodeActiveVersionText.Text = string.IsNullOrEmpty(report.Version) ? "—" : report.Version;
        NodeActiveSourceText.Text = SourceLabel(report.Source);

        // 失败时把"可操作建议"顶上：任务要求里明确的一条
        NodeAdviceBar.IsOpen = !report.Ok;

        CandidateList.Items.Clear();
        foreach (var candidate in report.Candidates)
        {
            CandidateList.Items.Add(BuildCandidateRow(candidate));
        }

        var hasCandidates = report.Candidates.Count > 0;
        CandidateList.Visibility = hasCandidates ? Visibility.Visible : Visibility.Collapsed;
        CandidateEmptyText.Visibility = hasCandidates ? Visibility.Collapsed : Visibility.Visible;
    }

    private UIElement BuildCandidateRow(NodeRuntimeCandidate candidate)
    {
        var activeFile = _report?.File;
        var isActive = !string.IsNullOrEmpty(activeFile)
            && string.Equals(candidate.File, activeFile, StringComparison.OrdinalIgnoreCase);

        var grid = new Grid { ColumnSpacing = 16 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(140) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(96) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        // 第 0 列：路径 + 不可用原因（原因来自后端实跑探针，不是按路径名猜的）
        var body = new StackPanel { Spacing = 4, VerticalAlignment = VerticalAlignment.Center };
        body.Children.Add(new TextBlock
        {
            Text = candidate.File,
            Style = PageStyle(candidate.Ok ? "SettingsRowMetaStyle" : "SettingsRowMetaTertiaryStyle"),
            TextWrapping = TextWrapping.Wrap,
        });

        if (!string.IsNullOrWhiteSpace(candidate.Reason))
        {
            body.Children.Add(new TextBlock
            {
                Text = candidate.Reason,
                Style = PageStyle("SettingsRowMetaTertiaryStyle"),
                TextWrapping = TextWrapping.Wrap,
            });
        }

        if (!string.IsNullOrEmpty(candidate.Electron))
        {
            // dsh 的原生模块按指纹白名单拒绝 Electron 运行时，这条是排障时最关键的一句
            body.Children.Add(new TextBlock
            {
                Text = $"宿主是 Electron {candidate.Electron}，dsh 的原生模块不接受这种运行时。",
                Style = PageStyle("SettingsRowMetaTertiaryStyle"),
                TextWrapping = TextWrapping.Wrap,
            });
        }

        Grid.SetColumn(body, 0);
        grid.Children.Add(body);

        var source = new TextBlock
        {
            Text = SourceLabel(candidate.Source),
            Style = PageStyle("SettingsRowMetaTertiaryStyle"),
            VerticalAlignment = VerticalAlignment.Center,
            TextWrapping = TextWrapping.Wrap,
        };
        Grid.SetColumn(source, 1);
        grid.Children.Add(source);

        var version = new TextBlock
        {
            Text = string.IsNullOrEmpty(candidate.Version) ? "—" : candidate.Version,
            Style = PageStyle("SettingsRowMetaTertiaryStyle"),
            VerticalAlignment = VerticalAlignment.Center,
        };
        Grid.SetColumn(version, 2);
        grid.Children.Add(version);

        var status = new TextBlock
        {
            Text = isActive ? "当前使用" : candidate.Ok ? "可用" : "不可用",
            Style = PageStyle(isActive ? "SettingsBadgeOkStyle" : candidate.Ok ? "SettingsRowMetaStyle" : "SettingsBadgeBadStyle"),
            VerticalAlignment = VerticalAlignment.Center,
        };
        Grid.SetColumn(status, 3);
        grid.Children.Add(status);

        return grid;
    }

    /// <summary>候选来源的中文名。顺序即解析优先级，与契约 NodeRuntimeSource 的注释一致。</summary>
    private static string SourceLabel(string? source) => source switch
    {
        NodeRuntimeSourceValues.Env => "环境变量 WHALES_NODE_PATH",
        NodeRuntimeSourceValues.Config => "全局设置 nodePath",
        NodeRuntimeSourceValues.Current => "启动器自身进程",
        NodeRuntimeSourceValues.Path => "系统 PATH",
        NodeRuntimeSourceValues.Common => "常见安装位置",
        _ => string.IsNullOrEmpty(source) ? "—" : source,
    };

    // ==================================================================
    // 小工具
    // ==================================================================

    private void ShowStatus(InfoBarSeverity severity, string title, string message)
    {
        StatusBar.Severity = severity;
        StatusBar.Title = title;
        StatusBar.Message = message;
        StatusBar.IsOpen = true;
    }

    private Style? PageStyle(string key) => Resources.TryGetValue(key, out var value) ? value as Style : null;
}

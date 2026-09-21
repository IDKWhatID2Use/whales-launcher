using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Navigation;
using WhalesLauncher.Models;
using WhalesLauncher.Services;

namespace WhalesLauncher.Views;

/// <summary>
/// P7 创建实例向导（4 步）—— 视觉规范 §9.8。
///
/// 步骤指示用 <see cref="SelectorBar"/> 而不是自制步骤条：规范 §11 的 U03 明确
/// 「官方无向导/Stepper 控件」，选定方案就是 SelectorBar + IsEnabled 控制可达性。
///
/// 校验模型：每一步一个纯函数 <see cref="IsStepValid"/>，第 N 步可达 ⇔ 第 0..N-1 步全部合法。
/// 这样"能否继续"只有一个事实源，不会出现按钮可点但内容不全的状态。
/// </summary>
public sealed partial class WizardPage : Page
{
    /// <summary>可选图标。顺序必须与 XAML 里 IconGrid 的项顺序一致（用 SelectedIndex 取值）。</summary>
    private static readonly string[] IconChoices =
    {
        "🐳", "🐋", "🌊", "🚀", "⚙️", "🧩",
        "📦", "🎯", "🔧", "🧪", "📚", "🛠️",
    };

    private readonly List<EngineInfo> _installedEngines = new();
    private string[] _availableVersions = Array.Empty<string>();

    private int _step;
    private string _selectedTemplate = BundleTemplates.Names[0];
    private string? _selectedEngineVersion;
    private bool _submitting;
    private bool _dirty;

    /// <summary>构造函数里 SelectedIndex/TextChanged 已会触发一次，此时控件树尚未全部就绪，先屏蔽。</summary>
    private bool _ready;

    /// <summary>程序化改写 SelectorBar.SelectedItem 时会再触发一次 SelectionChanged，用它防回环。</summary>
    private bool _syncingStepBar;

    public WizardPage()
    {
        InitializeComponent();

        BuildTemplateOptions();
        _ready = true;

        // 让 SelectorBar 的选中态、摘要卡、按钮可用性与初始状态一致
        SyncStepBar();
        GoToStep(0, moveFocus: false);
    }

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        base.OnNavigatedTo(e);

        // 用户可能先去 P6 装了引擎再回来，所以要跟随引擎列表变化重建步骤 2。
        AppServices.State.EnginesChanged += OnEnginesChanged;
        _ = InitializeAsync();
    }

    protected override void OnNavigatedFrom(NavigationEventArgs e)
    {
        // 约定 §8：离开页面必须解绑，否则 AppState 会长期持有本页实例。
        AppServices.State.EnginesChanged -= OnEnginesChanged;
        base.OnNavigatedFrom(e);
    }

    private async Task InitializeAsync()
    {
        try
        {
            await LoadInstalledEnginesAsync();
            await RefreshAvailableEnginesAsync();
        }
        catch (Exception ex)
        {
            // 初始化失败不能白屏：界面照常可用，用户至少在步骤 2 看到原因
            ShowStatus(InfoBarSeverity.Error, "无法加载引擎信息", ex.Message);
        }
    }

    private void OnEnginesChanged(object? sender, EventArgs e)
    {
        RebuildEngineLists();
        SyncStepBar();
    }

    // ==================================================================
    // 步骤机
    // ==================================================================

    private bool IsStepValid(int step) => step switch
    {
        0 => NameValidator.ValidateInstanceName(NameBox.Text) is null,
        1 => _selectedEngineVersion is not null && IsEngineInstalled(_selectedEngineVersion),
        2 => !string.IsNullOrEmpty(_selectedTemplate),
        _ => true,
    };

    /// <summary>当前可到达的最大步骤号：第 N 步可达 ⇔ 前面每一步都合法。</summary>
    private int MaxReachableStep()
    {
        var step = 0;
        while (step < 3 && IsStepValid(step))
        {
            step += 1;
        }

        return step;
    }

    private static SelectorBarItem? ItemOf(SelectorBar bar, int index) =>
        index >= 0 && index < bar.Items.Count ? bar.Items[index] : null;

    private int IndexOfStepItem(SelectorBarItem? item)
    {
        if (ReferenceEquals(item, Step1Item)) return 0;
        if (ReferenceEquals(item, Step2Item)) return 1;
        if (ReferenceEquals(item, Step3Item)) return 2;
        if (ReferenceEquals(item, Step4Item)) return 3;
        return -1;
    }

    private void SyncStepBar()
    {
        var max = MaxReachableStep();

        // 已经走到比较后面的步骤，但前面被改坏了（例如回来清空了名称）→ 退回到仍然可达的步骤
        if (_step > max)
        {
            GoToStep(max, moveFocus: false);
            return;
        }

        Step1Item.IsEnabled = true;
        Step2Item.IsEnabled = max >= 1;
        Step3Item.IsEnabled = max >= 2;
        Step4Item.IsEnabled = max >= 3;

        _syncingStepBar = true;
        StepBar.SelectedItem = ItemOf(StepBar, _step);
        _syncingStepBar = false;

        BackButton.IsEnabled = _step > 0 && !_submitting;
        CreateButton.IsEnabled = !_submitting;
    }

    private void GoToStep(int step, bool moveFocus = true)
    {
        _step = Math.Clamp(step, 0, 3);

        Panel1.Visibility = _step == 0 ? Visibility.Visible : Visibility.Collapsed;
        Panel2.Visibility = _step == 1 ? Visibility.Visible : Visibility.Collapsed;
        Panel3.Visibility = _step == 2 ? Visibility.Visible : Visibility.Collapsed;
        Panel4.Visibility = _step == 3 ? Visibility.Visible : Visibility.Collapsed;

        // SyncStepBar 里可能再次调用 GoToStep（收敛到 max），所以先做状态同步再摆控件可见性
        SyncStepBar();

        // 规范 §9.8：步骤 2 无可用引擎时要给 InfoBar Warning + 引导去引擎管理
        if (_step == 1 && _installedEngines.Count == 0)
        {
            ShowStatus(
                InfoBarSeverity.Warning,
                "没有可用的引擎版本",
                "本机还没有安装任何 dsh 引擎，请先到「引擎版本管理」安装一个版本，再回来创建实例。");
        }

        // 只有用户主动切换步骤才搬焦点；构造期与自动收敛不搬，避免和首屏焦点打架
        if (moveFocus && !_submitting)
        {
            FocusFirstInCurrentStep();
        }
    }

    private void FocusFirstInCurrentStep()
    {
        _ = _step switch
        {
            0 => NameBox.Focus(FocusState.Programmatic),
            1 => InstalledEngineList.Focus(FocusState.Programmatic),
            2 => TemplateRadios.Focus(FocusState.Programmatic),
            _ => WorkspaceRadios.Focus(FocusState.Programmatic),
        };
    }

    private void OnStepSelectionChanged(SelectorBar sender, SelectorBarSelectionChangedEventArgs args)
    {
        if (!_ready || _syncingStepBar)
        {
            return;
        }

        var target = IndexOfStepItem(sender.SelectedItem);
        if (target < 0 || target == _step)
        {
            return;
        }

        // SelectorBarItem.IsEnabled 已经挡住了大部分越级点击，这里再兜一次底
        if (target > MaxReachableStep())
        {
            _syncingStepBar = true;
            StepBar.SelectedItem = ItemOf(StepBar, _step);
            _syncingStepBar = false;
            ShowStepHint(target);
            return;
        }

        GoToStep(target);
    }

    private void ShowStepHint(int target)
    {
        // 指出到底卡在哪一步，而不是笼统说"请先完成前面的步骤"
        var blocker = 0;
        while (blocker < target && IsStepValid(blocker))
        {
            blocker += 1;
        }

        ShowStatus(InfoBarSeverity.Warning, $"还不能进入第 {target + 1} 步", ValidationMessage(blocker));
    }

    private static string ValidationMessage(int step) => step switch
    {
        0 => "请先填写合法的实例名称。",
        1 => "请先选择一个已安装的引擎版本；未安装的版本需要先去「引擎版本管理」安装。",
        2 => "请先选择一个 profile 模板。",
        _ => string.Empty,
    };

    private void NextStep()
    {
        if (_submitting)
        {
            return;
        }

        if (!IsStepValid(_step))
        {
            ShowStatus(InfoBarSeverity.Warning, "当前步骤还没填完", ValidationMessage(_step));
            return;
        }

        if (_step == 3)
        {
            _ = SubmitAsync();
            return;
        }

        StatusBar.IsOpen = false;
        GoToStep(_step + 1);
    }

    // ==================================================================
    // 步骤 1：名称与外观
    // ==================================================================

    private void OnNameChanged(object sender, TextChangedEventArgs e)
    {
        if (!_ready)
        {
            return;
        }

        var error = NameValidator.ValidateInstanceName(NameBox.Text);

        NameErrorText.Text = error ?? string.Empty;
        NameErrorText.Visibility = error is null ? Visibility.Collapsed : Visibility.Visible;

        // 目录名只是预览：真实目录名由 core 的 makeDirName 结合去重生成
        DirPreviewText.Text = NameBox.Text.Length == 0 ? "—" : NameValidator.PreviewDirName(NameBox.Text);

        _dirty = true;
        SyncStepBar();
        UpdateSummary();
    }

    private void OnIconSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!_ready)
        {
            return;
        }

        _dirty = true;
        UpdateSummary();
    }

    private void OnColorSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!_ready)
        {
            return;
        }

        _dirty = true;
        UpdateSummary();
    }

    private void OnNoteChanged(object sender, TextChangedEventArgs e)
    {
        if (!_ready)
        {
            return;
        }

        _dirty = true;
        UpdateSummary();
    }

    // ==================================================================
    // 步骤 2：引擎版本
    // ==================================================================

    private async Task LoadInstalledEnginesAsync()
    {
        var result = await AppServices.State.RefreshEnginesAsync();
        if (!result.Ok)
        {
            ShowStatus(InfoBarSeverity.Warning, "无法读取本地引擎列表", result.Error ?? "后端未返回原因。");
        }

        RebuildEngineLists();
    }

    private async Task RefreshAvailableEnginesAsync()
    {
        SetAvailableBusy(true);

        try
        {
            // engine:available 走 npm view，慢且可能失败，所以只影响"未安装"这一块，不阻塞"已安装"。
            var result = await AppServices.Bridge.CallAsync<string[]>(Channels.EngineAvailable);
            if (result.Ok && result.Value is not null)
            {
                _availableVersions = result.Value;
                AvailableHintText.Text = result.Value.Length == 0
                    ? "registry 没有返回任何版本。"
                    : $"registry 返回 {result.Value.Length} 个版本。";
            }
            else
            {
                _availableVersions = Array.Empty<string>();
                AvailableHintText.Text = string.Empty;
                ShowStatus(InfoBarSeverity.Warning, "无法获取可安装版本", result.Error ?? "后端未返回原因。");
            }
        }
        finally
        {
            SetAvailableBusy(false);
            RebuildEngineLists();
        }
    }

    private void SetAvailableBusy(bool busy)
    {
        AvailableRing.IsActive = busy;
        AvailableRing.Visibility = busy ? Visibility.Visible : Visibility.Collapsed;
        RefreshAvailableButton.IsEnabled = !busy;
    }

    private void OnRefreshAvailableClick(object sender, RoutedEventArgs e) => _ = RefreshAvailableEnginesAsync();

    /// <summary>
    /// 去引擎管理。规范 §9.8 明确要求"离开向导前须确认丢失输入" —— 这条路径同样会丢输入，
    /// 所以要走与「取消」一致的确认，而不是直接导航。
    /// </summary>
    private void OnGoEnginesClick(object sender, RoutedEventArgs e) => _ = GoEnginesAsync();

    private async Task GoEnginesAsync()
    {
        if (_submitting)
        {
            return;
        }

        try
        {
            if (_dirty)
            {
                var confirmed = await AppServices.Dialogs.ConfirmAsync(
                    "离开向导？",
                    "当前填写的内容不会被保存。引擎装好后可以从「新建实例」重新开始。",
                    "离开",
                    "留在这里");
                if (!confirmed)
                {
                    return;
                }
            }

            _dirty = false;
            AppServices.Navigation.Navigate(RouteKeys.Engines);
        }
        catch (Exception ex)
        {
            AppServices.Toast.Warning("无法跳转到引擎版本管理", ex.Message);
        }
    }

    private void RebuildEngineLists()
    {
        var previous = _selectedEngineVersion;

        _installedEngines.Clear();
        foreach (var engine in AppServices.State.Engines)
        {
            if (engine.Installed)
            {
                _installedEngines.Add(engine);
            }
        }

        InstalledEngineList.Items.Clear();
        foreach (var engine in _installedEngines)
        {
            InstalledEngineList.Items.Add(BuildInstalledEngineRow(engine));
        }

        InstalledEmptyText.Visibility = _installedEngines.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        InstalledEngineList.Visibility = _installedEngines.Count == 0 ? Visibility.Collapsed : Visibility.Visible;

        // 未安装 = registry 里有、但本地没有的版本
        var installedVersions = new HashSet<string>(StringComparer.Ordinal);
        foreach (var engine in _installedEngines)
        {
            installedVersions.Add(engine.Version);
        }

        var pending = new List<string>();
        foreach (var version in _availableVersions)
        {
            if (!installedVersions.Contains(version))
            {
                pending.Add(version);
            }
        }

        AvailableEngineList.Items.Clear();
        foreach (var version in pending)
        {
            AvailableEngineList.Items.Add(BuildPendingEngineRow(version));
        }

        AvailableEmptyText.Visibility = pending.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        AvailableEngineList.Visibility = pending.Count == 0 ? Visibility.Collapsed : Visibility.Visible;

        // 保持用户的选择；原选择已消失则自动落到第一个可用版本
        var keep = previous is not null && IsEngineInstalled(previous);
        if (keep)
        {
            var index = IndexOfInstalled(previous!);
            InstalledEngineList.SelectedIndex = index >= 0 ? index : 0;
        }
        else
        {
            InstalledEngineList.SelectedIndex = _installedEngines.Count > 0 ? 0 : -1;
        }

        // SelectedIndex 变化会在 _ready 时驱动 OnInstalledEngineSelectionChanged；为 null 时手动同步一次
        if (InstalledEngineList.SelectedIndex < 0)
        {
            _selectedEngineVersion = null;
        }

        SyncStepBar();
        UpdateSummary();
    }

    private bool IsEngineInstalled(string version)
    {
        foreach (var engine in _installedEngines)
        {
            if (string.Equals(engine.Version, version, StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }

    private int IndexOfInstalled(string version)
    {
        for (var i = 0; i < _installedEngines.Count; i += 1)
        {
            if (string.Equals(_installedEngines[i].Version, version, StringComparison.Ordinal))
            {
                return i;
            }
        }

        return -1;
    }

    private void OnInstalledEngineSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!_ready)
        {
            return;
        }

        var index = InstalledEngineList.SelectedIndex;
        _selectedEngineVersion = index >= 0 && index < _installedEngines.Count
            ? _installedEngines[index].Version
            : null;

        _dirty = true;
        SyncStepBar();
        UpdateSummary();
    }

    private UIElement BuildInstalledEngineRow(EngineInfo engine)
    {
        var text = new StackPanel { Spacing = 4, VerticalAlignment = VerticalAlignment.Center };
        text.Children.Add(new TextBlock
        {
            Text = engine.Version,
            Style = PageStyle("WizardRowTitleStyle"),
        });

        // 被占用信息很关键：用户选了一个别的实例正在用的版本并不会立刻失败，
        // 但后续排查问题时这条信息是第一手线索。
        var usage = engine.UsedBy.Count == 0 ? "未被占用" : $"被 {engine.UsedBy.Count} 个实例占用";
        text.Children.Add(new TextBlock
        {
            Text = $"{usage} · 体积 {Formatters.FormatEngineSize(engine.SizeBytes)}",
            Style = PageStyle("WizardRowMetaTertiaryStyle"),
            TextWrapping = TextWrapping.Wrap,
        });

        return text;
    }

    private UIElement BuildPendingEngineRow(string version)
    {
        var grid = new Grid { ColumnSpacing = 16 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        var text = new StackPanel { Spacing = 4, VerticalAlignment = VerticalAlignment.Center };
        text.Children.Add(new TextBlock
        {
            Text = version,
            Style = PageStyle("WizardRowMetaTertiaryStyle"),
        });
        text.Children.Add(new TextBlock
        {
            Text = "本地尚未安装，需要先去「引擎版本管理」安装后才能选用。",
            Style = PageStyle("WizardRowMetaTertiaryStyle"),
            TextWrapping = TextWrapping.Wrap,
        });
        Grid.SetColumn(text, 0);
        grid.Children.Add(text);

        var badge = new TextBlock
        {
            Text = "需先安装",
            Style = PageStyle("WizardRowMetaStyle"),
            VerticalAlignment = VerticalAlignment.Center,
        };
        Grid.SetColumn(badge, 1);
        grid.Children.Add(badge);

        return grid;
    }

    // ==================================================================
    // 步骤 3：profile 模板
    // ==================================================================

    private void BuildTemplateOptions()
    {
        TemplateRadios.Items.Clear();
        foreach (var name in BundleTemplates.Names)
        {
            TemplateRadios.Items.Add(BuildTemplateOption(name));
        }

        TemplateRadios.SelectedIndex = 0;
        _selectedTemplate = BundleTemplates.Names[0];
    }

    private UIElement BuildTemplateOption(string name)
    {
        var stack = new StackPanel { Spacing = 4 };
        stack.Children.Add(new TextBlock
        {
            Text = name,
            Style = PageStyle("WizardRowTitleStyle"),
        });
        stack.Children.Add(new TextBlock
        {
            Text = DescribeTemplate(name),
            Style = PageStyle("WizardRowBodyStyle"),
            TextWrapping = TextWrapping.Wrap,
        });

        // 组合包清单来自契约 BUNDLE_TEMPLATES 的 C# 镜像，界面不维护第二份
        var bundles = BundleTemplates.BundlesOf(name);
        stack.Children.Add(new TextBlock
        {
            Text = bundles.Length == 0 ? "组合包：—" : "组合包：" + string.Join("、", bundles),
            Style = PageStyle("WizardRowMetaTertiaryStyle"),
            TextWrapping = TextWrapping.Wrap,
        });

        return stack;
    }

    /// <summary>
    /// 模板的一句话说明。dsh 的模板名是自描述的英文单词，这里补的是中文使用场景，
    /// 属于界面文案（⚠️ 无官方出处），不含任何会影响创建结果的语义。
    /// </summary>
    private static string DescribeTemplate(string name) => name switch
    {
        "web" => "带 Web 界面；启动后可在浏览器里操作。",
        "headless" => "无界面；只提供命令行与 API。",
        "sdk" => "用于二次开发的 SDK 组合包。",
        "sdk-minimal" => "最小 SDK；只装 sdk 本体。",
        "acp" => "接入 ACP 协议的应用组合包。",
        _ => "（无说明）",
    };

    private void OnTemplateSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!_ready)
        {
            return;
        }

        var index = TemplateRadios.SelectedIndex;
        if (index >= 0 && index < BundleTemplates.Names.Length)
        {
            _selectedTemplate = BundleTemplates.Names[index];
        }

        _dirty = true;
        SyncStepBar();
        UpdateSummary();
    }

    // ==================================================================
    // 步骤 4：隔离策略
    // ==================================================================

    private void OnIsolationChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!_ready)
        {
            return;
        }

        _dirty = true;
        UpdateSummary();
    }

    /// <summary>RadioButtons 的 0/1 选项 → 契约字符串。0 恒为 <see cref="ShareModeValues.All"/>[0]。</summary>
    private static string ShareModeOf(RadioButtons radios) =>
        radios.SelectedIndex == 1 ? ShareModeValues.Shared : ShareModeValues.Local;

    private string WorkspaceMode => ShareModeOf(WorkspaceRadios);
    private string SavesMode => ShareModeOf(SavesRadios);
    private string SettingsMode => ShareModeOf(SettingsRadios);

    private string CredentialsMode =>
        CredentialsRadios.SelectedIndex == 1 ? CredentialsModeValues.Local : CredentialsModeValues.Inherit;

    private static string DescribeShareMode(string mode) =>
        mode == ShareModeValues.Shared ? "共享" : "独立";

    private static string DescribeCredentials(string mode) =>
        mode == CredentialsModeValues.Local ? "本实例独立" : "继承主 home";

    // ==================================================================
    // 摘要卡
    // ==================================================================

    private void UpdateSummary()
    {
        var name = NameBox.Text.Trim();
        SummaryNameText.Text = name.Length == 0 ? "（未填写）" : name;
        SummaryDirText.Text = name.Length == 0 ? "—" : NameValidator.PreviewDirName(name);

        SummaryIconText.Text = CurrentIcon();
        SummaryAvatar.Background = CurrentSwatch().Background;

        SummaryEngineText.Text = _selectedEngineVersion ?? "（未选择）";
        SummaryTemplateText.Text = _selectedTemplate;
        SummaryWorkspaceText.Text = DescribeShareMode(WorkspaceMode);
        SummarySavesText.Text = DescribeShareMode(SavesMode);
        SummarySettingsText.Text = DescribeShareMode(SettingsMode);
        SummaryCredentialsText.Text = DescribeCredentials(CredentialsMode);

        var note = NoteBox.Text.Trim();
        SummaryNoteText.Text = note.Length == 0 ? "—" : note;
    }

    private string CurrentIcon()
    {
        var index = IconGrid.SelectedIndex;
        return index >= 0 && index < IconChoices.Length ? IconChoices[index] : IconChoices[0];
    }

    private Border CurrentSwatch()
    {
        var index = ColorGrid.SelectedIndex;
        return index switch
        {
            1 => SwatchSuccess,
            2 => SwatchCaution,
            3 => SwatchCritical,
            4 => SwatchAttention,
            5 => SwatchNeutral,
            _ => SwatchAccent,
        };
    }

    /// <summary>
    /// 把调色板取成契约要求的 <c>#RRGGBB</c>。
    ///
    /// 关键点：颜色**不是**写在源码里的常量，而是从 XAML 已经解析好的 <c>{ThemeResource}</c> 画刷上读回来的
    /// （规范 §1.3 白名单 + §11 U16：预设色板必须引用内置画刷键，不得自写 hex）。
    /// 代价是深浅色主题下同一个色板条目会解析出不同的 hex —— 这与"实例强调色"取系统内置色的语义一致，
    /// 已在向导 UI 上向用户说明。取不到画刷时返回 null，交给后端用默认色，绝不编一个颜色出来。
    /// </summary>
    private string? ReadPaletteHex()
    {
        return CurrentSwatch().Background is SolidColorBrush brush
            ? $"#{brush.Color.R:X2}{brush.Color.G:X2}{brush.Color.B:X2}"
            : null;
    }

    // ==================================================================
    // 提交 / 取消
    // ==================================================================

    private async Task SubmitAsync()
    {
        if (_submitting)
        {
            return;
        }

        // 逐级回退到第一个不合法的步骤，并指出原因（比只报"参数不合法"有用得多）
        for (var step = 0; step < 4; step += 1)
        {
            if (!IsStepValid(step))
            {
                GoToStep(step);
                ShowStatus(InfoBarSeverity.Warning, $"第 {step + 1} 步还没填完", ValidationMessage(step));
                return;
            }
        }

        var input = new CreateInstanceInput
        {
            Name = NameBox.Text.Trim(),
            Icon = CurrentIcon(),
            Color = ReadPaletteHex(),
            Note = NoteBox.Text.Trim().Length == 0 ? null : NoteBox.Text.Trim(),
            EngineVersion = _selectedEngineVersion!,
            Template = _selectedTemplate,
            Saves = SavesMode,
            Settings = SettingsMode,
            Workspace = WorkspaceMode,
            Credentials = CredentialsMode,
            // DirName / ProfileName 留空：目录名与 profile 名由 core 的 makeDirName 派生并去重，
            // 界面上的预览只是预览（契约注释明确"省略时由 core 派生"）。
            DirName = null,
            ProfileName = null,
        };

        SetSubmitting(true);

        try
        {
            var result = await AppServices.Bridge.CallAsync<InstanceSummary>(Channels.InstanceCreate, input);

            if (!result.Ok)
            {
                // 后端的中文文案直接呈现，用户要能复制原文（规范 §9.0 错误态）
                ShowStatus(InfoBarSeverity.Error, "创建实例失败", result.Error ?? "后端未返回原因。");
                AppServices.Toast.Error("创建实例失败", result.Error);
                return;
            }

            var created = result.Value;
            var label = created?.Meta?.Name ?? input.Name;

            _dirty = false;
            AppServices.Toast.Success($"实例「{label}」已创建");

            // 左栏与 P1 共用 AppState.Instances，刷新后新实例立刻可见
            await AppServices.State.RefreshInstancesAsync();
            AppServices.Navigation.Navigate(RouteKeys.Instances);
        }
        catch (Exception ex)
        {
            ShowStatus(InfoBarSeverity.Error, "创建实例失败", ex.Message);
            AppServices.Toast.Error("创建实例失败", ex.Message);
        }
        finally
        {
            SetSubmitting(false);
        }
    }

    private void SetSubmitting(bool submitting)
    {
        _submitting = submitting;

        SubmitProgressPanel.Visibility = submitting ? Visibility.Visible : Visibility.Collapsed;
        CancelButton.IsEnabled = !submitting;
        BackButton.IsEnabled = !submitting && _step > 0;
        CreateButton.IsEnabled = !submitting;
        StepBar.IsEnabled = !submitting;
    }

    private async Task CancelAsync()
    {
        if (_submitting)
        {
            return;
        }

        try
        {
            if (_dirty)
            {
                var confirmed = await AppServices.Dialogs.ConfirmAsync(
                    "放弃创建？",
                    "当前填写的内容不会被保存。",
                    "放弃",
                    "继续填写");
                if (!confirmed)
                {
                    return;
                }
            }

            _dirty = false;
            AppServices.Navigation.Navigate(RouteKeys.Instances);
        }
        catch (Exception ex)
        {
            // 同一窗口同时只能有一个 ContentDialog（官方限制）。若因竞态导致对话框打不开，
            // 这里不能把异常抛到 UI 线程之外 —— 直接退回列表并把原因告诉用户。
            AppServices.Toast.Warning("取消创建时出错了", ex.Message);
            _dirty = false;
            AppServices.Navigation.Navigate(RouteKeys.Instances);
        }
    }

    private void OnCreateClick(object sender, RoutedEventArgs e) => _ = SubmitAsync();

    private void OnBackClick(object sender, RoutedEventArgs e)
    {
        if (_step > 0)
        {
            StatusBar.IsOpen = false;
            GoToStep(_step - 1);
        }
    }

    private void OnCancelClick(object sender, RoutedEventArgs e) => _ = CancelAsync();

    // ==================================================================
    // 键盘（规范 §9.8：Ctrl+Enter 创建 / Alt+← 上一步 / Esc 取消；另加 Enter 下一步）
    // ==================================================================

    private void OnCancelAccelerator(KeyboardAccelerator sender, KeyboardAcceleratorInvokedEventArgs args)
    {
        args.Handled = true;
        _ = CancelAsync();
    }

    private void OnBackAccelerator(KeyboardAccelerator sender, KeyboardAcceleratorInvokedEventArgs args)
    {
        args.Handled = true;
        if (_step > 0)
        {
            StatusBar.IsOpen = false;
            GoToStep(_step - 1);
        }
    }

    private void OnCreateAccelerator(KeyboardAccelerator sender, KeyboardAcceleratorInvokedEventArgs args)
    {
        args.Handled = true;

        if (_step != 3)
        {
            ShowStatus(InfoBarSeverity.Informational, "还没到最后一步", "请在「4 隔离策略」这一步按 Ctrl+Enter 提交。");
            return;
        }

        _ = SubmitAsync();
    }

    private void OnEnterAccelerator(KeyboardAccelerator sender, KeyboardAcceleratorInvokedEventArgs args)
    {
        // 焦点在某类控件上时，Enter 属于该控件自己的语义（按钮点击、单选选中、多行框换行），
        // 放行给控件处理，否则一次回车会同时"按下按钮"和"进入下一步"。
        if (IsEnterOwnedByFocusedControl())
        {
            args.Handled = false;
            return;
        }

        args.Handled = true;
        NextStep();
    }

    private bool IsEnterOwnedByFocusedControl()
    {
        if (XamlRoot is null)
        {
            return false;
        }

        return FocusManager.GetFocusedElement(XamlRoot) switch
        {
            ButtonBase => true,          // 含 RadioButton / CheckBox / ToggleButton 等全部按钮族
            SelectorBarItem => true,
            TextBox { AcceptsReturn: true } => true,
            _ => false,
        };
    }

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

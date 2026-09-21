using System.Text.Json.Nodes;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using WhalesLauncher.Models;
using WhalesLauncher.Services;

namespace WhalesLauncher.Views.Detail;

/// <summary>隔离策略的一个二选一选项（<c>RadioButtons</c> 直接绑它，显示文本取 <see cref="ToString"/>）。</summary>
/// <param name="Label">显示文本（中文）。</param>
/// <param name="Value">写回契约的字面值。</param>
public sealed record IsolationOption(string Label, string Value)
{
    public override string ToString() => Label;
}

/// <summary>
/// P3 实例详情 · 设置（视觉规范 §9.4）。
///
/// 涉及三条容易做错、规范或实测点名的规则：
/// <list type="number">
///   <item><description>
///     <b>保存前不做"YAML 合法性"假保证</b>（§9.4）：只标红可判定问题，
///     由 <see cref="YamlLint"/> 产出提示，真正的校验留给后端 <c>profile.validateYaml</c>。
///   </description></item>
///   <item><description>
///     <b>共享冲突必须显式解决</b>（§9.4）：<c>InfoBar</c> 常驻 + <c>ActionButton</c>，
///     **禁止**默认替用户选一侧。
///   </description></item>
///   <item><description>
///     <b>显式置空必须传 <see cref="JsonObject"/></b>：C# 外发请求默认丢弃值为 <c>null</c> 的
///     可选字段（等价 TS <c>undefined</c>），因此清空 emoji / 颜色若用匿名对象会**静默失效**。
///   </description></item>
/// </list>
/// </summary>
public sealed partial class InstanceSettingsView : UserControl
{
    private static readonly IsolationOption[] ShareOptions =
    {
        new("独立（默认）", ShareModeValues.Local),
        new("共享", ShareModeValues.Shared),
    };

    private static readonly IsolationOption[] CredentialsOptions =
    {
        new("继承主 home（默认）", CredentialsModeValues.Inherit),
        new("本实例独立", CredentialsModeValues.Local),
    };

    private InstanceSummary? _instance;
    private LauncherConfig? _config;
    private ShareConflict[] _conflicts = Array.Empty<ShareConflict>();
    private bool _loading;
    private bool _suppressModeEvents;

    public InstanceSettingsView()
    {
        InitializeComponent();

        YamlEditor.DirtyChanged += OnEditorDirtyChanged;
        YamlEditor.SaveRequested += OnEditorSaveRequested;
    }

    /// <summary>编辑器是否把内容改成了未保存状态（外壳切页签前据此提示）。</summary>
    public bool HasUnsavedEdits => YamlEditor.IsDirty;

    /// <summary>当前实例 id；删除实例后为 <c>null</c>。</summary>
    public string? InstanceId => _instance?.Meta.Id;

    /// <summary>
    /// 面包屑点击：第 0 段「实例」回实例列表、第 1 段（实例名）回本实例的默认页签、
    /// 末段（当前页名）不跳转 —— 段位语义与理由见 <see cref="DetailBreadcrumb.OnItemClicked"/>。
    /// </summary>
    private void OnCrumbItemClicked(BreadcrumbBar sender, BreadcrumbBarItemClickedEventArgs args) =>
        DetailBreadcrumb.OnItemClicked(args, InstanceId);

    /* ------------------------------------------------------------------ *
     * 装载
     * ------------------------------------------------------------------ */

    /// <summary>
    /// 装载：并发 <c>settings:read</c> + <c>launcher:getConfig</c> + <c>settings:shareConflicts</c>
    /// （规范 §9.4 明确要求并发），期间显示编辑器骨架。
    /// </summary>
    public async Task LoadAsync(InstanceSummary instance)
    {
        _instance = instance;
        _loading = true;

        Crumb.ItemsSource = DetailBreadcrumb.For(
            instance.Meta.Name,
            DetailTabs.Label(DetailTabs.Settings));

        ShowSkeleton();

        var settingsTask = AppServices.Bridge.CallAsync<string>(Channels.SettingsRead, instance.Meta.Id);
        var configTask = AppServices.Bridge.CallAsync<LauncherConfig>(Channels.LauncherGetConfig);
        var conflictsTask = AppServices.Bridge.CallAsync<ShareConflict[]>(Channels.SettingsShareConflicts, instance.Meta.Id);

        var settingsResult = await settingsTask;
        var configResult = await configTask;
        var conflictsResult = await conflictsTask;

        _loading = false;

        // 编辑器：读失败 → 禁用编辑并给重试，**不得**显示空文档（规范 §9.4）
        if (settingsResult.Ok)
        {
            ShowEditor();
            YamlEditor.IsEditable = true;
            YamlEditor.SetDocument(settingsResult.Value);

            if (string.IsNullOrEmpty(settingsResult.Value))
            {
                // 空字符串既可能"文件不存在"也可能是真空文件；后端没有区分字段，
                // 因此文案按规范写成"保存时将新建"的中性说明（信息态，不是错误）
                ShowInfo(
                    InfoBarSeverity.Informational,
                    "settings.yaml 尚无内容",
                    "保存时会按当前编辑器内容新建该文件。");
            }
            else
            {
                InfoBarArea.IsOpen = false;
            }
        }
        else
        {
            ShowEditorFailed(settingsResult.Error ?? "未知错误");
        }

        if (!conflictsResult.Ok)
        {
            ShowError("无法读取共享冲突", conflictsResult.Error ?? "未知错误");
        }
        else
        {
            ApplyConflicts(conflictsResult.Value ?? Array.Empty<ShareConflict>());
        }

        _config = configResult.Ok ? configResult.Value : null;
        PopulateMetadata(instance);
        UpdateDirtyUi();
    }

    private void ShowSkeleton()
    {
        EditorSkeleton.Visibility = Visibility.Visible;
        YamlEditor.Visibility = Visibility.Collapsed;
        EditorFailed.Visibility = Visibility.Collapsed;
    }

    private void ShowEditor()
    {
        EditorSkeleton.Visibility = Visibility.Collapsed;
        YamlEditor.Visibility = Visibility.Visible;
        EditorFailed.Visibility = Visibility.Collapsed;
    }

    private void ShowEditorFailed(string error)
    {
        EditorSkeleton.Visibility = Visibility.Collapsed;
        YamlEditor.Visibility = Visibility.Collapsed;
        EditorFailed.Visibility = Visibility.Visible;
        EditorFailedText.Text = error;

        // 禁用而不仅是隐藏：用户不该以为"文件是空的"（规范 §9.4 明确要求）
        YamlEditor.IsEditable = false;
    }

    /* ------------------------------------------------------------------ *
     * 编辑器：脏标记与保存
     * ------------------------------------------------------------------ */

    private void OnEditorDirtyChanged(object? sender, EventArgs e) => UpdateDirtyUi();

    private void OnEditorSaveRequested(object? sender, EventArgs e) => _ = SaveSettingsAsync();

    private void UpdateDirtyUi()
    {
        DirtyText.Visibility = YamlEditor.IsDirty ? Visibility.Visible : Visibility.Collapsed;

        // 无更改时禁用保存：避免用户反复点"保存"却什么也没发生
        SaveButton.IsEnabled = YamlEditor.IsDirty;
    }

    private async Task SaveSettingsAsync()
    {
        if (_instance is null || _loading)
        {
            return;
        }

        var instanceId = _instance.Meta.Id;
        SaveButton.IsEnabled = false;

        var result = await AppServices.Bridge.CallAsync<BridgeVoid>(
            Channels.SettingsWrite,
            instanceId,
            YamlEditor.Text);

        if (!result.Ok)
        {
            ShowError("保存 settings.yaml 失败", result.Error ?? "未知错误");
            YamlEditor.KeepDirty();
            SaveButton.IsEnabled = true;
            return;
        }

        InfoBarArea.IsOpen = false;
        YamlEditor.MarkSaved();
        UpdateDirtyUi();
        AppServices.Toast.Success("settings.yaml 已保存");

        // 共享模式下写入可能重新触发冲突判定，保存后复查一次
        var conflicts = await AppServices.Bridge.CallAsync<ShareConflict[]>(Channels.SettingsShareConflicts, instanceId);
        if (conflicts.Ok)
        {
            ApplyConflicts(conflicts.Value ?? Array.Empty<ShareConflict>());
        }
    }

    private async void OnSaveClick(object sender, RoutedEventArgs e) => await SaveSettingsAsync();

    private async void OnReloadClick(object sender, RoutedEventArgs e)
    {
        if (_instance is null)
        {
            return;
        }

        // 脏时二次确认（规范 §9.4 布局骨架明确要求）
        if (YamlEditor.IsDirty)
        {
            var confirmed = await AppServices.Dialogs.ConfirmAsync(
                "重新载入 settings.yaml",
                "编辑器里有未保存的更改，重新载入会丢弃它们。",
                "丢弃并重新载入",
                "取消",
                destructive: true);

            if (!confirmed)
            {
                return;
            }
        }

        await LoadAsync(_instance);
    }

    private async void OnOpenSettingsFolderClick(object sender, RoutedEventArgs e)
    {
        if (_instance is null)
        {
            return;
        }

        var result = await AppServices.Bridge.CallAsync<BridgeVoid>(
            Channels.InstanceOpenFolder,
            _instance.Meta.Id,
            InstanceFolderValues.Root);

        if (!result.Ok)
        {
            AppServices.Toast.Error("无法打开实例目录", result.Error);
        }
    }

    /* ------------------------------------------------------------------ *
     * 共享冲突
     * ------------------------------------------------------------------ */

    private void ApplyConflicts(ShareConflict[] conflicts)
    {
        _conflicts = conflicts ?? Array.Empty<ShareConflict>();

        if (_conflicts.Length == 0)
        {
            ConflictBar.IsOpen = false;
            return;
        }

        // 常驻（IsClosable=False 已在 XAML 固定）：问题不解决就不该能关掉 ——
        // 否则会从"静默丢数据"变成"静默不生效"（契约 ShareConflict 注释的原话）
        ConflictBar.Title = $"{_conflicts.Length} 个共享冲突需要解决";
        ConflictBar.Message = _conflicts[0].Message;
        ConflictBar.IsOpen = true;
    }

    private async void OnResolveConflictClick(object sender, RoutedEventArgs e)
    {
        if (_instance is null || _conflicts.Length == 0)
        {
            return;
        }

        var dialog = AppServices.Dialogs.Create("解决共享冲突", string.Empty);

        var choices = new RadioButtons
        {
            ItemsSource = new[]
            {
                "使用本地内容（把本地推给共享）",
                "使用共享内容（用共享覆盖本地）",
            },
            SelectedIndex = -1,
        };

        var panel = new StackPanel { Spacing = 12 };
        panel.Children.Add(new TextBlock
        {
            Text = _conflicts[0].Message,
            TextWrapping = TextWrapping.Wrap,
        });
        panel.Children.Add(new TextBlock
        {
            Text = "core 目前保留的是本地那一份。请选择以哪一侧为准 —— 这会覆盖另一侧；core 在覆盖前会写备份。",
            TextWrapping = TextWrapping.Wrap,
        });
        panel.Children.Add(choices);

        dialog.Content = panel;
        dialog.PrimaryButtonText = "应用选择";
        dialog.CloseButtonText = "稍后再说";
        dialog.DefaultButton = ContentDialogButton.Close;

        var result = await dialog.ShowAsync();
        if (result != ContentDialogResult.Primary)
        {
            // 明确禁止默认替用户选一侧：没选就不做任何事
            return;
        }

        if (choices.SelectedIndex < 0)
        {
            AppServices.Toast.Warning("尚未选择解决方向", "请选择「使用本地内容」或「使用共享内容」后再应用。");
            return;
        }

        var resolution = choices.SelectedIndex == 0
            ? ShareConflictResolutionValues.UseLocal
            : ShareConflictResolutionValues.UseShared;

        var resolved = await AppServices.Bridge.CallAsync<BridgeVoid>(
            Channels.SettingsResolveShareConflict,
            _instance.Meta.Id,
            resolution);

        if (!resolved.Ok)
        {
            ShowError("解决共享冲突失败", resolved.Error ?? "未知错误");
            return;
        }

        AppServices.Toast.Success("共享冲突已解决");

        var conflicts = await AppServices.Bridge.CallAsync<ShareConflict[]>(
            Channels.SettingsShareConflicts,
            _instance.Meta.Id);

        ApplyConflicts(conflicts.Ok ? conflicts.Value ?? Array.Empty<ShareConflict>() : Array.Empty<ShareConflict>());

        // 解决后 settings.yaml 内容可能已被替换，重新载入编辑器
        var refreshed = await AppServices.Bridge.CallAsync<string>(Channels.SettingsRead, _instance.Meta.Id);
        if (refreshed.Ok)
        {
            YamlEditor.SetDocument(refreshed.Value);
            UpdateDirtyUi();
        }
    }

    /* ------------------------------------------------------------------ *
     * 隔离策略（4 维度）
     * ------------------------------------------------------------------ */

    private void PopulateMetadata(InstanceSummary instance)
    {
        var meta = instance.Meta;

        NameBox.Text = meta.Name;
        IconBox.Text = meta.Icon ?? string.Empty;
        ColorBox.Text = meta.Color;
        NoteBox.Text = meta.Note;

        DirNameText.Text = $"目录名（由 dsh 校验）：{meta.DirName} · profile：{meta.Profile.Name}";

        // 引擎版本下拉：优先用已装载的引擎列表；列表为空时至少保留当前绑定值
        var engines = new List<string>();
        foreach (var engine in AppServices.State.Engines)
        {
            if (engine.Installed && !engines.Contains(engine.Version))
            {
                engines.Add(engine.Version);
            }
        }

        if (!string.IsNullOrEmpty(meta.Engine.Version) && !engines.Contains(meta.Engine.Version))
        {
            engines.Insert(0, meta.Engine.Version);
        }

        EngineBox.ItemsSource = engines;
        EngineBox.SelectedItem = engines.Contains(meta.Engine.Version) ? meta.Engine.Version : null;

        AutoOpenSwitch.IsOn = meta.Launch.AutoOpenBrowser;
        AppArgsBox.Text = string.Join(' ', meta.Launch.AppArgs);

        // 隔离策略：先装选项再设选中，且期间抑制事件（否则装载阶段就会弹确认对话框）
        _suppressModeEvents = true;
        try
        {
            WorkspaceRadios.ItemsSource = ShareOptions;
            SavesRadios.ItemsSource = ShareOptions;
            SettingsRadios.ItemsSource = ShareOptions;
            CredentialsRadios.ItemsSource = CredentialsOptions;

            WorkspaceRadios.SelectedIndex = IndexOf(ShareOptions, meta.Workspace.Mode);
            SavesRadios.SelectedIndex = IndexOf(ShareOptions, meta.Saves.Mode);
            SettingsRadios.SelectedIndex = IndexOf(ShareOptions, meta.Settings.Mode);
            CredentialsRadios.SelectedIndex = IndexOf(CredentialsOptions, meta.Credentials.Mode);
        }
        finally
        {
            _suppressModeEvents = false;
        }

        LaunchPathsText.Text = _config is { } config
            ? $"主 home（凭证继承目标）：{config.PrimaryHome}\n本实例目录名：{meta.DirName}\n实际 DSH_HOME 与工作目录以启动结果为准，本页不臆测。"
            : $"本实例目录名：{meta.DirName}\n未能读取全局配置，凭证继承目标未知。";

        DeleteButton.IsEnabled = true;
    }

    private static int IndexOf(IsolationOption[] options, string? value)
    {
        if (value is null) return 0;

        for (var i = 0; i < options.Length; i++)
        {
            if (string.Equals(options[i].Value, value, StringComparison.Ordinal))
            {
                return i;
            }
        }

        return 0;
    }

    private void OnWorkspaceModeChanged(object sender, SelectionChangedEventArgs e)
        => _ = ChangeModeAsync(
            dimension: "工作区",
            currentValue: instance => instance.Meta.Workspace.Mode,
            radios: WorkspaceRadios,
            options: ShareOptions,
            confirmTitle: "切换工作区隔离",
            confirmMessage: "共享会把本实例的工作区通过 junction 指向共享目录，已有文件保留在原地，"
                + "之后写入的工作区文件对其它共享同一目录的实例可见。",
            field: "workspace");

    private void OnSavesModeChanged(object sender, SelectionChangedEventArgs e)
        => _ = ChangeModeAsync(
            dimension: "存档",
            currentValue: instance => instance.Meta.Saves.Mode,
            radios: SavesRadios,
            options: ShareOptions,
            confirmTitle: "切换存档隔离",
            confirmMessage: "共享会让多个实例读写同一份 sessions 目录，任一侧新增或删除存档都会对其它实例立刻生效。",
            field: "saves");

    private void OnSettingsModeChanged(object sender, SelectionChangedEventArgs e)
        => _ = ChangeModeAsync(
            dimension: "设置",
            currentValue: instance => instance.Meta.Settings.Mode,
            radios: SettingsRadios,
            options: ShareOptions,
            confirmTitle: "切换设置隔离",
            confirmMessage: "共享后 settings.yaml 指向共享文件。若本地与共享内容不一致，"
                + "core 会保留本地并登记一条共享冲突，需要你显式选择以哪一侧为准。",
            field: "settings");

    private void OnCredentialsModeChanged(object sender, SelectionChangedEventArgs e)
        => _ = ChangeModeAsync(
            dimension: "凭证",
            currentValue: instance => instance.Meta.Credentials.Mode,
            radios: CredentialsRadios,
            options: CredentialsOptions,
            confirmTitle: "切换凭证隔离",
            confirmMessage: "「继承主 home」复用全局凭证；「本实例独立」使用实例目录内的凭证，两者登录状态互不影响。",
            field: "credentials");

    /// <summary>
    /// 切换一个隔离维度。
    ///
    /// 按规范 §9.4：**先确认再改**（涉及目录搬运），取消则把选项回退到当前模式；
    /// 后端失败同样回退 —— 绝不让界面显示一个并未生效的值。
    /// </summary>
    private async Task ChangeModeAsync(
        string dimension,
        Func<InstanceSummary, string> currentValue,
        RadioButtons radios,
        IsolationOption[] options,
        string confirmTitle,
        string confirmMessage,
        string field)
    {
        if (_suppressModeEvents || _loading || _instance is null)
        {
            return;
        }

        if (radios.SelectedItem is not IsolationOption option)
        {
            return;
        }

        var instance = _instance;
        var current = currentValue(instance);
        if (string.Equals(option.Value, current, StringComparison.Ordinal))
        {
            return;
        }

        var confirmed = await AppServices.Dialogs.ConfirmAsync(
            confirmTitle,
            $"{confirmMessage}\n\n将把「{dimension}」从「{Label(options, current)}」改为「{option.Label}」。",
            "确认切换",
            "取消");

        if (!confirmed)
        {
            RevertSelection(radios, options, current);
            return;
        }

        // 用 JsonObject 而不是匿名对象：便于"只提交真正改动的字段"，也与 UpdateInstancePatch
        // 的注释一致（null 会被丢弃，必须显式表达）
        var patch = new JsonObject { [field] = option.Value };

        var result = await AppServices.Bridge.CallAsync<InstanceSummary>(
            Channels.InstanceUpdate,
            instance.Meta.Id,
            patch);

        if (!result.Ok)
        {
            RevertSelection(radios, options, current);
            ShowError($"切换{dimension}隔离失败", result.Error ?? "未知错误");
            return;
        }

        if (result.Value is not null)
        {
            _instance = result.Value;
        }

        InfoBarArea.IsOpen = false;
        AppServices.Toast.Success($"{dimension}隔离已改为「{option.Label}」");

        // 左栏与列表页也要跟上，否则详情页改了、列表页还显示旧值
        await AppServices.State.RefreshInstancesAsync();
    }

    private static string Label(IsolationOption[] options, string value)
    {
        foreach (var option in options)
        {
            if (string.Equals(option.Value, value, StringComparison.Ordinal))
            {
                return option.Label;
            }
        }

        return value;
    }

    private void RevertSelection(RadioButtons radios, IsolationOption[] options, string current)
    {
        _suppressModeEvents = true;
        try
        {
            radios.SelectedIndex = IndexOf(options, current);
        }
        finally
        {
            _suppressModeEvents = false;
        }
    }

    /* ------------------------------------------------------------------ *
     * 实例信息 / 启动设置
     * ------------------------------------------------------------------ */

    private async void OnSaveMetaClick(object sender, RoutedEventArgs e)
    {
        if (_instance is null)
        {
            return;
        }

        var name = NameBox.Text;
        var nameError = NameValidator.ValidateInstanceName(name);
        if (nameError is not null)
        {
            // 与 dsh 规则同一套校验（NameValidator 逐行移植自旧 names.ts）
            ShowError("实例名不合法", nameError);
            return;
        }

        var instance = _instance;
        var meta = instance.Meta;
        var patch = new JsonObject();

        if (!string.Equals(name, meta.Name, StringComparison.Ordinal))
        {
            patch["name"] = name;
        }

        var icon = (IconBox.Text ?? string.Empty).Trim();
        if (!string.Equals(icon, meta.Icon ?? string.Empty, StringComparison.Ordinal))
        {
            // 清空 emoji 必须传 JSON null：用匿名对象时字段会被丢弃 → **删不掉**（Lead 实测事实）
            patch["icon"] = icon.Length == 0 ? null : JsonValue.Create(icon);
        }

        var color = (ColorBox.Text ?? string.Empty).Trim();
        if (!string.Equals(color, meta.Color, StringComparison.Ordinal))
        {
            patch["color"] = color.Length == 0 ? null : JsonValue.Create(color);
        }

        var note = NoteBox.Text ?? string.Empty;
        if (!string.Equals(note, meta.Note, StringComparison.Ordinal))
        {
            patch["note"] = note;
        }

        if (EngineBox.SelectedItem is string engineVersion &&
            !string.Equals(engineVersion, meta.Engine.Version, StringComparison.Ordinal))
        {
            patch["engineVersion"] = engineVersion;
        }

        if (patch.Count == 0)
        {
            AppServices.Toast.Info("没有需要保存的改动");
            return;
        }

        SaveMetaButton.IsEnabled = false;
        var result = await AppServices.Bridge.CallAsync<InstanceSummary>(
            Channels.InstanceUpdate,
            instance.Meta.Id,
            patch);
        SaveMetaButton.IsEnabled = true;

        if (!result.Ok)
        {
            ShowError("保存实例信息失败", result.Error ?? "未知错误");
            return;
        }

        if (result.Value is not null)
        {
            _instance = result.Value;
            PopulateMetadata(result.Value);
        }

        InfoBarArea.IsOpen = false;
        AppServices.Toast.Success("实例信息已保存");
        await AppServices.State.RefreshInstancesAsync();
    }

    private async void OnAutoOpenToggled(object sender, RoutedEventArgs e)
    {
        if (_loading || _instance is null || sender is not ToggleSwitch toggle)
        {
            return;
        }

        var desired = toggle.IsOn;
        if (desired == _instance.Meta.Launch.AutoOpenBrowser)
        {
            return;
        }

        // 布尔量必须显式带 false：省略等于"不改动"，会把"关掉自动打开"变成静默无效
        var patch = new JsonObject { ["autoOpenBrowser"] = desired };

        var result = await AppServices.Bridge.CallAsync<InstanceSummary>(
            Channels.InstanceUpdate,
            _instance.Meta.Id,
            patch);

        if (!result.Ok)
        {
            toggle.IsOn = _instance.Meta.Launch.AutoOpenBrowser;
            ShowError("保存启动设置失败", result.Error ?? "未知错误");
            return;
        }

        if (result.Value is not null)
        {
            _instance = result.Value;
        }

        InfoBarArea.IsOpen = false;
        AppServices.Toast.Success(desired ? "已开启启动后自动打开界面" : "已关闭启动后自动打开界面");
        await AppServices.State.RefreshInstancesAsync();
    }

    private async void OnSaveLaunchClick(object sender, RoutedEventArgs e)
    {
        if (_instance is null)
        {
            return;
        }

        // 以空格切分参数：刻意不做引号解析 —— 那会与后端 argv 语义产生第二份实现。
        // 局限已在界面文案里如实说明。
        var raw = AppArgsBox.Text ?? string.Empty;
        var args = raw.Split(' ', StringSplitOptions.RemoveEmptyEntries);

        var array = new JsonArray();
        foreach (var arg in args)
        {
            array.Add(JsonValue.Create(arg));
        }

        var patch = new JsonObject { ["appArgs"] = array };

        var result = await AppServices.Bridge.CallAsync<InstanceSummary>(
            Channels.InstanceUpdate,
            _instance.Meta.Id,
            patch);

        if (!result.Ok)
        {
            ShowError("保存启动参数失败", result.Error ?? "未知错误");
            return;
        }

        if (result.Value is not null)
        {
            _instance = result.Value;
        }

        InfoBarArea.IsOpen = false;
        AppServices.Toast.Success(args.Length == 0 ? "已清空追加参数" : $"已保存 {args.Length} 个追加参数");
        await AppServices.State.RefreshInstancesAsync();
    }

    /* ------------------------------------------------------------------ *
     * 危险操作
     * ------------------------------------------------------------------ */

    private async void OnDeleteClick(object sender, RoutedEventArgs e)
    {
        if (_instance is null)
        {
            return;
        }

        var instance = _instance;

        // 依 LauncherConfig.confirmOnDelete 决定是否二次确认（规范 §9.4）
        var confirmOnDelete = AppServices.State.Config?.ConfirmOnDelete ?? true;
        var deleteFiles = false;

        if (confirmOnDelete)
        {
            var dialog = AppServices.Dialogs.Create("删除实例", string.Empty);

            var checkbox = new CheckBox
            {
                Content = "同时删除磁盘文件（不可恢复）",
                IsChecked = false,
            };

            var panel = new StackPanel { Spacing = 12 };
            panel.Children.Add(new TextBlock
            {
                Text = $"将从启动器移除实例「{instance.Meta.Name}」的记录。",
                TextWrapping = TextWrapping.Wrap,
            });
            panel.Children.Add(new TextBlock
            {
                Text = "勾选下面一项会连同实例目录下的存档、插件一起永久删除；不勾选只移除记录，磁盘文件保留。",
                TextWrapping = TextWrapping.Wrap,
            });
            panel.Children.Add(checkbox);

            dialog.Content = panel;
            dialog.PrimaryButtonText = "删除实例";
            dialog.CloseButtonText = "取消";
            dialog.DefaultButton = ContentDialogButton.Close;

            var confirm = await dialog.ShowAsync();
            if (confirm != ContentDialogResult.Primary)
            {
                return;
            }

            deleteFiles = checkbox.IsChecked == true;
        }

        var result = await AppServices.Bridge.CallAsync<BridgeVoid>(
            Channels.InstanceRemove,
            instance.Meta.Id,
            deleteFiles);

        if (!result.Ok)
        {
            ShowError("删除实例失败", result.Error ?? "未知错误");
            return;
        }

        AppServices.Toast.Success(deleteFiles
            ? $"已删除实例 {instance.Meta.Name}（含磁盘文件）"
            : $"已移除实例 {instance.Meta.Name}（磁盘文件保留）");

        // 记录已不存在：必须退回列表页，否则会停在一个指向空气的详情页上
        _instance = null;
        await AppServices.State.RefreshInstancesAsync();
        AppServices.Navigation.Navigate(RouteKeys.Instances);
    }

    /* ------------------------------------------------------------------ *
     * 外围
     * ------------------------------------------------------------------ */

    /// <summary>
    /// 外壳切页签前调用：有未保存更改时提示（规范 §9.4「共享冲突存在且用户未解决 → 页面离开时提示」）。
    /// 返回 <c>false</c> 表示用户选择留在此页。
    /// </summary>
    public async Task<bool> ConfirmLeaveAsync()
    {
        if (!YamlEditor.IsDirty)
        {
            return true;
        }

        return await AppServices.Dialogs.ConfirmAsync(
            "有未保存的更改",
            "settings.yaml 的修改尚未保存，离开这一页会丢失它们。",
            "放弃更改并离开",
            "留在此页",
            destructive: true);
    }

    private void ShowError(string title, string message) => ShowInfo(InfoBarSeverity.Error, title, message);

    private void ShowInfo(InfoBarSeverity severity, string title, string message)
    {
        InfoBarArea.Severity = severity;
        InfoBarArea.Title = title;
        InfoBarArea.Message = message;
        InfoBarArea.IsOpen = true;
    }

    /// <summary>本页不订阅推送事件（<c>settings:*</c> 全是请求-响应），保留方法仅为统一 4 个子视图的宿主调用面。</summary>
    public void Unload()
    {
    }
}

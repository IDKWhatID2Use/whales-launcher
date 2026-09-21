using System.Collections.ObjectModel;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using WhalesLauncher.Models;
using WhalesLauncher.Services;

namespace WhalesLauncher.Views.Detail;

/// <summary>
/// P2 实例详情 · 插件（视觉规范 §9.3）。
///
/// 三块：内置组合包（带启用开关）/ 本地插件（<c>home/plugins</c>）/ 依赖表。
///
/// 两个容易做错、规范点名的点：
/// <list type="number">
///   <item><description>
///     依赖表必须显示 <c>spec</c> **原文**（不是版本号）。契约 <c>contracts.ts:188-194</c> 说明：
///     用户靠它区分「随实例搬运的相对 <c>file:</c>」与「指向本机绝对路径的 <c>link:</c>」，
///     后者一搬到别的机器就失效 —— 所以 <c>link:</c> 行额外给「外部引用」徽标。
///   </description></item>
///   <item><description>
///     组合包开关是**乐观更新**：先改本地模型 → 调后端 → 失败回滚并把 <c>error</c> 弹 toast。
///   </description></item>
/// </list>
/// </summary>
public sealed partial class PluginsView : UserControl
{
    private string _instanceId = string.Empty;
    private bool _isReady;
    private bool _busy;

    public PluginsView()
    {
        InitializeComponent();

        BuildBlockBar();

        // 构造期 BuildBlockBar 会触发一次 SelectionChanged，此时命名元素尚未全部就绪；
        // 因此用 _isReady 把这个门关上，构造末尾再显式切到第一块。
        _isReady = true;
        ShowBlock(0);
    }

    /// <summary>绑定源：内置组合包。</summary>
    public ObservableCollection<BundleRow> Bundles { get; } = new();

    /// <summary>绑定源：本地插件。</summary>
    public ObservableCollection<LocalPluginRow> LocalPlugins { get; } = new();

    /// <summary>绑定源：依赖表。</summary>
    public ObservableCollection<PluginRow> Dependencies { get; } = new();

    /// <summary>装载：并发拉 <c>plugin:inventory</c> 与 <c>plugin:listLocal</c>（规范 §9.3「加载」）。</summary>
    public async Task LoadAsync(string instanceId, string instanceName)
    {
        _instanceId = instanceId;

        Crumb.ItemsSource = DetailBreadcrumb.For(instanceName, DetailTabs.Label(DetailTabs.Plugins));

        await RefreshAsync();
    }

    /// <summary>
    /// 面包屑点击：第 0 段「实例」回实例列表、第 1 段（实例名）回本实例的默认页签、
    /// 末段（当前页名）不跳转 —— 段位语义与理由见 <see cref="DetailBreadcrumb.OnItemClicked"/>。
    /// </summary>
    private void OnCrumbItemClicked(BreadcrumbBar sender, BreadcrumbBarItemClickedEventArgs args) =>
        DetailBreadcrumb.OnItemClicked(args, _instanceId);

    /// <summary>刷新三块数据。</summary>
    public async Task RefreshAsync()
    {
        SetBusy(true);

        // 并发发出：两个通道互不依赖，串行会让页面白等一个来回（规范 §9.3 明确要求并发）
        var inventoryTask = AppServices.Bridge.CallAsync<PluginInventory>(Channels.PluginInventory, _instanceId);
        var localTask = AppServices.Bridge.CallAsync<PluginSummary[]>(Channels.PluginListLocal, _instanceId);

        var inventoryResult = await inventoryTask;
        var localResult = await localTask;

        SetBusy(false);

        var local = localResult.Value ?? Array.Empty<PluginSummary>();

        if (!inventoryResult.Ok)
        {
            // 规范 §9.0：错误必须可见。这里保留已有数据不清空 —— 清空会让用户以为插件被删了
            ShowError("无法读取插件信息", inventoryResult.Error ?? "未知错误");
        }
        else
        {
            ErrorBar.IsOpen = false;
        }

        if (!localResult.Ok)
        {
            ShowError("无法读取本地插件", localResult.Error ?? "未知错误");
        }

        if (!inventoryResult.Ok || !localResult.Ok)
        {
            return;
        }

        ApplyInventory(inventoryResult.Value, local);
    }

    private void ApplyInventory(PluginInventory? inventory, IReadOnlyList<PluginSummary> local)
    {
        ReplaceAll(Bundles, (inventory?.Bundles ?? new List<BundleEntry>()).Select(entry => new BundleRow(entry)));
        ReplaceAll(Dependencies, (inventory?.Dependencies ?? new List<PluginEntry>()).Select(entry => new PluginRow(entry)));
        ReplaceAll(LocalPlugins, local.Select(summary => new LocalPluginRow(summary)));

        BundlesEmpty.Visibility = Bundles.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        BundlesList.Visibility = Bundles.Count == 0 ? Visibility.Collapsed : Visibility.Visible;
        LocalEmpty.Visibility = LocalPlugins.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        DepsEmpty.Visibility = Dependencies.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        DepsList.Visibility = Dependencies.Count == 0 ? Visibility.Collapsed : Visibility.Visible;

        UpdateWarning(inventory, local);
    }

    /// <summary>就地替换集合内容，保持 <c>ObservableCollection</c> 实例不变（绑定不会断）。</summary>
    private static void ReplaceAll<T>(ObservableCollection<T> target, IEnumerable<T> source)
    {
        target.Clear();
        foreach (var item in source)
        {
            target.Add(item);
        }
    }

    /// <summary>
    /// 更新页面级 Warning（规范 §9.3 Row1）：bundle patch 缺失、来源标记损坏、
    /// <c>installedByLauncher</c> 与自检结论不一致。
    /// </summary>
    private void UpdateWarning(PluginInventory? inventory, IReadOnlyList<PluginSummary> local)
    {
        var reasons = new List<string>();

        var notInstalled = (inventory?.Dependencies ?? new List<PluginEntry>()).Count(entry => !entry.Installed);
        if (notInstalled > 0)
        {
            reasons.Add($"{notInstalled} 个依赖未安装到 node_modules");
        }

        var unknownOrigin = local.Count(item =>
            string.IsNullOrEmpty(item.Origin) || item.Origin == PluginOriginValues.Unknown);
        if (unknownOrigin > 0)
        {
            reasons.Add($"{unknownOrigin} 个本地插件的来源标记损坏");
        }

        var missingPatch = local.Count(item => item.HasBundlePatch && !item.PatchFileExists);
        if (missingPatch > 0)
        {
            reasons.Add($"{missingPatch} 个插件的 bundle patch 文件缺失");
        }

        var ledgerMismatch = local.Count(item =>
            item.InstalledByLauncher == true && !item.Enabled && !item.HasBundlePatch);
        if (ledgerMismatch > 0)
        {
            reasons.Add($"{ledgerMismatch} 个插件的安装状态与自检结论不一致");
        }

        if (reasons.Count == 0)
        {
            WarnBar.IsOpen = false;
            return;
        }

        WarnBar.Title = "插件状态需要确认";
        WarnBar.Message = string.Join("；", reasons);
        WarnBar.IsOpen = true;
    }

    private void SetBusy(bool busy)
    {
        _busy = busy;
        LoadingBar.Visibility = busy ? Visibility.Visible : Visibility.Collapsed;
        InstallButton.IsEnabled = !busy;
        RefreshButton.IsEnabled = !busy;
    }

    /* ------------------------------------------------------------------ *
     * 三块切换
     * ------------------------------------------------------------------ */

    private void BuildBlockBar()
    {
        BlockBar.Items.Clear();
        BlockBar.Items.Add(new SelectorBarItem { Text = "内置组合包", Tag = 0, IsSelected = true });
        BlockBar.Items.Add(new SelectorBarItem { Text = "本地插件", Tag = 1 });
        BlockBar.Items.Add(new SelectorBarItem { Text = "依赖", Tag = 2 });
    }

    private void OnBlockChanged(SelectorBar sender, SelectorBarSelectionChangedEventArgs args)
    {
        if (sender.SelectedItem is SelectorBarItem { Tag: int index })
        {
            ShowBlock(index);
        }
    }

    private void ShowBlock(int index)
    {
        if (!_isReady)
        {
            return;
        }

        BundlesBlock.Visibility = index == 0 ? Visibility.Visible : Visibility.Collapsed;
        LocalBlock.Visibility = index == 1 ? Visibility.Visible : Visibility.Collapsed;
        DepsBlock.Visibility = index == 2 ? Visibility.Visible : Visibility.Collapsed;
    }

    /* ------------------------------------------------------------------ *
     * 块 A：组合包开关（乐观更新 + 失败回滚）
     * ------------------------------------------------------------------ */

    private async void OnBundleToggled(object sender, RoutedEventArgs e)
    {
        if (_busy || sender is not ToggleSwitch toggle || toggle.Tag is not string name)
        {
            return;
        }

        BundleRow? row = null;
        foreach (var candidate in Bundles)
        {
            if (string.Equals(candidate.Entry.Name, name, StringComparison.Ordinal))
            {
                row = candidate;
                break;
            }
        }

        if (row is null)
        {
            return;
        }

        var desired = toggle.IsOn;
        var previous = row.Enabled;
        if (desired == previous)
        {
            return;
        }

        // 乐观更新：先改本地投影（它同时写入模型并通知界面，避免"开关显示新值而模型还是旧值"）
        row.Enabled = desired;

        var result = await AppServices.Bridge.CallAsync<PluginInventory>(
            Channels.PluginSetBundleEnabled,
            _instanceId,
            name,
            desired);

        if (!result.Ok)
        {
            // 失败回滚：改回投影值，OneWay 绑定会把开关拨回去
            row.Enabled = previous;
            AppServices.Toast.Error($"无法{(desired ? "启用" : "停用")}组合包 {name}", result.Error);
            return;
        }

        if (result.Value is not null)
        {
            ApplyInventory(result.Value, CurrentLocalSummaries());
        }
    }

    /// <summary>从当前投影里取回 <c>PluginSummary</c>（重新应用库存时保持本地插件块不丢）。</summary>
    private IReadOnlyList<PluginSummary> CurrentLocalSummaries()
    {
        var list = new List<PluginSummary>(LocalPlugins.Count);
        foreach (var row in LocalPlugins)
        {
            list.Add(row.Summary);
        }

        return list;
    }

    /* ------------------------------------------------------------------ *
     * 块 B：本地插件
     * ------------------------------------------------------------------ */

    private async void OnOpenPluginFolderClick(object sender, RoutedEventArgs e)
    {
        // 契约的 openFolder 只接受实例内的具名位置（root/home/workspace/logs/plugins），
        // 不接受任意绝对路径；因此这里打开的是实例的 home/plugins 根目录，
        // 而不是该插件自己的子目录（按钮文案与 ToolTip 已如实说明这一点）。
        var result = await AppServices.Bridge.CallAsync<BridgeVoid>(
            Channels.InstanceOpenFolder,
            _instanceId,
            InstanceFolderValues.Plugins);

        if (!result.Ok)
        {
            AppServices.Toast.Error("无法打开插件目录", result.Error);
        }
    }

    private async void OnRemoveLocalClick(object sender, RoutedEventArgs e)
    {
        if (sender is not MenuFlyoutItem { Tag: string name } || string.IsNullOrEmpty(name))
        {
            return;
        }

        var confirmed = await AppServices.Dialogs.ConfirmAsync(
            "删除本地插件",
            $"将从实例中删除插件「{name}」，同时移除 profile 依赖与 bundles 登记。此操作不可撤销。",
            "删除插件",
            "取消",
            destructive: true);

        if (!confirmed)
        {
            return;
        }

        var result = await AppServices.Bridge.CallAsync<PluginInventory>(Channels.PluginRemoveLocal, _instanceId, name);
        if (!result.Ok)
        {
            ShowError("删除本地插件失败", result.Error ?? "未知错误");
            return;
        }

        ErrorBar.IsOpen = false;
        AppServices.Toast.Success($"已删除插件 {name}");

        var local = await AppServices.Bridge.CallAsync<PluginSummary[]>(Channels.PluginListLocal, _instanceId);
        ApplyInventory(result.Value, local.Value ?? Array.Empty<PluginSummary>());
    }

    /* ------------------------------------------------------------------ *
     * 安装本地插件（zip / GitHub / 文件夹）
     * ------------------------------------------------------------------ */

    private void OnInstallClick(object sender, RoutedEventArgs e)
    {
        ResetInstallPanel();

        if (InstallKind.SelectedIndex < 0)
        {
            InstallKind.SelectedIndex = 0;
        }

        InstallFlyout.ShowAt(InstallButton);
    }

    /// <summary>
    /// 规范 §9.3 的「安装来源选择」写的是 <c>ContentDialog</c> 三选一；这里用
    /// <see cref="Flyout"/> + <c>RadioButtons</c>。原因：安装过程要**持续占用这个面板**显示进度与
    /// 原始输出，而 <c>ContentDialog</c> 在用户点主按钮时即关闭（规范 §6.4 也限制同一窗口同时只能开一个），
    /// 关掉之后就无处呈现结果了。三选一与「取消」语义完整保留。
    /// </summary>
    private void OnInstallKindChanged(object sender, SelectionChangedEventArgs e)
    {
        var isGithub = InstallKind.SelectedIndex == 1;

        GithubUrlBox.Visibility = isGithub ? Visibility.Visible : Visibility.Collapsed;
        PickButton.Visibility = isGithub ? Visibility.Collapsed : Visibility.Visible;
        PickButton.Content = InstallKind.SelectedIndex == 2 ? "选择插件文件夹…" : "选择 zip 文件…";
    }

    private async void OnPickSourceClick(object sender, RoutedEventArgs e)
    {
        PickButton.IsEnabled = false;
        try
        {
            var source = await ResolveSourceAsync();
            if (source is null)
            {
                return;
            }

            await InstallAsync(source);
        }
        finally
        {
            PickButton.IsEnabled = true;
        }
    }

    /// <summary>
    /// 解析安装来源。
    ///
    /// 文件/目录选择一律走后端通道（规范 §9.4 明确禁止本页自己调 <c>FileOpenPicker</c>/<c>FolderPicker</c>）：
    /// <c>plugin:pickArchive</c> / <c>plugin:pickFolder</c> 由 Node 反向调用 C# 的
    /// <c>host:pickArchive</c> / <c>host:pickFolder</c> 弹系统对话框并回传绝对路径。
    /// </summary>
    private async Task<PluginSource?> ResolveSourceAsync()
    {
        switch (InstallKind.SelectedIndex)
        {
            case 0:
            {
                var picked = await AppServices.Bridge.CallAsync<string>(Channels.PluginPickArchive);
                if (!picked.Ok)
                {
                    ShowInstallOutcome(false, "无法选择 zip 文件", picked.Error ?? "未知错误");
                    return null;
                }

                // 取消时 Ok=true + Value=null（core-dev 明确的语义），此处静默返回
                if (string.IsNullOrEmpty(picked.Value))
                {
                    return null;
                }

                return new PluginSource { Kind = PluginSourceKindValues.Archive, File = picked.Value };
            }

            case 1:
            {
                var url = GithubUrlBox.Text?.Trim() ?? string.Empty;
                if (url.Length == 0)
                {
                    ShowInstallOutcome(
                        false,
                        "请填写 GitHub 仓库地址",
                        "支持 owner/repo、owner/repo#v1.2.3、https://github.com/owner/repo 以及 git@github.com:owner/repo.git。");
                    return null;
                }

                return new PluginSource { Kind = PluginSourceKindValues.Github, Url = url };
            }

            case 2:
            {
                var picked = await AppServices.Bridge.CallAsync<string>(Channels.PluginPickFolder);
                if (!picked.Ok)
                {
                    ShowInstallOutcome(false, "无法选择插件文件夹", picked.Error ?? "未知错误");
                    return null;
                }

                if (string.IsNullOrEmpty(picked.Value))
                {
                    return null;
                }

                return new PluginSource { Kind = PluginSourceKindValues.Folder, Dir = picked.Value };
            }

            default:
                ShowInstallOutcome(false, "请选择安装来源", "可选 zip 压缩包、GitHub 仓库或本地文件夹。");
                return null;
        }
    }

    private async Task InstallAsync(PluginSource source)
    {
        // GitHub 来源 + pnpm 安装可能跑很久，显式放宽超时：默认超时会让长安装半途被判定失败
        var installTimeout = TimeSpan.FromMinutes(30);

        InstallProgress.Visibility = Visibility.Visible;
        InstallStageText.Text = "正在安装…";
        InstallStageText.Visibility = Visibility.Visible;
        InstallOutcomeBar.IsOpen = false;
        InstallOutputBox.Visibility = Visibility.Collapsed;
        PickButton.IsEnabled = false;

        var result = await AppServices.Bridge.CallAsync<PluginInstallResult>(
            Channels.PluginInstall,
            installTimeout,
            _instanceId,
            source);

        InstallProgress.Visibility = Visibility.Collapsed;
        InstallStageText.Visibility = Visibility.Collapsed;
        PickButton.IsEnabled = true;

        if (!result.Ok)
        {
            // AllowBuildsError 场景：后端会**自动**重试一次后仍失败才回 ok:false，
            // 因此这里展示的是重试之后的最终错误（规范 §9.3 要求重试期间保持进度条）。
            ShowInstallOutcome(false, "安装失败", result.Error ?? "未知错误");
            return;
        }

        var install = result.Value;
        if (install is null)
        {
            ShowInstallOutcome(false, "安装失败", "后端未返回安装结果。");
            return;
        }

        // warnings 非空 → InfoBar Warning 逐条显示（规范 §9.3「错误」）
        if (install.Warnings.Count > 0)
        {
            ShowInstallOutcome(true, $"已安装 {install.Name}", string.Join("\n", install.Warnings), InfoBarSeverity.Warning);
        }
        else
        {
            ShowInstallOutcome(true, $"已安装 {install.Name}", $"依赖规格：{install.Spec}");
        }

        AppServices.Toast.Success($"已安装插件 {install.Name}");

        // 安装结果里带了最新库存，直接复用，省一次往返
        var local = await AppServices.Bridge.CallAsync<PluginSummary[]>(Channels.PluginListLocal, _instanceId);
        ApplyInventory(install.Inventory, local.Value ?? Array.Empty<PluginSummary>());
    }

    private void ShowInstallOutcome(
        bool success,
        string title,
        string detail,
        InfoBarSeverity? severity = null)
    {
        InstallOutcomeBar.Severity = severity ?? (success ? InfoBarSeverity.Success : InfoBarSeverity.Error);
        InstallOutcomeBar.Title = title;
        InstallOutcomeBar.Message = detail;
        InstallOutcomeBar.IsOpen = true;

        // 失败时把原始输出露出来（AllowBuildsError 场景下含 pnpm/dsh 原文），可复制
        if (!success)
        {
            InstallOutputBox.Text = detail;
            InstallOutputBox.Visibility = Visibility.Visible;
        }
    }

    private void ResetInstallPanel()
    {
        InstallProgress.Visibility = Visibility.Collapsed;
        InstallStageText.Visibility = Visibility.Collapsed;
        InstallOutcomeBar.IsOpen = false;
        InstallOutputBox.Visibility = Visibility.Collapsed;
        InstallOutputBox.Text = string.Empty;
        PickButton.IsEnabled = true;
        GithubUrlBox.Text = string.Empty;
    }

    private void OnInstallFlyoutClosed(object? sender, object e) => ResetInstallPanel();

    private void OnCloseInstallClick(object sender, RoutedEventArgs e) => InstallFlyout.Hide();

    /* ------------------------------------------------------------------ *
     * 其它
     * ------------------------------------------------------------------ */

    private async void OnRefreshClick(object sender, RoutedEventArgs e) => await RefreshAsync();

    /// <summary>页级错误呈现（规范 §9.0：<c>ok:false</c> 必须可见，文案用 <c>error</c> 原文）。</summary>
    public void ShowError(string title, string message)
    {
        ErrorBar.Title = title;
        ErrorBar.Message = message;
        ErrorBar.IsOpen = true;
    }
}

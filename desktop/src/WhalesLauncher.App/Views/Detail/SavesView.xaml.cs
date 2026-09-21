using System.Collections.ObjectModel;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using WhalesLauncher.Models;
using WhalesLauncher.Services;

namespace WhalesLauncher.Views.Detail;

/// <summary>
/// P4 实例详情 · 存档（视觉规范 §9.5）。
///
/// 关键实现点：
/// <list type="bullet">
///   <item><description>排序：后端返回顺序不可信，前端按 <c>updatedAt</c> 倒序**再排一次**（§9.5）。</description></item>
///   <item><description>相对时间：**单一** 1 秒定时器批量刷新**可见行**，不是每行一个定时器（§9.5）。</description></item>
///   <item><description>体积为 <c>null</c> 显示 <c>—</c>（区分「未知」与「空」），见 <see cref="SessionRow.SizeText"/>。</description></item>
/// </list>
/// </summary>
public sealed partial class SavesView : UserControl
{
    /// <summary>「全部工作区」在筛选下拉里的标签。</summary>
    private const string AllWorkspaces = "全部工作区";

    private readonly ObservableCollection<SessionRow> _allRows = new();
    private readonly DispatcherQueueTimer _relativeTimer;

    private string _instanceId = string.Empty;

    public SavesView()
    {
        InitializeComponent();

        _relativeTimer = DispatcherQueue.CreateTimer();
        _relativeTimer.Interval = TimeSpan.FromSeconds(1);
        _relativeTimer.IsRepeating = true;
        _relativeTimer.Tick += OnRelativeTick;
    }

    /// <summary>绑定源：筛选后的行。</summary>
    public ObservableCollection<SessionRow> Rows { get; } = new();

    /// <summary>装载：拉存档列表并启动相对时间定时器。</summary>
    public async Task LoadAsync(string instanceId, string instanceName)
    {
        _instanceId = instanceId;

        Crumb.ItemsSource = DetailBreadcrumb.For(instanceName, DetailTabs.Label(DetailTabs.Saves));

        _relativeTimer.Start();
        await RefreshAsync();
    }

    /// <summary>离开页面：停表，避免后台每秒空转（规范 §8 / 简报 §4.9）。</summary>
    public void Unload() => _relativeTimer.Stop();

    /// <summary>重新拉取存档。</summary>
    public async Task RefreshAsync()
    {
        LoadingBar.Visibility = Visibility.Visible;

        var result = await AppServices.Bridge.CallAsync<SessionInfo[]>(Channels.SavesList, _instanceId);

        LoadingBar.Visibility = Visibility.Collapsed;

        if (!result.Ok)
        {
            // 规范 §9.5：saves.list 失败 → 页级 InfoBar Error（不得只进日志）
            ShowError("无法读取存档", result.Error ?? "未知错误");
            return;
        }

        ErrorBar.IsOpen = false;

        var sessions = result.Value ?? Array.Empty<SessionInfo>();

        // 前端再排一次：契约只承诺"最后修改时间"，没有承诺数组顺序（§9.5 明确要求不信任顺序）。
        // OrderByDescending 是稳定排序，时间相同时保持后端给定的相对顺序。
        var ordered = sessions.OrderByDescending(session => ParseUpdatedAt(session.UpdatedAt)).ToList();

        _allRows.Clear();
        foreach (var session in ordered)
        {
            _allRows.Add(new SessionRow(session));
        }

        SyncWorkspaceFilter(ordered);
        ApplyFilter();
    }

    /// <summary>解析时间；无法解析的排到最后（而不是抛异常让整页失败）。</summary>
    private static DateTimeOffset ParseUpdatedAt(string? iso) =>
        DateTimeOffset.TryParse(
            iso,
            System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.RoundtripKind,
            out var parsed)
            ? parsed
            : DateTimeOffset.MinValue;

    /* ------------------------------------------------------------------ *
     * 工具条
     * ------------------------------------------------------------------ */

    /// <summary>同步工作区下拉选项，并尽量保留用户已选的筛选。</summary>
    private void SyncWorkspaceFilter(IReadOnlyList<SessionInfo> sessions)
    {
        var keys = new List<string> { AllWorkspaces };
        foreach (var session in sessions)
        {
            if (!string.IsNullOrEmpty(session.WorkspaceKey) && !keys.Contains(session.WorkspaceKey))
            {
                keys.Add(session.WorkspaceKey);
            }
        }

        var previous = WorkspaceFilter.SelectedItem as string;
        var target = previous is not null && keys.Contains(previous) ? previous : AllWorkspaces;

        // 选项集合变化才重建，避免每次刷新都重置下拉并触发一次无谓的 SelectionChanged
        var same = WorkspaceFilter.Items.Count == keys.Count;
        if (same)
        {
            for (var i = 0; i < keys.Count; i++)
            {
                if (!string.Equals(WorkspaceFilter.Items[i] as string, keys[i], StringComparison.Ordinal))
                {
                    same = false;
                    break;
                }
            }
        }

        if (!same)
        {
            WorkspaceFilter.ItemsSource = keys;
        }

        WorkspaceFilter.SelectedItem = target;
    }

    private string? SelectedWorkspace =>
        WorkspaceFilter.SelectedItem is string key && key != AllWorkspaces ? key : null;

    private void ApplyFilter()
    {
        var workspace = SelectedWorkspace;

        Rows.Clear();
        foreach (var row in _allRows)
        {
            if (workspace is null || string.Equals(row.WorkspaceKey, workspace, StringComparison.Ordinal))
            {
                Rows.Add(row);
            }
        }

        UpdateStates();
    }

    private void UpdateStates()
    {
        var showEmptyState = _allRows.Count == 0;
        var showFilteredEmpty = !showEmptyState && Rows.Count == 0;

        EmptyState.Visibility = showEmptyState ? Visibility.Visible : Visibility.Collapsed;
        FilteredEmpty.Visibility = showFilteredEmpty ? Visibility.Visible : Visibility.Collapsed;
        SavesList.Visibility = showEmptyState ? Visibility.Collapsed : Visibility.Visible;

        var totalBytes = 0L;
        var unknownSize = false;
        foreach (var row in Rows)
        {
            if (row.Session.SizeBytes is { } bytes && bytes > 0)
            {
                totalBytes += bytes;
            }
            else
            {
                unknownSize = true;
            }
        }

        // 体积未知时明确说出来，而不是把已知部分冒充"合计"
        var sizeText = unknownSize && totalBytes == 0
            ? "体积未知"
            : $"合计 {Formatters.FormatBytes(totalBytes)}" + (unknownSize ? "（部分未知）" : string.Empty);

        SummaryText.Text = $"共 {Rows.Count} 个存档，{sizeText}";
    }

    private void OnWorkspaceChanged(object sender, SelectionChangedEventArgs e) => ApplyFilter();

    private async void OnOpenSessionClick(object sender, RoutedEventArgs e)
    {
        if (sender is not Button button || button.Tag is not string sessionId)
        {
            return;
        }

        var result = await AppServices.Bridge.CallAsync<BridgeVoid>(Channels.SavesOpenFolder, _instanceId, sessionId);
        if (!result.Ok)
        {
            // 打开目录失败 → toast（规范 §9.5 明确该路径用 toast 而非整页 InfoBar）
            AppServices.Toast.Error("无法打开存档目录", result.Error);
        }
    }

    private void OnLoaded(object sender, RoutedEventArgs e) => RefreshVisibleRows();

    private void OnRelativeTick(DispatcherQueueTimer sender, object args) => RefreshVisibleRows();

    /// <summary>
    /// 只刷新**可见**行的时间文本（规范 §9.5「批量刷新可见行文本」）。
    /// 500 个存档里用户只看得到十几行，全量刷新是无谓的通知风暴。
    /// </summary>
    private void RefreshVisibleRows()
    {
        if (SavesList.ItemsPanelRoot is null)
        {
            return;
        }

        var now = DateTimeOffset.Now;
        foreach (var element in SavesList.ItemsPanelRoot.Children)
        {
            if (element is ListViewItem { Content: SessionRow row })
            {
                row.Refresh(now);
            }
        }
    }

    /// <summary>页级错误呈现（规范 §9.0）。</summary>
    public void ShowError(string title, string message)
    {
        ErrorBar.Title = title;
        ErrorBar.Message = message;
        ErrorBar.IsOpen = true;
    }
}

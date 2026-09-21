using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace WhalesLauncher.Services;

/// <summary>
/// 对话框服务：对 <see cref="ContentDialog"/> 的薄封装。
///
/// 取代旧 <c>src/renderer/components/modal.ts</c> 的自建模态（焦点陷阱 / 多级堆叠 / Esc 处理）——
/// ContentDialog 内建这些行为，因此旧实现里那 272 行可以整体删掉。
/// </summary>
public sealed class DialogService
{
    private XamlRoot? _xamlRoot;

    /// <summary>
    /// 承载"全局主题"的窗口根元素（外壳里的 <c>RootGrid</c>）。
    ///
    /// 需要它是因为 **ContentDialog 不继承 <c>RequestedTheme</c>**：对话框渲染在 XamlRoot 的
    /// 浮层（PopupRoot）上，而不是窗口根元素的可视树里，因此外壳把主题设在 <c>RootGrid</c> 上时，
    /// 对话框仍按系统主题绘制 —— 实测表现为"窗口是深色、弹出的自检报告却是浅色"。
    /// 这里持有它，并在每次 <see cref="Create"/> 时把同一主题显式交给对话框。
    /// </summary>
    private FrameworkElement? _themeRoot;

    /// <summary>
    /// 外壳是否已把 <see cref="XamlRoot"/> 挂上来。
    ///
    /// 需要的场景：**首次启动的环境自检**跑在 <c>App</c> 的后端装配里，而装配常常早于
    /// 窗口的 <c>Loaded</c>（那时还没有 <c>XamlRoot</c>）。要弹"缺少 Node，是否自动下载"
    /// 这样的确认框，就必须先能判断"现在能不能弹"。
    /// </summary>
    public bool IsAttached => _xamlRoot is not null;

    /// <summary>挂载完成时触发（由外壳在 <c>Loaded</c> 里调用 <see cref="Attach"/> 之后）。</summary>
    public event EventHandler? Attached;

    /// <summary>
    /// 由外壳在窗口内容加载完成后调用。未挂载时对话框调用会抛出明确异常（而非静默失败）。
    /// @param xamlRoot 窗口根元素的 XamlRoot。
    /// @param themeRoot 承载全局主题的元素（通常是外壳的 <c>RootGrid</c>）；省略则对话框跟随系统主题。
    /// </summary>
    public void Attach(XamlRoot xamlRoot, FrameworkElement? themeRoot = null)
    {
        _xamlRoot = xamlRoot;
        _themeRoot = themeRoot;
        Attached?.Invoke(this, EventArgs.Empty);
    }

    /// <summary>
    /// 当前应给对话框用的主题。
    ///
    /// 外壳尚未装载配置时窗口根元素是 <see cref="ElementTheme.Default"/>（跟随系统），
    /// 这里**原样传递**而不做任何替换 —— 规范 §9.9 明确禁止拿 <c>Default</c> 冒充"浅色"。
    /// </summary>
    public ElementTheme CurrentTheme => _themeRoot?.RequestedTheme ?? ElementTheme.Default;

    /// <summary>
    /// 把当前窗口主题应用到任一处直接构造的对话框。
    ///
    /// 供**不走 <see cref="Create"/>** 的调用方使用（项目里仍有多处按需自定义内容的对话框）；
    /// 不调用它的对话框会在深色窗口里以浅色绘制。
    /// @param dialog 目标对话框。
    /// </summary>
    public void ApplyTheme(ContentDialog dialog)
    {
        if (dialog is null) throw new ArgumentNullException(nameof(dialog));
        dialog.RequestedTheme = CurrentTheme;
    }

    /// <summary>
    /// 等到挂载完成（或超时）。
    ///
    /// 刻意用**异步等待**而不是阻塞：调用点很可能就是 UI 线程上的后端装配续体，
    /// 阻塞它等于把窗口冻住（约定 §8 禁止 <c>.Wait()</c>/<c>.Result</c>）。
    /// @param timeout 最长等待。
    /// @param ct 取消令牌。
    /// @returns 是否已挂载。
    /// </summary>
    public async Task<bool> WaitForAttachAsync(TimeSpan timeout, CancellationToken ct = default)
    {
        if (IsAttached) return true;

        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            ct.ThrowIfCancellationRequested();
            if (IsAttached) return true;
            await Task.Delay(120, ct).ConfigureAwait(true);
        }

        return IsAttached;
    }

    /// <summary>确认对话框。返回 true 表示用户点了主按钮。</summary>
    public async Task<bool> ConfirmAsync(
        string title,
        string message,
        string primaryText = "确定",
        string closeText = "取消",
        bool destructive = false)
    {
        var dialog = Create(title, message);
        dialog.PrimaryButtonText = primaryText;
        dialog.CloseButtonText = closeText;
        dialog.DefaultButton = ContentDialogButton.Close;

        if (destructive)
        {
            // 破坏性操作用内置的危险色，不自定义红色
            dialog.PrimaryButtonStyle = (Style)Application.Current.Resources["AccentButtonStyle"];
        }

        var result = await dialog.ShowAsync();
        return result == ContentDialogResult.Primary;
    }

    /// <summary>提示对话框（仅一个关闭按钮）。</summary>
    public async Task AlertAsync(string title, string message, string closeText = "知道了")
    {
        var dialog = Create(title, message);
        dialog.CloseButtonText = closeText;
        dialog.DefaultButton = ContentDialogButton.Close;
        await dialog.ShowAsync();
    }

    /// <summary>
    /// 允许调用方继续追加内容的对话框（如删除确认里的附加选项）。
    ///
    /// 已经带上当前窗口主题 —— 见 <see cref="CurrentTheme"/> 上关于"对话框不继承
    /// <c>RequestedTheme</c>"的说明；需要自定义内容的调用方替换 <c>Content</c> 即可，
    /// 主题已经在对话框自身上设好了。
    /// </summary>
    public ContentDialog Create(string title, string message)
    {
        if (_xamlRoot is null)
        {
            throw new InvalidOperationException("对话框服务尚未挂载 XamlRoot：外壳尚未完成内容加载。");
        }

        return new ContentDialog
        {
            XamlRoot = _xamlRoot,
            RequestedTheme = CurrentTheme,
            Title = title,
            Content = new TextBlock
            {
                Text = message,
                TextWrapping = TextWrapping.Wrap,
            },
        };
    }
}

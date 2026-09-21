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

    /// <summary>由外壳在窗口内容加载完成后调用。未挂载时对话框调用会抛出明确异常（而非静默失败）。</summary>
    public void Attach(XamlRoot xamlRoot) => _xamlRoot = xamlRoot;

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

    /// <summary>允许调用方继续追加内容的对话框（如删除确认里的附加选项）。</summary>
    public ContentDialog Create(string title, string message)
    {
        if (_xamlRoot is null)
        {
            throw new InvalidOperationException("对话框服务尚未挂载 XamlRoot：外壳尚未完成内容加载。");
        }

        return new ContentDialog
        {
            XamlRoot = _xamlRoot,
            Title = title,
            Content = new TextBlock
            {
                Text = message,
                TextWrapping = TextWrapping.Wrap,
            },
        };
    }
}

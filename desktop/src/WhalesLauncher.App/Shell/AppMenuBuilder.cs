using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using WhalesLauncher.Models;

namespace WhalesLauncher.Shell;

/// <summary>
/// 把后端 <c>app:menu</c> 返回的 <see cref="MenuNode"/> 树投影成 <see cref="MenuBar"/> 控件树。
///
/// 为什么不把菜单写死在 XAML 里：契约 <c>src/shared/contracts.ts:530-546</c> 明确
/// "渲染层的自绘菜单只是它的视图，不得自行维护第二份定义" —— 菜单项的 id/label/accelerator
/// 与 Node 侧真实命令同源，界面再抄一份必然漂移（菜单里显示的快捷键和真实绑定对不上）。
///
/// 点击只回传 <c>MenuNode.id</c>，由后端 <c>app:menuCommand</c> 解析成命令 ——
/// 界面不持有命令表（契约有意不把 <c>command</c> 暴露给渲染层）。
/// </summary>
public static class AppMenuBuilder
{
    /// <summary>用后端菜单树重建整个菜单栏。</summary>
    /// <param name="target">标题栏 LeftHeader 里的 MenuBar。</param>
    /// <param name="nodes">后端返回的菜单树。</param>
    /// <param name="executeAsync">执行一个菜单命令（传 MenuNode.id）。</param>
    public static void Populate(MenuBar target, IReadOnlyList<MenuNode> nodes, Func<string, Task> executeAsync)
    {
        ArgumentNullException.ThrowIfNull(target);
        ArgumentNullException.ThrowIfNull(nodes);
        ArgumentNullException.ThrowIfNull(executeAsync);

        target.Items.Clear();

        foreach (var node in nodes)
        {
            // 顶层项必须有子菜单才有意义：MenuBarItem 只能通过 Flyout 展开，
            // 没有子项的顶层节点会变成一个点不开的空标签，因此跳过。
            if (node.Children is null || node.Children.Count == 0)
            {
                continue;
            }

            // MenuBarItem 是 ItemsControl：子项直接加进 Items，控件自己生成下拉。
            // 不用 MenuBarItem.Flyout —— WinAppSDK 2.5 的 C# 投影里它是预览成员，不可用。
            var barItem = new MenuBarItem { Title = node.Label };
            foreach (var child in node.Children)
            {
                AddNode(barItem.Items, child, executeAsync);
            }

            target.Items.Add(barItem);
        }
    }

    private static void AddNode(IList<MenuFlyoutItemBase> items, MenuNode node, Func<string, Task> executeAsync)
    {
        if (node.Kind == MenuNodeKindValues.Separator)
        {
            items.Add(new MenuFlyoutSeparator());
            return;
        }

        if (node.Kind == MenuNodeKindValues.Header)
        {
            // WinUI 的 MenuFlyout 没有"分组标题"控件，用不可点中的项表达（不隐藏，避免菜单项数量跳动）
            items.Add(new MenuFlyoutItem { Text = node.Label, IsEnabled = false });
            return;
        }

        if (node.Children is { Count: > 0 })
        {
            var subItem = new MenuFlyoutSubItem { Text = node.Label, IsEnabled = node.Enabled ?? true };
            foreach (var child in node.Children)
            {
                AddNode(subItem.Items, child, executeAsync);
            }

            items.Add(subItem);
            return;
        }

        var item = new MenuFlyoutItem { Text = node.Label, IsEnabled = node.Enabled ?? true };

        if (!string.IsNullOrEmpty(node.Accelerator))
        {
            // accelerator 只做**显示**，不重绑真实按键。
            // 理由：这批快捷键来自旧 Chromium/Electron 宿主（刷新界面 / 强制刷新 / DevTools /
            // 缩放 / 编辑类），其中编辑类（Ctrl+C/V/X/A/Z）与 WinUI 控件内建编辑键冲突，
            // 重绑会让文本框的复制粘贴失效；视图类命令在 WinUI 里也没有对应宿主能力。
            // 规范 §7.2 给的做法正是「菜单里显示快捷键」= KeyboardAcceleratorTextOverride。
            item.KeyboardAcceleratorTextOverride = node.Accelerator;
            AutomationProperties.SetAcceleratorKey(item, node.Accelerator);
        }

        var id = node.Id;
        item.Click += async (_, _) => await executeAsync(id);
        items.Add(item);
    }
}

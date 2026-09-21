namespace WhalesLauncher.Models;

/// <summary>
/// 菜单树节点（<c>app:menu</c> 的返回值元素）。
/// 来源：<c>src/shared/contracts.ts:537-546</c>。
///
/// 由 Node 侧 <c>menuSpec()</c> 投影而来 —— 菜单项的 id、label、accelerator
/// 与实际按键绑定同源，界面自绘菜单只是它的视图，不得自行维护第二份定义。
/// 否则菜单里显示的快捷键会和真实绑定漂移。
/// </summary>
public sealed class MenuNode
{
    public string Id { get; set; } = string.Empty;

    public string Label { get; set; } = string.Empty;

    /// <summary>展示用的快捷键文本，如 <c>Ctrl+R</c>。</summary>
    public string? Accelerator { get; set; }

    /// <summary>分隔线或分组标题，取值见 <see cref="MenuNodeKindValues"/>；普通菜单项为 null。</summary>
    public string? Kind { get; set; }

    /// <summary>是否可用；契约里可省略，省略按可用处理。</summary>
    public bool? Enabled { get; set; }

    /// <summary>子菜单。</summary>
    public List<MenuNode>? Children { get; set; }
}

/// <summary><c>MenuNode.kind</c> 的取值。来源：<c>src/shared/contracts.ts:543</c>。</summary>
public static class MenuNodeKindValues
{
    /// <summary>分隔线。</summary>
    public const string Separator = "separator";

    /// <summary>分组标题。</summary>
    public const string Header = "header";

    /// <summary>全部取值。</summary>
    public static readonly string[] All = { Separator, Header };
}

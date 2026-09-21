namespace WhalesLauncher.Views.Detail;

/// <summary>
/// 详情页面包屑（「实例名 / 页名」，规范 §9.0 的 Col 2 / §6.2 的详情页用法）。
///
/// <b>为什么直接给字符串而不是自定义对象</b>：<see cref="Microsoft.UI.Xaml.Controls.BreadcrumbBar"/>
/// 在没有 <c>ItemTemplate</c> 时把每个条目按 <c>ToString()</c> 渲染；给自定义 record 时
/// 会渲染出整个 record 的结构文本（实测截图里出现了
/// <c>BreadcrumbNode { Label = test1, RouteKey = detail, Parameter = DetailNavArgs {...} }</c> 这种
/// 明显错误的内容）。而 <c>ItemsSource</c> 只接受一个字符串列表时，条目本身就是显示文本，
/// 行为确定、无需再维护 <c>ItemTemplate</c>。
///
/// 取舍：面包屑因此是**只读展示**，不做点击跳转。理由：第二段「页名」没有可跳转目标，
/// 第一段「实例名」指向的正是详情页的默认页签（插件），点它等于"留在原地"，
/// 提供一个看起来可点但语义为空的层级反而误导用户。规范 §6.2 只要求可"一键跳回上级"，
/// 而本页的上级（实例列表）已由页头「返回」按钮 + Alt+Left 承担。
/// </summary>
public static class DetailBreadcrumb
{
    /// <summary>构造面包屑数据源：`实例名` / `页名`。</summary>
    /// <param name="instanceName">实例显示名。</param>
    /// <param name="pageLabel">当前页名（如「日志」）。</param>
    public static List<string> For(string instanceName, string pageLabel)
    {
        return new List<string> { instanceName, pageLabel };
    }
}

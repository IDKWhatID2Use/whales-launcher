using Microsoft.UI.Xaml.Controls;
using WhalesLauncher.Services;

namespace WhalesLauncher.Views.Detail;

/// <summary>
/// 详情页面包屑（「实例 / 实例名 / 页名」，规范 §9.0 的 Col 2 / §6.2 的详情页用法）。
///
/// <b>数据源仍然只给字符串</b>：<see cref="BreadcrumbBar"/> 在没有 <c>ItemTemplate</c> 时把每个条目
/// 按 <c>ToString()</c> 渲染；给自定义 record 时会渲染出整个 record 的结构文本（实测截图里出现过
/// <c>BreadcrumbNode { Label = test1, RouteKey = detail, Parameter = DetailNavArgs { ... } }</c>
/// 这种明显错误的内容，交付报告把它登记为 P3 缺陷）。
/// 三段跳转只按**下标**区分，不需要自定义对象，因此这个坑从设计上就绕开了。
/// 将来若要改成自定义对象，**必须**同时配 <c>ItemTemplate</c>，否则 P3 会立刻复发。
///
/// 为什么现在改成可点击：左栏已从「实例列表」改成功能列表，详情页的上级不再是"左栏里那一行"，
/// 面包屑因此成为"我在哪 / 怎么上去"的主要表达，也与左栏「实例」的选中态互相呼应
/// （交接文档 §5.4）。
/// </summary>
public static class DetailBreadcrumb
{
    /// <summary>第一段（根）的文案。</summary>
    public const string RootLabel = "实例";

    /* 段位常量：避免裸下标散落在 4 个视图里（改段位时只改这里）。 */

    /// <summary>第 0 段：「实例」——点击回到实例列表。</summary>
    public const int RootIndex = 0;

    /// <summary>第 1 段：实例名 —— 点击回到该实例的默认页签。</summary>
    public const int InstanceIndex = 1;

    /// <summary>第 2 段：当前页名 —— **不可跳转**。</summary>
    public const int PageIndex = 2;

    /// <summary>构造面包屑数据源：`实例` / `实例名` / `页名`。</summary>
    /// <param name="instanceName">实例显示名。</param>
    /// <param name="pageLabel">当前页名（如「日志」）。</param>
    public static List<string> For(string instanceName, string pageLabel) =>
        new() { RootLabel, instanceName, pageLabel };

    /// <summary>
    /// 面包屑点击的统一处理（四个详情视图共用一份；各写一遍必然漂移）。
    ///
    /// 段位语义：0 = 「实例」→ 回实例列表；1 = 实例名 → 该实例的默认页签（插件）；
    /// 2 = 当前页名 → **不跳转**：点它等于留在原地，给一个假的"跳转"反馈反而误导
    /// （这条判断在旧实现里也成立，只是当时的理由是"上级由返回按钮承担"，现在换成了
    /// "末段本来就是当前位置"）。
    /// </summary>
    /// <param name="args">BreadcrumbBar 的点击事件参数（提供 <c>Index</c>）。</param>
    /// <param name="instanceId">当前实例 id；为空（如实例刚被删除）时只有根段可跳。</param>
    public static void OnItemClicked(BreadcrumbBarItemClickedEventArgs args, string? instanceId)
    {
        switch (args.Index)
        {
            case RootIndex:
                AppServices.Navigation.Navigate(RouteKeys.Instances);
                break;

            case InstanceIndex when !string.IsNullOrEmpty(instanceId):
                AppServices.Navigation.NavigateToDetail(instanceId!, DetailTabs.Plugins);
                break;

            default:
                break;
        }
    }
}

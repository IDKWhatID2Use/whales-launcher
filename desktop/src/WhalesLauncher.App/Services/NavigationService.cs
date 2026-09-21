using Microsoft.UI.Xaml.Controls;

namespace WhalesLauncher.Services;

/// <summary>详情页导航参数（实例 id + 目标标签页）。</summary>
/// <param name="InstanceId">实例稳定标识。</param>
/// <param name="Tab">目标标签页，取值见 <see cref="DetailTabs"/>。</param>
public sealed record DetailNavArgs(string InstanceId, string Tab);

/// <summary>详情页标签页标识。取代旧 `src/renderer/router.ts` 的 `DETAIL_TABS`。</summary>
public static class DetailTabs
{
    public const string Plugins = "plugins";
    public const string Settings = "settings";
    public const string Saves = "saves";
    public const string Logs = "logs";

    public static readonly string[] All = { Plugins, Settings, Saves, Logs };

    public static bool IsValid(string? value) =>
        value is not null && Array.IndexOf(All, value) >= 0;

    /// <summary>标签页中文显示名。</summary>
    public static string Label(string tab) => tab switch
    {
        Plugins => "插件",
        Settings => "设置",
        Saves => "存档",
        Logs => "日志",
        _ => tab,
    };
}

/// <summary>路由键。与旧 <c>src/renderer/router.ts</c> 的 <c>RouteName</c> 一一对应。</summary>
public static class RouteKeys
{
    public const string Instances = "instances";
    public const string Detail = "detail";
    public const string Engines = "engines";
    public const string Create = "create";
    public const string Settings = "settings";
}

/// <summary>
/// 页面导航服务。
///
/// 取代旧的基于 <c>window.location.hash</c> 的 hash 路由（<c>src/renderer/router.ts</c>）：
/// WinUI 3 用 <see cref="Frame.Navigate(Type, object)"/> + 强类型参数对象，不再有 URL 与字符串解析。
/// </summary>
public sealed class NavigationService
{
    private readonly Frame _frame;

    public NavigationService(Frame frame)
    {
        _frame = frame ?? throw new ArgumentNullException(nameof(frame));
    }

    /// <summary>导航完成后触发，参数为路由键。</summary>
    public event EventHandler<string>? Navigated;

    /// <summary>当前路由键。</summary>
    public string CurrentRoute { get; private set; } = RouteKeys.Instances;

    public bool CanGoBack => _frame.CanGoBack;

    /// <summary>导航到指定路由。同一页面且无参数时不重复导航（避免无谓重建与闪烁）。</summary>
    public void Navigate(string routeKey, object? parameter = null)
    {
        var pageType = Resolve(routeKey)
            ?? throw new ArgumentException($"未知路由：{routeKey}", nameof(routeKey));

        if (_frame.CurrentSourcePageType == pageType && parameter is null)
        {
            return;
        }

        _frame.Navigate(pageType, parameter);
        CurrentRoute = routeKey;
        Navigated?.Invoke(this, routeKey);
    }

    /// <summary>导航到实例详情页的指定标签页。</summary>
    public void NavigateToDetail(string instanceId, string tab)
    {
        var normalized = DetailTabs.IsValid(tab) ? tab : DetailTabs.Plugins;
        Navigate(RouteKeys.Detail, new DetailNavArgs(instanceId, normalized));
    }

    public void GoBack()
    {
        if (_frame.CanGoBack)
        {
            _frame.GoBack();
        }
    }

    private static Type? Resolve(string routeKey) => routeKey switch
    {
        RouteKeys.Instances => typeof(Views.InstancesPage),
        RouteKeys.Detail => typeof(Views.InstanceDetailPage),
        RouteKeys.Engines => typeof(Views.EnginesPage),
        RouteKeys.Create => typeof(Views.WizardPage),
        RouteKeys.Settings => typeof(Views.SettingsPage),
        _ => null,
    };
}

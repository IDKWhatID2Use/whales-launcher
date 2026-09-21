using WhalesLauncher.Controls;

namespace WhalesLauncher.Services;

/// <summary>
/// 轻提示服务：视图层唯一的提示出口。
///
/// 取代旧实现里 <c>components/toast.ts</c> 的模块级函数 + <c>store.ts</c> 直接 import toast 的耦合写法：
/// 这里 Service 只往宿主投递，宿主未挂载时静默丢弃（启动早期无外壳不会崩）。
/// </summary>
public sealed class ToastService
{
    private ToastHost? _host;

    /// <summary>由外壳在构造后调用，把提示宿主接进来。</summary>
    public void Attach(ToastHost host) => _host = host;

    public void Info(string message, string? detail = null) =>
        _host?.Show(ToastKind.Informational, message, detail);

    public void Success(string message, string? detail = null) =>
        _host?.Show(ToastKind.Success, message, detail);

    public void Warning(string message, string? detail = null) =>
        _host?.Show(ToastKind.Warning, message, detail);

    public void Error(string message, string? detail = null) =>
        _host?.Show(ToastKind.Error, message, detail);
}

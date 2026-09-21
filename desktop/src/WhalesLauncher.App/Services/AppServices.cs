namespace WhalesLauncher.Services;

/// <summary>
/// 服务定位器。
///
/// 取舍说明：本项目规模（8 个页面 + 1 个外壳）不值得引入 DI 容器；
/// 但也**不允许**页面各自 <c>new CoreBridge()</c>（那会拉起多个 Node 子进程）。
/// 因此用静态定位器暴露**唯一实例**，与旧前端的模块级单例（<c>data/store.ts</c>、<c>data/api.ts</c>）语义等价。
///
/// 装配顺序由 <see cref="App"/> 保证：<see cref="Bridge"/> → <see cref="State"/> → 外壳创建后 <see cref="Navigation"/>。
/// </summary>
public static class AppServices
{
    private static CoreBridge? _bridge;
    private static AppState? _state;
    private static NavigationService? _navigation;

    /// <summary>轻提示。在外壳挂载宿主前调用是安全的（静默丢弃）。</summary>
    public static ToastService Toast { get; } = new();

    /// <summary>对话框。外壳挂载 XamlRoot 前调用会抛出明确异常。</summary>
    public static DialogService Dialogs { get; } = new();

    public static CoreBridge Bridge =>
        _bridge ?? throw new InvalidOperationException("服务尚未装配：CoreBridge 为空。");

    public static AppState State =>
        _state ?? throw new InvalidOperationException("服务尚未装配：AppState 为空。");

    public static NavigationService Navigation =>
        _navigation ?? throw new InvalidOperationException("服务尚未装配：NavigationService 为空（外壳尚未创建）。");

    public static bool IsReady => _bridge is not null && _state is not null;

    /// <summary>装配桥接与状态层。由 <see cref="App"/> 在创建窗口前调用。</summary>
    public static void Initialize(CoreBridge bridge, AppState state)
    {
        _bridge = bridge ?? throw new ArgumentNullException(nameof(bridge));
        _state = state ?? throw new ArgumentNullException(nameof(state));
    }

    /// <summary>外壳创建导航服务后注册进来。</summary>
    public static void AttachNavigation(NavigationService navigation)
    {
        _navigation = navigation ?? throw new ArgumentNullException(nameof(navigation));
    }
}

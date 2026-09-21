using System.Diagnostics;
using Microsoft.UI.Xaml;
using WhalesLauncher.Services;
using WhalesLauncher.Shell;

namespace WhalesLauncher;

/// <summary>
/// 应用入口。职责：**先把界面立起来，再装配后端**。
///
/// 取代旧的 <c>src/renderer/index.ts</c> 启动编排（后端探测 → 状态装载 → 外壳 → 路由），
/// 但保留了它最重要的一条产品决策：**后端可能挂起或失败，界面必须照常出现**。
/// 旧实现用 <c>Promise.race([store.init(), timeout(6000)])</c> 达到这一点；
/// 这里更彻底 —— 窗口同步创建并激活，后端在后台装配，失败只降级能力、不影响窗口可用。
/// 依据：视觉规范 §9.1「后端探测失败：窗口仍要出界面（外壳先渲染）」。
/// </summary>
public partial class App : Application
{
    private CoreBridge? _bridge;

    /// <summary>当前主窗口。视图层需要 <c>XamlRoot</c>（如 ContentDialog）时从这里取。</summary>
    public static Window? MainWindow { get; private set; }

    public App()
    {
        // 崩溃取证：WinUI 3 的 XAML 加载异常在未捕获时会变成 STATUS_STOWED_EXCEPTION
        // (0xC000027B)，进程直接死掉且不给任何可读信息。把异常原文落盘，便于定位。
        UnhandledException += OnUnhandledException;
        AppDomain.CurrentDomain.UnhandledException += (_, e) => WriteCrashLog(e.ExceptionObject as Exception);
        InitializeComponent();
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        try
        {
            var window = new MainWindow();
            MainWindow = window;
            window.Closed += OnMainWindowClosed;
            window.Activate();

            // 不 await：窗口已激活，后端在后台装配
            _ = BootBackendAsync();
        }
        catch (Exception ex)
        {
            WriteCrashLog(ex);
            throw;
        }
    }

    private static void OnUnhandledException(object sender, Microsoft.UI.Xaml.UnhandledExceptionEventArgs e)
    {
        WriteCrashLog(e.Exception);
    }

    /// <summary>把异常写到 exe 同目录的 crash.txt（尽力而为，自身不得再抛）。</summary>
    private static void WriteCrashLog(Exception? ex)
    {
        try
        {
            var path = Path.Combine(AppContext.BaseDirectory, "crash.txt");
            var text = $"[{DateTime.Now:O}]{Environment.NewLine}{ex}{Environment.NewLine}{Environment.NewLine}--- InnerException ---{Environment.NewLine}{ex?.InnerException}";
            File.WriteAllText(path, text);
        }
        catch
        {
            // 取证失败不能影响主流程
        }
    }

    private async Task BootBackendAsync()
    {
        try
        {
            var entry = ResolveBridgeEntry();
            var home = ResolveRootDirectory();

            var bridge = new CoreBridge(entry, home);
            _bridge = bridge;

            var state = new AppState(bridge);
            AppServices.Initialize(bridge, state);

            // 让界面**被后端推送驱动**，而不是只靠实例列表的周期轮询：
            // 进程崩溃/被杀的最后一帧 log:state 一到，卡片状态就更新（详见 AppState.AttachRuntimePushes）。
            // 用主窗口的调度器把推送汇入 UI 线程；窗口此时一定已经创建（OnLaunched 先建窗口后装后端）。
            state.AttachRuntimePushes(MainWindow?.DispatcherQueue);

            bridge.BackendExited += OnBackendExited;

            try
            {
                await bridge.StartAsync();
            }
            catch (InvalidOperationException ex) when (IsMissingRuntime(ex))
            {
                /*
                 * 侧车进程本身要靠 Node 才能跑起来（鸡生蛋），所以"这台机器没有 Node"
                 * 只能在这里、由宿主自己解决：问一次 → 下载官方便携版 → 重试一次启动。
                 * 用户拒绝或下载失败时把原异常抛回外层，由统一的后端失败路径处理。
                 */
                if (!await TryProvisionNodeAsync(home))
                {
                    throw;
                }

                await bridge.StartAsync();
            }

            await state.InitializeAsync();
        }
        catch (Exception ex)
        {
            // 后端起不来不是致命错误：窗口已可用，这里只做能力降级 + 明确提示
            var reason = ex.Message;
            if (AppServices.IsReady)
            {
                AppServices.State.MarkBackendDown(reason);
            }

            AppServices.Toast.Error(
                "后端未能启动",
                $"{reason}\n\n界面仍可浏览，但实例与引擎操作不可用。");
        }
    }

    /// <summary>
    /// 该异常是否是「找不到 Node 运行时」。
    ///
    /// 判据是 <see cref="NodeRuntimeLocator.RequireAsync"/> 的失败文案（它在无法给出可用
    /// 运行时时抛 <see cref="InvalidOperationException"/>，消息以这句话开头）。刻意不用
    /// "任何 InvalidOperationException" 兜底：那会把握手失败、桥接缺失之类的真问题
    /// 也当成"缺 Node"而去下载 30MB。
    /// </summary>
    private static bool IsMissingRuntime(Exception ex)
        => ex is InvalidOperationException
           && ex.Message.Contains("未找到可用的 Node.js 运行时", StringComparison.Ordinal);

    /// <summary>
    /// 备好一个可用的 Node（探测 → 没有就问用户 → 下载便携版）。
    /// @param home 启动器根目录。
    /// @returns 是否已获得可用运行时。
    /// </summary>
    private static async Task<bool> TryProvisionNodeAsync(string home)
    {
        try
        {
            var report = await PreflightService.DetectRuntimeAsync(home);
            // 探测到了就不必下载（例如环境变量/常见位置刚刚才可用）：让调用方直接重试启动
            if (report.Ok) return true;

            return await PreflightPresenter.EnsurePortableNodeAsync(home, report.Message);
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"[Preflight] 自动获取 Node 运行时失败：{ex}");
            return false;
        }
    }

    private void OnBackendExited(object? sender, string reason)
    {
        if (AppServices.IsReady)
        {
            AppServices.State.MarkBackendDown(reason);
        }

        AppServices.Toast.Error("后端已断开", reason);
    }

    private async void OnMainWindowClosed(object sender, WindowEventArgs args)
    {
        // 诊断：WinUI 3 在最后一个窗口关闭时退出进程。若退出不是用户点的，
        // 这条记录能立刻区分"程序化关窗"与"原生崩溃"（后者不会有这条）。
        WriteCrashLog(new InvalidOperationException(
            "DIAG OnMainWindowClosed：窗口已关闭，应用即将退出。若用户未主动关闭，则为程序化关窗。"));

        if (_bridge is null)
        {
            return;
        }

        // 先解绑推送：桥接进程会在自己的读线程上回调，窗口都关了还往里推没有意义。
        if (AppServices.IsReady)
        {
            AppServices.State.DetachRuntimePushes();
        }

        try
        {
            await _bridge.DisposeAsync();
        }
        catch
        {
            // 关闭路径上的异常没有处置价值（进程即将退出），但不吞掉到影响退出
        }
    }

    /// <summary>
    /// 桥接入口：随应用分发的 <c>bridge/server.cjs</c>（由 <c>scripts/build-bridge.mjs</c> 产出，
    /// csproj 以 <c>None ... CopyToOutputDirectory</c> 复制到输出目录）。
    /// </summary>
    private static string ResolveBridgeEntry()
    {
        var entry = Path.Combine(AppContext.BaseDirectory, "bridge", "server.cjs");
        if (!File.Exists(entry))
        {
            throw new FileNotFoundException(
                $"未找到桥接入口 {entry}。请先运行 `node scripts/build-bridge.mjs` 生成 dist/bridge/server.cjs 并重新构建应用。",
                entry);
        }

        return entry;
    }

    /// <summary>
    /// 数据根目录（含 instances / engines / cache / logs / launcher.json）。
    ///
    /// **必须与 core 用同一个环境变量**：<c>WHALES_LAUNCHER_ROOT</c> 既是 C# 侧的选择依据，
    /// 也是 <c>CoreBridge</c> 注入给 Node 子进程、供 core 定位缓存目录的变量
    /// （见 <c>CoreBridge.cs:647</c> 与 <c>ResolveDefaultHome()</c>）。
    /// 这里曾经另立了 <c>WHALES_ROOT</c>，导致同一进程里存在**两套根解析**、可能得到两个不同的根 ——
    /// 那会让"界面读到的实例"与"core 实际操作的实例"不是同一批（QA 隔离环境下尤其危险）。现已统一。
    ///
    /// 解析顺序：
    /// ① <c>WHALES_LAUNCHER_ROOT</c> —— 与 core 共用，生产与 QA 都用它；
    /// ② <c>WHALES_ROOT</c> —— 仅留作测试期覆盖，优先级低于 ①，不推荐新用法；
    /// ③ <c>CoreBridge.ResolveDefaultHome()</c> —— 兜底，复用该类既有的启发式，避免第三套逻辑。
    /// </summary>
    private static string ResolveRootDirectory()
    {
        var fromCore = Environment.GetEnvironmentVariable("WHALES_LAUNCHER_ROOT");
        if (!string.IsNullOrWhiteSpace(fromCore) && Directory.Exists(fromCore))
        {
            return Path.GetFullPath(fromCore);
        }

        var fromOverride = Environment.GetEnvironmentVariable("WHALES_ROOT");
        if (!string.IsNullOrWhiteSpace(fromOverride) && Directory.Exists(fromOverride))
        {
            return Path.GetFullPath(fromOverride);
        }

        return CoreBridge.ResolveDefaultHome();
    }
}

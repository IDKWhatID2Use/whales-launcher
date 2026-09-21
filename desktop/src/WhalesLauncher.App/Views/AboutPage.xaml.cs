using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using WhalesLauncher.Services;

namespace WhalesLauncher.Views;

/// <summary>
/// 「关于」页（左栏底部固定项的落点，交接文档 §2.2 方案 A）。
///
/// 职责只有一件事：把启动器"是什么版本、跑在什么框架上、依赖哪个 Node、装了哪些引擎、
/// 东西都放在哪"如实显示出来。全部取值来自已有状态源与通道，页面**不自己发请求**：
/// 这一页没有任何网络副作用，也不重复「全局设置」里的探测与安装动作。
///
/// 未就绪时的表现是刻意设计的：每一行都写清"为什么现在是空的"（未探测 / 后端未就绪），
/// 而不是留空白 —— 空白会让人以为这一页坏了（规范 §9.0：状态必须可见）。
/// </summary>
public sealed partial class AboutPage : Page
{
    /// <summary>页面上"后端还没给出值"时的统一占位文案。</summary>
    private const string BackendMissing = "尚未取得（后端未就绪）";

    public AboutPage()
    {
        InitializeComponent();

        // 在 Loaded 里取值而不是构造函数里：
        //  · 外壳是"先建窗口、后装后端"（App.xaml.cs），深链直达本页时构造函数跑在后端就绪之前；
        //  · Frame 每次导航都会新建页面实例，因此从别处回到本页一定会重新走一遍这里，
        //    后端后来才装载好的版本/引擎信息不会永远停在占位文案上。
        Loaded += OnLoaded;
    }

    private void OnLoaded(object sender, RoutedEventArgs e) => Refresh();

    private void Refresh()
    {
        var state = AppServices.IsReady ? AppServices.State : null;

        LauncherVersionText.Text = OrFallback(state?.AppVersion, BackendMissing);
        UiFrameworkText.Text = UiFramework();
        NodeRuntimeText.Text = NodeRuntime(state);
        EnginesText.Text = Engines(state);
        RootDirText.Text = OrFallback(state?.Config?.RootDir, BackendMissing);
        PrimaryHomeText.Text = OrFallback(state?.Config?.PrimaryHome, BackendMissing);
    }

    /// <summary>
    /// 界面框架：从**正在运行的程序集**读版本，而不是写死一串数字 ——
    /// 写死的版本号会在升级 WindowsAppSDK 之后立刻变成假信息。
    /// </summary>
    private static string UiFramework()
    {
        var version = typeof(Microsoft.UI.Xaml.Application).Assembly.GetName().Version;

        // 版本信息拿不到不是错误（裁剪/单文件发布等场景），退化成不带版本的说法即可。
        return version is null ? "WinUI 3" : $"WinUI 3（Microsoft.WinUI {version.ToString(3)}）";
    }

    /// <summary>Node 运行时：只有「全局设置」探测过才有结论，这里如实区分"未探测"与"探测失败"。</summary>
    private static string NodeRuntime(AppState? state)
    {
        var report = state?.NodeRuntime;

        if (report is null)
        {
            return "未探测（在「全局设置 → Node 运行时」里点「重新探测 Node」）";
        }

        if (!report.Ok)
        {
            return string.IsNullOrWhiteSpace(report.Message) ? "不可用" : $"不可用：{report.Message}";
        }

        var version = string.IsNullOrWhiteSpace(report.Version) ? "已探测到可用运行时" : report.Version!;
        return string.IsNullOrWhiteSpace(report.File) ? version : $"{version} · {report.File}";
    }

    /// <summary>已安装的 dsh 引擎版本（engine:list 的结论；引擎是实例能启动的前提，值得摆在首页）。</summary>
    private static string Engines(AppState? state)
    {
        var engines = state?.Engines;
        if (engines is null || engines.Count == 0)
        {
            return "尚未安装（可在「引擎版本管理」里安装）";
        }

        var versions = engines
            .Where(engine => engine.Installed)
            .Select(engine => engine.Version)
            .Where(version => !string.IsNullOrWhiteSpace(version))
            .ToList();

        return versions.Count == 0
            ? "尚未安装（可在「引擎版本管理」里安装）"
            : $"已安装 {versions.Count} 个版本：{string.Join("、", versions)}";
    }

    private static string OrFallback(string? value, string fallback) =>
        string.IsNullOrWhiteSpace(value) ? fallback : value!;
}

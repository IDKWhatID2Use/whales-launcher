using System.Diagnostics;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using WhalesLauncher.Controls;
using WhalesLauncher.Models;
using WhalesLauncher.Services;

namespace WhalesLauncher.Shell;

/// <summary>
/// 环境自检的**呈现与启动编排**（UI 归这一层，逻辑在 <see cref="PreflightService"/>）。
///
/// ### 首次启动做什么
/// <list type="number">
///   <item>跑一次轻量自检（本地修复 + registry 探测，秒级）—— 得到"缺什么"；</item>
///   <item>若缺引擎：先问一次（说明会联网、耗时、不能取消），同意后跑深度自检自动安装；</item>
///   <item>首次（core 侧判定 <c>firstRun</c>）弹一次报告；之后启动只在仍有问题时给一条轻提示。</item>
/// </list>
///
/// ### 为什么"装引擎"要先问一句
/// 这一步会联网下载数百 MB 且中途不可取消。规范 §9.9/§11-U19 的要求是：**不要让用户
/// 按一个按不动的取消按钮**，而是在开始前就把"能不能取消、要花多久"讲清楚。
/// 一次确认换来的是"启动器不会在我不知情时下载几百兆"。
///
/// ### 线程
/// 全部入口都由外壳在 UI 线程调用（<c>MainWindow.EnterBackendReadyAsync</c>），
/// <c>await</c> 之后的续体仍在 UI 线程，因此可以直接碰 XAML。仅**下载与解压**被
/// <see cref="NodeProvisioner"/> 放到后台线程（规范 §7.6：UI 线程禁止做文件遍历/解压）。
/// </summary>
public sealed class PreflightPresenter
{
    /// <summary>首启编排只做一次（外壳的 Loaded 可能重复触发）。</summary>
    private bool _startupRan;

    /// <summary>
    /// 启动编排（外壳在后端就绪后调用一次）。
    ///
    /// **不抛错**：自检的任何失败都不该让外壳的初始化路径炸掉，最坏情况是一条错误提示。
    /// </summary>
    public async Task RunStartupAsync()
    {
        if (_startupRan) return;
        _startupRan = true;
        if (!AppServices.IsReady) return;

        var root = AppServices.Bridge.Home;
        if (string.IsNullOrWhiteSpace(root)) return;

        try
        {
            var quick = await PreflightService.RunAsync(new PreflightOptions
            {
                AutoFix = true,
                CheckNetwork = true,
            });

            if (!quick.Ok || quick.Value is null)
            {
                // 桥接刚起来就失败（例如后端已断开）：给一条提示即可，不弹模态框打断首次使用
                AppServices.Toast.Warning("环境自检未能完成", quick.Error ?? "后端未返回原因。");
                return;
            }

            var report = quick.Value;

            var engine = report.Find("engine");
            if (engine is not null && engine.NeedsAttention && await ConfirmEngineInstallAsync(engine))
            {
                AppServices.Toast.Info(
                    "正在自动安装 dsh 引擎",
                    "这一步会联网下载数百 MB，可能需要几分钟。进度可在运行日志（Ctrl+L）里看到。");

                var deep = await PreflightService.RunAsync(new PreflightOptions
                {
                    AutoFix = true,
                    InstallEngine = true,
                });

                if (deep.Ok && deep.Value is not null) report = deep.Value;
                else AppServices.Toast.Error("自动安装 dsh 引擎失败", deep.Error ?? "后端未返回原因。");
            }

            if (report.FirstRun)
            {
                await ShowReportAsync(report, firstRun: true);
                return;
            }

            // 非首次：不打扰。只在仍有待处理项时给一条可忽略的提示（规范 §9.0：错误不得只进日志）
            if (report.ProblemCount > 0)
            {
                AppServices.Toast.Warning(
                    $"环境自检发现 {report.ProblemCount} 项待处理",
                    "详情见「全局设置 → 环境自检」。");
            }
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"[Preflight] 启动自检异常：{ex}");
            AppServices.Toast.Error("环境自检未能完成", ex.Message);
        }
    }

    /// <summary>
    /// 弹一次自检报告。
    /// @param report 报告。
    /// @param firstRun 是否首次（决定标题与底部说明）。
    /// </summary>
    public static async Task ShowReportAsync(PreflightReport report, bool firstRun)
    {
        if (!await AppServices.Dialogs.WaitForAttachAsync(PreflightService.ShellAttachTimeout)) return;

        try
        {
            var view = new PreflightReportView();
            view.Render(
                report,
                null,
                firstRun
                    ? "之后每次启动都会自动做一次本地检查，发现问题会提示你；也可以随时在「全局设置 → 环境自检」里手动运行。"
                    : null);

            var dialog = AppServices.Dialogs.Create(firstRun ? "首次环境自检" : "环境自检", string.Empty);
            dialog.Content = new ScrollViewer
            {
                Content = view,
                MaxHeight = 520,
                VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                HorizontalScrollMode = ScrollMode.Disabled,
                /*
                 * 右侧预留 16（4 的倍数，规范 §2.1）。
                 *
                 * 为什么必须留：WinUI 3 的滚动条是**覆盖式**的 —— 它浮在内容之上、不占布局空间，
                 * 所以报告里那些长行（"建议：…"与候选清单）的右端会被压在滚动条下面。
                 * 留白在无需滚动时只是一点右边距，比"内容被挡"要好得多。
                 */
                Padding = new Thickness(0, 0, 16, 0),
            };
            dialog.CloseButtonText = "知道了";
            dialog.DefaultButton = ContentDialogButton.Close;
            await dialog.ShowAsync();
        }
        catch (Exception ex)
        {
            // 同一窗口同时只能有一个 ContentDialog：竞态下放弃弹窗，改用提示（不能因此崩掉外壳）
            Debug.WriteLine($"[Preflight] 报告对话框未能打开：{ex.Message}");
            AppServices.Toast.Info("环境自检已完成", report.Message);
        }
    }

    /// <summary>
    /// 缺引擎时的一次确认。
    /// @param engine 引擎检查项（用于把"缺的是引擎"写进说明）。
    /// @returns 用户是否选择现在自动安装。
    /// </summary>
    private static async Task<bool> ConfirmEngineInstallAsync(PreflightCheck engine)
    {
        if (!await AppServices.Dialogs.WaitForAttachAsync(PreflightService.ShellAttachTimeout)) return false;

        try
        {
            var dialog = AppServices.Dialogs.Create(
                "还没有安装 dsh 引擎",
                "实例需要至少一个 dsh 引擎版本才能创建与启动。\n\n" +
                "现在自动安装的话：启动器会用 npm 安装 registry 上的最新版，需要联网并下载数百 MB，" +
                "视网速可能耗时几分钟；**这一步开始后无法中途取消**（可以在运行日志里看进度）。\n\n" +
                "你也可以选「稍后自己装」，到「引擎版本管理」页手动安装。");
            dialog.PrimaryButtonText = "现在自动安装";
            dialog.CloseButtonText = "稍后自己装";
            dialog.DefaultButton = ContentDialogButton.Primary;

            var result = await dialog.ShowAsync();
            return result == ContentDialogResult.Primary;
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"[Preflight] 引擎安装确认框未能打开：{ex.Message}");
            return false;
        }
    }

    /// <summary>
    /// 【启动阶段专用】没有可用 Node 时，问一次并自动下载便携版。
    ///
    /// 调用点是 <c>App.BootBackendAsync</c> 的失败路径：那时后端**根本起不来**
    /// （侧车进程要靠 Node 才能跑），因此这件事没法交给后端自检，只能由宿主自己做。
    /// 也正因如此，本方法必须是 <c>static</c>：那一刻还没有外壳实例，只有
    /// <see cref="AppServices.Dialogs"/> 这一条能弹 UI 的通道。
    /// @param root 启动器根目录（自备运行时落在 <c>&lt;root&gt;/runtime/node</c>）。
    /// @param reason 为什么需要（原样展示给用户，来自运行时探测报告）。
    /// @returns 是否已获得可用的自备运行时。
    /// </summary>
    public static async Task<bool> EnsurePortableNodeAsync(string root, string reason)
    {
        if (string.IsNullOrWhiteSpace(root)) return false;
        if (!await AppServices.Dialogs.WaitForAttachAsync(PreflightService.ShellAttachTimeout))
        {
            Debug.WriteLine("[Preflight] 窗口尚未挂载 XamlRoot，跳过便携版 Node 的确认与下载。");
            return false;
        }

        try
        {
            var confirm = AppServices.Dialogs.Create(
                "没有找到可用的 Node.js 运行时",
                "启动器的全部功能都由一个 Node 进程执行，而这台机器上目前没有可用的 Node.js。\n\n" +
                "可以自动下载一份官方 Node 便携版放在启动器目录里（约 30MB，使用 v22 LTS）：\n" +
                "· 不需要管理员权限，也不改动系统设置；\n" +
                "· 随启动器目录一起存在，卸载时删掉目录即可；\n" +
                "· 之后如需换用自己安装的 Node，可在「全局设置 → Node 可执行文件路径」里指定。\n\n" +
                $"探测结论：{reason}");
            confirm.PrimaryButtonText = "自动下载";
            confirm.CloseButtonText = "暂不处理";
            confirm.DefaultButton = ContentDialogButton.Primary;

            if (await confirm.ShowAsync() != ContentDialogResult.Primary) return false;

            return await DownloadPortableNodeAsync(root);
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"[Preflight] 便携版 Node 流程异常：{ex}");
            AppServices.Toast.Error("自动获取 Node 运行时失败", ex.Message);
            return false;
        }
    }

    /// <summary>
    /// 下载并铺设便携版 Node，期间用一个不可取消的进度对话框说明"在做什么"。
    ///
    /// 进度对话框刻意**不给取消按钮**：后端没有取消下载的通道，给一个按不动的取消键
    /// 比不给更糟（规范 §11-U19）。用户随时可以按 Esc 收起对话框，下载在后台继续。
    /// @param root 启动器根目录。
    /// @returns 是否已就位。
    /// </summary>
    private static async Task<bool> DownloadPortableNodeAsync(string root)
    {
        var bar = new ProgressBar
        {
            IsIndeterminate = true,
            Minimum = 0,
            Maximum = 100,
            HorizontalAlignment = HorizontalAlignment.Stretch,
        };
        var caption = new TextBlock
        {
            Text = "正在准备…",
            TextWrapping = TextWrapping.Wrap,
        };
        var note = new TextBlock
        {
            Text = "共约 30MB。这一步不能中途取消；下载完成后会自动验证并启用。",
            TextWrapping = TextWrapping.Wrap,
            Foreground = (Microsoft.UI.Xaml.Media.Brush)Application.Current.Resources["TextFillColorTertiaryBrush"],
        };
        var panel = new StackPanel { Spacing = 8 };
        panel.Children.Add(bar);
        panel.Children.Add(caption);
        panel.Children.Add(note);

        var dialog = AppServices.Dialogs.Create("正在获取 Node 运行时", string.Empty);
        dialog.Content = panel;
        dialog.CloseButtonText = string.Empty;

        // 不 await：下载要在它显示着的时候进行；结束时用 Hide() 收掉（用户先按 Esc 关掉也无妨）
        _ = dialog.ShowAsync();
        var progress = new Progress<NodeProvisionProgress>(update =>
        {
            if (!string.IsNullOrWhiteSpace(update.Message)) caption.Text = update.Message;
            // 总量未知时不假装知道：保持不确定态，而不是画一个从 0 蹦到 100 的假进度
            if (update.TotalBytes is > 0)
            {
                bar.IsIndeterminate = false;
                bar.Value = update.Percent;
            }
            else
            {
                bar.IsIndeterminate = true;
            }
        });

        NodeProvisionResult result;
        try
        {
            result = await PreflightService.EnsurePortableNodeAsync(root, progress);
        }
        finally
        {
            try
            {
                dialog.Hide();
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[Preflight] 关闭进度对话框失败：{ex.Message}");
            }
        }

        if (result.Ok)
        {
            AppServices.Toast.Success(
                $"已启用自备 Node {result.Version}",
                result.AlreadyPresent ? "复用已有的自备运行时。" : "接下来启动器会自动使用它启动后端。");
            return true;
        }

        AppServices.Toast.Error(
            "自动获取 Node 运行时失败",
            $"{result.Error}\n也可以自行安装 Node.js 20+ 后在「全局设置 → Node 可执行文件路径」里指定。");
        return false;
    }
}

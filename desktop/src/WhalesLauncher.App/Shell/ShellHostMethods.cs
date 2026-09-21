using System.Diagnostics;
using System.Text.Json;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using WhalesLauncher.Services;
using Windows.Storage;
using Windows.Storage.Pickers;
using Windows.System;
using WinRT.Interop;

namespace WhalesLauncher.Shell;

/// <summary>
/// 宿主方法（桥接协议 §3.3）：Node 侧车进程做不到、必须由 C# 宿主提供的能力。
///
/// **为什么集中由外壳注册一次**：<c>host:</c> 方法名是全局唯一的注册键，
/// 若各页面自行注册，后注册的会覆盖先注册的，表现为"某个页面的选择文件对话框忽然不工作"。
/// 因此全部 8 条统一在这里注册。
///
/// 线程模型：这些处理器由 <c>CoreBridge</c> 在读线程上调用（<c>ConfigureAwait(false)</c>），
/// 而选择器 / <c>Launcher</c> / <c>ContentDialog</c> 都要求 ASTA（UI）线程，
/// 因此统一经 <see cref="RunOnUiAsync"/> 汇入 UI 线程。
///
/// 取消语义：Node 侧的 <c>string | null</c> 里 <c>null</c> = 用户取消（协议 §3.3），
/// 所以取消**不是**错误，返回 null 即可；只有真正的失败才抛异常（由 CoreBridge 转成 <c>ok:false</c>）。
/// </summary>
public static class ShellHostMethods
{
    public static void Register(CoreBridge bridge, Window window)
    {
        ArgumentNullException.ThrowIfNull(bridge);
        ArgumentNullException.ThrowIfNull(window);

        bridge.RegisterHostMethod(Channels.Host.PickArchive, args => PickFileAsync(window, args, new[] { ".zip" }));
        bridge.RegisterHostMethod(Channels.Host.PickFolder, args => PickFolderAsync(window, args));
        bridge.RegisterHostMethod(Channels.Host.PickPackFile, args => PickFileAsync(window, args, new[] { ".zip", ".wlpack" }));
        bridge.RegisterHostMethod(Channels.Host.SaveFile, args => SaveFileAsync(window, args));
        bridge.RegisterHostMethod(Channels.Host.DownloadsDir, _ => Task.FromResult<object?>(DownloadsDir()));
        bridge.RegisterHostMethod(Channels.Host.OpenPath, OpenPathAsync);
        bridge.RegisterHostMethod(Channels.Host.OpenExternal, args => OpenExternalAsync(window, args));
        bridge.RegisterHostMethod(Channels.Host.MessageBox, args => MessageBoxAsync(window, args));
    }

    /* ------------------------------------------------------------------ *
     * 选择器
     * ------------------------------------------------------------------ */

    private static Task<object?> PickFileAsync(Window window, JsonElement[] args, string[] extensions)
        => RunOnUiAsync(window, async () =>
        {
            var picker = new FileOpenPicker
            {
                SuggestedStartLocation = PickerLocationId.Downloads,
                ViewMode = PickerViewMode.List,
            };

            foreach (var extension in extensions)
            {
                picker.FileTypeFilter.Add(extension);
            }

            // unpackaged（WindowsPackageType=None）下必须先绑定窗口，否则 PickSingleFileAsync 抛异常
            InitializeWithWindow.Initialize(picker, WindowNative.GetWindowHandle(window));

            var file = await picker.PickSingleFileAsync();

            // 注意：经典 picker 没有标题 API，Node 传来的 {title} 无法生效（见 W-SHELL 回复中的未落实项）
            Debug.WriteLine($"[shell] host 选择器已弹出（title={StringArg(args, 0, "title") ?? "（未提供）"}，filters={string.Join(',', extensions)}）");
            return file?.Path;
        }, "打开文件选择器");

    private static Task<object?> PickFolderAsync(Window window, JsonElement[] args)
        => RunOnUiAsync(window, async () =>
        {
            var picker = new FolderPicker { SuggestedStartLocation = PickerLocationId.Downloads };

            // FolderPicker 必须至少有一个 FileTypeFilter，否则 PickSingleFolderAsync 会抛异常
            picker.FileTypeFilter.Add("*");
            InitializeWithWindow.Initialize(picker, WindowNative.GetWindowHandle(window));

            var folder = await picker.PickSingleFolderAsync();
            Debug.WriteLine($"[shell] host 文件夹选择器已弹出（title={StringArg(args, 0, "title") ?? "（未提供）"}）");
            return folder?.Path;
        }, "打开文件夹选择器");

    private static Task<object?> SaveFileAsync(Window window, JsonElement[] args)
        => RunOnUiAsync(window, async () =>
        {
            var suggestedName = StringArg(args, 0, "suggestedName") ?? "export";
            var extension = Path.GetExtension(suggestedName);
            if (string.IsNullOrEmpty(extension))
            {
                extension = ".wlpack";
            }

            var picker = new FileSavePicker
            {
                SuggestedStartLocation = PickerLocationId.Downloads,
                SuggestedFileName = Path.GetFileNameWithoutExtension(suggestedName),
            };
            picker.FileTypeChoices.Add("WhalesLauncher 实例包", new List<string> { extension });
            InitializeWithWindow.Initialize(picker, WindowNative.GetWindowHandle(window));

            var file = await picker.PickSaveFileAsync();
            return file?.Path;
        }, "打开保存对话框");

    /* ------------------------------------------------------------------ *
     * 环境与打开
     * ------------------------------------------------------------------ */

    private static string DownloadsDir()
    {
        try
        {
            // KnownFolders 没有 Downloads 成员（"已知文件夹"枚举里不存在这一项）；
            // UserDataPaths 才是能拿到下载目录的公开 API（对应旧实现 app.getPath('downloads')）。
            return Windows.Storage.UserDataPaths.GetDefault().Downloads;
        }
        catch (Exception)
        {
            // 无包标识（unpackaged）或用户改过"下载"位置时可能失败：退回用户目录下的 Downloads，
            // 返回一个**存在**的目录比抛错更有用（Node 侧要拿它当默认导出目录）。
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
        }
    }

    private static Task<object?> OpenPathAsync(JsonElement[] args)
    {
        var path = StringArg(args, 0, "path");
        if (string.IsNullOrWhiteSpace(path))
        {
            throw new InvalidOperationException("host:openPath 缺少 path 参数。");
        }

        // 先判存在：交给系统外壳打开一个不存在的路径会静默失败，
        // 而 Node 侧会把"无异常"当成"已经打开了目录"（协议 §3.3 的取舍要求失败必须显式）
        if (!Directory.Exists(path) && !File.Exists(path))
        {
            throw new InvalidOperationException($"路径不存在：{path}");
        }

        Process.Start(new ProcessStartInfo { FileName = path, UseShellExecute = true });
        return Task.FromResult<object?>(null);
    }

    private static Task<object?> OpenExternalAsync(Window window, JsonElement[] args)
    {
        var url = StringArg(args, 0, "url");

        // 协议 §3.3 的硬安全边界：C# 侧**独立再校验一次** scheme，不信任 Node 传来的一层校验。
        // 复用 CoreBridge 的同一份实现，避免两处规则漂移。
        if (!CoreBridge.IsAllowedExternalUrl(url, out var reason))
        {
            throw new InvalidOperationException(reason ?? "链接不被允许。");
        }

        return RunOnUiAsync(window, async () =>
        {
            if (!await Launcher.LaunchUriAsync(new Uri(url!)))
            {
                throw new InvalidOperationException($"系统未能打开链接：{url}");
            }

            return null;
        }, "打开外部链接");
    }

    /* ------------------------------------------------------------------ *
     * 消息框
     * ------------------------------------------------------------------ */

    private static Task<object?> MessageBoxAsync(Window window, JsonElement[] args)
        => RunOnUiAsync(window, async () =>
        {
            var title = StringArg(args, 0, "title") ?? "WhalesLauncher";
            var message = StringArg(args, 0, "message") ?? string.Empty;
            var detail = StringArg(args, 0, "detail");
            var buttons = StringArray(args, 0, "buttons");

            var dialog = AppServices.Dialogs.Create(title, message);
            if (!string.IsNullOrEmpty(detail))
            {
                dialog.Content = new TextBlock
                {
                    Text = $"{message}\n\n{detail}",
                    TextWrapping = TextWrapping.Wrap,
                };
            }

            // 按钮角色由数组顺序决定（返回值是**下标**，与 Electron showMessageBoxSync 一致）：
            // 1 个 → Close；2 个 → Primary + Close；3 个 → Primary + Secondary + Close（§6.4 要求至少一个安全出口）
            switch (buttons.Count)
            {
                case <= 1:
                    dialog.CloseButtonText = buttons.Count == 1 ? buttons[0] : "确定";
                    break;
                case 2:
                    dialog.PrimaryButtonText = buttons[0];
                    dialog.CloseButtonText = buttons[1];
                    dialog.DefaultButton = ContentDialogButton.Close;
                    break;
                default:
                    dialog.PrimaryButtonText = buttons[0];
                    dialog.SecondaryButtonText = buttons[1];
                    dialog.CloseButtonText = buttons[2];
                    dialog.DefaultButton = ContentDialogButton.Close;
                    break;
            }

            var result = await dialog.ShowAsync();

            // Esc / 手柄 B / 系统返回都会走 CloseButton（§6.4），因此统一映射回 Close 的下标
            object? index = result switch
            {
                ContentDialogResult.Primary => 0,
                ContentDialogResult.Secondary => 1,
                _ => buttons.Count switch { <= 1 => 0, 2 => 1, _ => 2 },
            };
            return index;
        }, "显示消息框");

    /* ------------------------------------------------------------------ *
     * 参数与线程
     * ------------------------------------------------------------------ */

    private static string? StringArg(JsonElement[] args, int index, string property)
    {
        if (args.Length <= index || args[index].ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        return args[index].TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
    }

    private static IReadOnlyList<string> StringArray(JsonElement[] args, int index, string property)
    {
        if (args.Length <= index || args[index].ValueKind != JsonValueKind.Object)
        {
            return Array.Empty<string>();
        }

        if (!args[index].TryGetProperty(property, out var value) || value.ValueKind != JsonValueKind.Array)
        {
            return Array.Empty<string>();
        }

        var list = new List<string>();
        foreach (var item in value.EnumerateArray())
        {
            if (item.ValueKind == JsonValueKind.String && item.GetString() is { } text)
            {
                list.Add(text);
            }
        }

        return list;
    }

    /// <summary>
    /// 把工作汇入 UI 线程。宿主方法由桥接读线程调用，而选择器 / Launcher / ContentDialog
    /// 都要求 ASTA 线程；这里不做同步等待（禁止 .Result / .Wait，规范 §8）。
    /// </summary>
    private static Task<object?> RunOnUiAsync(Window window, Func<Task<object?>> work, string what)
    {
        var queue = window.DispatcherQueue;
        var completion = new TaskCompletionSource<object?>(TaskCreationOptions.RunContinuationsAsynchronously);

        if (queue is null || !queue.TryEnqueue(async () =>
            {
                try
                {
                    completion.TrySetResult(await work());
                }
                catch (Exception ex)
                {
                    completion.TrySetException(ex);
                }
            }))
        {
            completion.TrySetException(new InvalidOperationException($"UI 线程不可用，无法{what}。"));
        }

        return completion.Task;
    }
}

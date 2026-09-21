using System.Diagnostics;
using System.IO.Compression;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;

namespace WhalesLauncher.Services;

/// <summary>
/// 便携版 Node 的自动获取（"系统一个 Node 都没有"时的兜底）。
///
/// ### 为什么需要它
/// 启动器把**全部业务逻辑**放在 Node 侧车进程里，而侧车本身要靠真正的 Node.js 才能起来
/// （见 <see cref="NodeRuntimeLocator"/> 的类注释：Electron 内置运行时会被 dsh 的原生模块
/// 按指纹拒绝）。因此"这台机器没装 Node"= 启动器完全不可用 —— 而源码运行/绿色分发的用户
/// 恰恰经常没装。用户在此之前只能自己去 nodejs.org 下载安装包、选 MSI、点下一步，
/// 这与"减少用户需要动手的部分"直接冲突。
///
/// 本类的做法：从 Node 官方发行目录下载 **Windows x64 zip（约 30MB）**，校验官方公布的
/// SHA-256，解压到 <c>&lt;启动器根&gt;/runtime/node/</c>。选 zip 而不是 MSI 的理由：
///  - **不需要管理员权限**（MSI 装到 Program Files 会弹 UAC，用户仍要动手）；
///  - **不污染系统**（不动注册表、不改系统 PATH、不留卸载项），删掉目录即彻底移除；
///  - zip 里自带 <c>npm.cmd</c> + <c>node_modules/npm</c>，所以"装了 Node 却没有 npm"
///    这个常见坑也一并消失（core 侧会把该目录登记为额外命令目录，见 <c>src/core/proc.ts</c>）。
///
/// ### 版本选择
/// 固定取 **v22 LTS** 分支的 <c>latest-v22.x</c>：dsh 要求 Node ≥ 20，而 LTS 分支比
/// "当前最新版"更适合做默认（不会某天突然跳到新的主版本）。
///
/// ### 镜像回退
/// 官方源不可达时回退到 npmmirror 的 Node 二进制镜像（国内网络下的常见选择）。
/// 两个源都把 SHA-256 摘要一起取回来 —— 校验用的是**同一份摘要文本**，因此没有任何
/// "为了走镜像就跳过校验"的路径。
/// </summary>
public static class NodeProvisioner
{
    /// <summary>启动器自备运行时目录名（与 <c>src/core/paths.ts</c> 的 <c>RUNTIME_DIR_NAME</c> 一致）。</summary>
    public const string RuntimeDirName = "runtime";

    /// <summary>自备 Node 的子目录名（与 <c>src/core/paths.ts</c> 的 <c>portableNodeDir</c> 一致）。</summary>
    public const string NodeDirName = "node";

    /// <summary>下载中途使用的临时文件名（结束后删除）。</summary>
    private const string ArchiveName = "node-archive.zip";

    /// <summary>Node LTS 分支（取该分支的 latest）。</summary>
    private const string ReleaseBranch = "latest-v22.x";

    /// <summary>下载源（按顺序尝试）。</summary>
    private static readonly string[] Sources =
    {
        "https://nodejs.org/dist/" + ReleaseBranch + "/",
        "https://registry.npmmirror.com/-/binary/node/" + ReleaseBranch + "/",
    };

    /// <summary>共享的 HttpClient（大文件下载；单次请求 10 分钟上限）。</summary>
    private static readonly HttpClient Http = CreateHttpClient();

    /// <summary>自备 Node 目录：<c>&lt;root&gt;/runtime/node</c>。</summary>
    public static string PortableNodeDir(string root) => Path.Combine(root, RuntimeDirName, NodeDirName);

    /// <summary>自备 Node 可执行文件：<c>&lt;root&gt;/runtime/node/node.exe</c>。</summary>
    public static string PortableNodeExe(string root) => Path.Combine(PortableNodeDir(root), "node.exe");

    /// <summary>自备 Node 是否已就位（只判存在；可用性由探针另行验证）。</summary>
    public static bool IsInstalled(string root) => File.Exists(PortableNodeExe(root));

    /// <summary>
    /// 确保本机有一份可用的 Node：优先复用已铺设的自备运行时，否则下载并解压。
    ///
    /// **不负责**决定"要不要下载"（那是界面的事）—— 本方法一旦被调用就会尽力完成。
    /// @param root 启动器根目录。
    /// @param progress 进度回调（阶段 + 字节数）；可为 null。
    /// @param ct 取消令牌。
    /// @returns 结果（失败时 <see cref="NodeProvisionResult.Error"/> 是可直接展示的中文原因）。
    /// </summary>
    public static async Task<NodeProvisionResult> EnsureAsync(
        string root,
        IProgress<NodeProvisionProgress>? progress = null,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(root)) throw new ArgumentException("启动器根目录为空。", nameof(root));

        var target = PortableNodeExe(root);
        if (File.Exists(target))
        {
            var existing = await ProbeAsync(target, ct).ConfigureAwait(false);
            if (existing is not null)
            {
                return new NodeProvisionResult
                {
                    Ok = true,
                    File = target,
                    Version = existing,
                    AlreadyPresent = true,
                };
            }

            // 目录在但跑不起来（下载被中断/杀毒软件隔离）：清掉重来，而不是把坏运行时留给用户
            progress?.Report(new NodeProvisionProgress
            {
                Phase = NodeProvisionPhase.Cleaning,
                Message = "已存在的自备运行时无法执行，重新下载。",
            });
            await DeleteDirectoryAsync(PortableNodeDir(root)).ConfigureAwait(false);
        }

        var staging = Path.Combine(root, RuntimeDirName, "node-staging");
        var archive = Path.Combine(root, RuntimeDirName, ArchiveName);
        try
        {
            Directory.CreateDirectory(Path.Combine(root, RuntimeDirName));

            var release = await ResolveReleaseAsync(progress, ct).ConfigureAwait(false);
            if (release is null)
            {
                return Failure("无法从 Node 官方发行源获取版本信息（网络不可达或被安全软件拦截）。");
            }

            progress?.Report(new NodeProvisionProgress
            {
                Phase = NodeProvisionPhase.Downloading,
                Message = $"正在下载 Node {release.Version}（{release.ArchiveName}）…",
                TotalBytes = release.SizeBytes,
            });

            var downloaded = await DownloadAsync(release, archive, progress, ct).ConfigureAwait(false);
            if (!downloaded.Ok)
            {
                return Failure(downloaded.Error ?? "下载 Node 运行时失败。");
            }

            progress?.Report(new NodeProvisionProgress
            {
                Phase = NodeProvisionPhase.Verifying,
                Message = "正在校验下载文件的 SHA-256…",
            });
            var actual = await Task.Run(() => Sha256OfFile(archive), ct).ConfigureAwait(false);
            if (!string.Equals(actual, release.Sha256, StringComparison.OrdinalIgnoreCase))
            {
                return Failure(
                    $"下载的 Node 压缩包校验失败（期望 {release.Sha256[..12]}…，实际 {actual[..12]}…）。" +
                    "文件可能在传输中损坏；请重试，或改用「Node 可执行文件路径」手动指定本机已有的 Node。");
            }

            progress?.Report(new NodeProvisionProgress
            {
                Phase = NodeProvisionPhase.Extracting,
                Message = "正在解压…",
            });
            await DeleteDirectoryAsync(staging).ConfigureAwait(false);
            var extracted = await Task.Run(() => ExtractRuntime(archive, staging, root), ct).ConfigureAwait(false);
            if (!extracted.Ok)
            {
                return Failure(extracted.Error ?? "解压 Node 运行时失败。");
            }

            progress?.Report(new NodeProvisionProgress
            {
                Phase = NodeProvisionPhase.Verifying,
                Message = "正在验证新运行时…",
            });
            var version = await ProbeAsync(target, ct).ConfigureAwait(false);
            if (version is null)
            {
                await DeleteDirectoryAsync(PortableNodeDir(root)).ConfigureAwait(false);
                return Failure("解压完成，但新运行时无法执行（可能被安全软件拦截）。");
            }

            progress?.Report(new NodeProvisionProgress
            {
                Phase = NodeProvisionPhase.Done,
                Message = $"Node {version} 已就位。",
            });
            return new NodeProvisionResult { Ok = true, File = target, Version = version };
        }
        catch (OperationCanceledException)
        {
            return Failure("已取消。");
        }
        catch (Exception ex)
        {
            return Failure(ex.Message);
        }
        finally
        {
            // 临时产物一律不留：它们每个 30MB 级，且下次会重新下载
            TryDeleteFile(archive);
            await DeleteDirectoryAsync(staging).ConfigureAwait(false);
        }
    }

    /// <summary>构造失败结果。</summary>
    private static NodeProvisionResult Failure(string error) => new() { Ok = false, Error = error };

    /// <summary>创建 HttpClient（显式 UA；超时给大文件留足）。</summary>
    private static HttpClient CreateHttpClient()
    {
        var client = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("WhalesLauncher/1.0 (Node runtime bootstrap)");
        return client;
    }

    /// <summary>
    /// 取发行信息：先拿 <c>SHASUMS256.txt</c>（官方摘要清单），从中解析出 win-x64 包名与摘要。
    /// @param progress 进度回调。
    /// @param ct 取消令牌。
    /// @returns 发行信息；所有源都失败时返回 null。
    /// </summary>
    private static async Task<NodeRelease?> ResolveReleaseAsync(
        IProgress<NodeProvisionProgress>? progress,
        CancellationToken ct)
    {
        foreach (var source in Sources)
        {
            ct.ThrowIfCancellationRequested();
            try
            {
                var text = await Http.GetStringAsync(source + "SHASUMS256.txt", ct).ConfigureAwait(false);
                var release = ParseSums(text, source);
                if (release is not null) return release;
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[NodeProvisioner] 从 {source} 取摘要失败：{ex.Message}");
                progress?.Report(new NodeProvisionProgress
                {
                    Phase = NodeProvisionPhase.Resolving,
                    Message = $"该下载源不可用，正在尝试下一个（{ex.Message}）",
                });
            }
        }

        return null;
    }

    /// <summary>
    /// 解析 <c>SHASUMS256.txt</c>，挑出 Windows x64 的 zip。
    /// @param text 摘要文件内容（每行 <c>&lt;sha256&gt;  &lt;文件名&gt;</c>）。
    /// @param source 下载源基地址（用于拼完整 URL）。
    /// @returns 发行信息；没有 win-x64 条目时返回 null。
    /// </summary>
    internal static NodeRelease? ParseSums(string text, string source)
    {
        foreach (var rawLine in text.Split('\n'))
        {
            var line = rawLine.Trim();
            if (line.Length == 0) continue;
            var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length < 2) continue;

            var hash = parts[0];
            // 只在"两个 token"这种标准行上取值：某些行会把文件名放在后面并带路径
            var name = parts[^1].TrimStart('*');
            if (!name.EndsWith("-win-x64.zip", StringComparison.OrdinalIgnoreCase)) continue;
            if (hash.Length != 64) continue;

            var version = ExtractVersion(name);
            return new NodeRelease
            {
                Version = version ?? name,
                ArchiveName = name,
                Sha256 = hash.ToUpperInvariant(),
                Url = source + name,
                SizeBytes = null,
            };
        }

        return null;
    }

    /// <summary>从 <c>node-v22.20.0-win-x64.zip</c> 提取 <c>v22.20.0</c>。</summary>
    private static string? ExtractVersion(string archiveName)
    {
        var start = archiveName.IndexOf("-v", StringComparison.Ordinal);
        if (start < 0) return null;
        var rest = archiveName[(start + 1)..];
        var end = rest.IndexOf('-', StringComparison.Ordinal);
        return end <= 0 ? null : rest[..end];
    }

    /// <summary>
    /// 下载压缩包（流式读，报告进度）。
    /// @param release 发行信息。
    /// @param archive 落盘路径。
    /// @param progress 进度回调。
    /// @param ct 取消令牌。
    /// @returns 是否成功。
    /// </summary>
    private static async Task<(bool Ok, string? Error)> DownloadAsync(
        NodeRelease release,
        string archive,
        IProgress<NodeProvisionProgress>? progress,
        CancellationToken ct)
    {
        TryDeleteFile(archive);
        try
        {
            using var response = await Http
                .GetAsync(release.Url, HttpCompletionOption.ResponseHeadersRead, ct)
                .ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                return (false, $"下载失败：HTTP {(int)response.StatusCode}（{release.Url}）");
            }

            var total = response.Content.Headers.ContentLength;
            await using var source = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            await using var target = File.Create(archive);

            var buffer = new byte[81920];
            long received = 0;
            var lastReported = 0L;
            while (true)
            {
                var read = await source.ReadAsync(buffer, ct).ConfigureAwait(false);
                if (read <= 0) break;
                await target.WriteAsync(buffer.AsMemory(0, read), ct).ConfigureAwait(false);
                received += read;

                // 每 1MB 报一次：进度条足够顺滑，又不会把 UI 线程刷爆
                if (received - lastReported < 1024 * 1024) continue;
                lastReported = received;
                progress?.Report(new NodeProvisionProgress
                {
                    Phase = NodeProvisionPhase.Downloading,
                    Message = $"正在下载 Node {release.Version}…",
                    ReceivedBytes = received,
                    TotalBytes = total,
                });
            }

            progress?.Report(new NodeProvisionProgress
            {
                Phase = NodeProvisionPhase.Downloading,
                Message = $"正在下载 Node {release.Version}…",
                ReceivedBytes = received,
                TotalBytes = total ?? received,
            });
            return (true, null);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            return (false, $"下载失败：{ex.Message}");
        }
    }

    /// <summary>
    /// 解压到目标目录（剥掉压缩包里的顶层版本目录）。
    ///
    /// **必须在后台线程调用**：要搬 5000+ 个文件，放在 UI 线程上会直接把窗口冻住
    /// （视觉规范 §7.6 明确禁止 UI 线程做文件遍历/解压）。
    /// @param archive 压缩包路径。
    /// @param staging 解压暂存目录。
    /// @param root 启动器根目录。
    /// @returns 是否成功。
    /// </summary>
    private static (bool Ok, string? Error) ExtractRuntime(string archive, string staging, string root)
    {
        try
        {
            Directory.CreateDirectory(staging);
            ZipFile.ExtractToDirectory(archive, staging, overwriteFiles: true);

            // zip 里是单个顶层目录 node-vX.Y.Z-win-x64/；把它的**内容**搬到最终位置
            var entries = Directory.GetDirectories(staging);
            var sourceDir = entries.Length == 1 ? entries[0] : staging;
            if (!File.Exists(Path.Combine(sourceDir, "node.exe")))
            {
                return (false, "压缩包里没有 node.exe（下载源返回的内容不是预期的 Node 发行包）。");
            }

            var target = PortableNodeDir(root);
            Directory.CreateDirectory(target);
            foreach (var dir in Directory.GetDirectories(sourceDir, "*", SearchOption.AllDirectories))
            {
                Directory.CreateDirectory(Path.Combine(target, Path.GetRelativePath(sourceDir, dir)));
            }

            foreach (var file in Directory.GetFiles(sourceDir, "*", SearchOption.AllDirectories))
            {
                var destination = Path.Combine(target, Path.GetRelativePath(sourceDir, file));
                Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
                File.Move(file, destination, overwrite: true);
            }

            return (true, null);
        }
        catch (Exception ex)
        {
            return (false, ex.Message);
        }
    }

    /// <summary>
    /// 跑一次 <c>node -v</c> 验证运行时真的可用。
    /// @param file 可执行文件路径。
    /// @param ct 取消令牌。
    /// @returns 版本号（如 <c>v22.20.0</c>）；不可用时返回 null。
    /// </summary>
    private static async Task<string?> ProbeAsync(string file, CancellationToken ct)
    {
        try
        {
            var psi = new ProcessStartInfo(file)
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                StandardOutputEncoding = new UTF8Encoding(false),
                StandardErrorEncoding = new UTF8Encoding(false),
            };
            psi.ArgumentList.Add("-v");

            using var process = Process.Start(psi);
            if (process is null) return null;

            var stdout = await process.StandardOutput.ReadToEndAsync(ct).ConfigureAwait(false);
            await process.WaitForExitAsync(ct).ConfigureAwait(false);
            var text = stdout.Trim();
            return process.ExitCode == 0 && text.StartsWith('v') ? text : null;
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"[NodeProvisioner] 探针失败（{file}）：{ex.Message}");
            return null;
        }
    }

    /// <summary>算文件的 SHA-256（十六进制大写）。</summary>
    private static string Sha256OfFile(string file)
    {
        using var stream = File.OpenRead(file);
        using var sha = SHA256.Create();
        var hash = sha.ComputeHash(stream);
        return Convert.ToHexString(hash);
    }

    /// <summary>删除目录（不存在即成功；尽力而为）。</summary>
    private static Task DeleteDirectoryAsync(string dir)
    {
        return Task.Run(() =>
        {
            try
            {
                if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[NodeProvisioner] 清理目录失败（{dir}）：{ex.Message}");
            }
        });
    }

    /// <summary>删除文件（尽力而为）。</summary>
    private static void TryDeleteFile(string file)
    {
        try
        {
            if (File.Exists(file)) File.Delete(file);
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"[NodeProvisioner] 清理文件失败（{file}）：{ex.Message}");
        }
    }
}

/// <summary>一次 Node 发行包的信息（由 <c>SHASUMS256.txt</c> 解析得到）。</summary>
public sealed class NodeRelease
{
    /// <summary>版本号（形如 <c>v22.20.0</c>）。</summary>
    public string Version { get; init; } = string.Empty;

    /// <summary>压缩包文件名。</summary>
    public string ArchiveName { get; init; } = string.Empty;

    /// <summary>官方公布的 SHA-256（大写十六进制）。</summary>
    public string Sha256 { get; init; } = string.Empty;

    /// <summary>完整下载地址。</summary>
    public string Url { get; init; } = string.Empty;

    /// <summary>内容长度（未知为 null）。</summary>
    public long? SizeBytes { get; init; }
}

/// <summary>自动获取运行时的阶段。</summary>
public static class NodeProvisionPhase
{
    /// <summary>正在解析发行信息。</summary>
    public const string Resolving = "resolving";

    /// <summary>正在下载。</summary>
    public const string Downloading = "downloading";

    /// <summary>正在校验。</summary>
    public const string Verifying = "verifying";

    /// <summary>正在解压。</summary>
    public const string Extracting = "extracting";

    /// <summary>正在清理旧的坏运行时。</summary>
    public const string Cleaning = "cleaning";

    /// <summary>完成。</summary>
    public const string Done = "done";
}

/// <summary>自动获取运行时的进度。</summary>
public sealed class NodeProvisionProgress
{
    /// <summary>阶段，取值见 <see cref="NodeProvisionPhase"/>。</summary>
    public string Phase { get; init; } = NodeProvisionPhase.Resolving;

    /// <summary>面向用户的一句话说明。</summary>
    public string? Message { get; init; }

    /// <summary>已接收字节数（未知为 null）。</summary>
    public long? ReceivedBytes { get; init; }

    /// <summary>总字节数（未知为 null）。</summary>
    public long? TotalBytes { get; init; }

    /// <summary>下载百分比（1–100）；无法确定总量时为 0（界面应显示为不确定进度）。</summary>
    public int Percent
    {
        get
        {
            if (TotalBytes is not > 0 || ReceivedBytes is null) return 0;
            var value = (int)Math.Round(ReceivedBytes.Value * 100.0 / TotalBytes.Value);
            return Math.Clamp(value, 0, 100);
        }
    }
}

/// <summary>自动获取运行时的结果。</summary>
public sealed class NodeProvisionResult
{
    /// <summary>是否拿到了可用的运行时。</summary>
    public bool Ok { get; init; }

    /// <summary>运行时路径（失败为 null）。</summary>
    public string? File { get; init; }

    /// <summary>版本号（形如 <c>v22.20.0</c>；失败为 null）。</summary>
    public string? Version { get; init; }

    /// <summary>是否是"本就已经就位"（没有发生下载）。</summary>
    public bool AlreadyPresent { get; init; }

    /// <summary>失败原因（可直接展示的中文）。</summary>
    public string? Error { get; init; }
}

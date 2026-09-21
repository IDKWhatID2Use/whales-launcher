using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Text.Unicode;
using WhalesLauncher.Models;

namespace WhalesLauncher.Services;

/// <summary>
/// <see cref="CoreBridge"/> 的启动参数。
///
/// 全部可选：无参构造即"exe 同目录的 <c>bridge/server.cjs</c> + 自动探测 Node + 自动推断启动器根"，
/// 这也是发布形态下唯一需要的行为。开发期（exe 在 <c>bin/Debug/...</c> 深处）建议显式传
/// <see cref="HomeDir"/>，否则要靠向上找 <c>package.json</c> 的启发式。
/// </summary>
public sealed class CoreBridgeOptions
{
    /// <summary>桥接入口脚本。默认 &lt;exe 目录&gt;/bridge/server.cjs。</summary>
    public string? BridgeEntry { get; init; }

    /// <summary>启动器根目录（作为 <c>--home</c> 传给 Node）。默认见 <see cref="CoreBridge.ResolveDefaultHome"/>。</summary>
    public string? HomeDir { get; init; }

    /// <summary>node.exe 路径。null = 自动探测（<c>WHALES_NODE_PATH</c> → PATH → 常见安装位置）。</summary>
    public string? NodePath { get; init; }

    /// <summary>子进程工作目录。默认 = <see cref="HomeDir"/>。</summary>
    public string? WorkingDirectory { get; init; }

    /// <summary>普通调用的默认超时（协议未规定；30 秒足够覆盖本地 CRUD）。</summary>
    public TimeSpan DefaultTimeout { get; init; } = TimeSpan.FromSeconds(30);

    /// <summary>优雅关闭的等待上限；超时后强杀进程树（Windows 上会连带孙进程）。</summary>
    public TimeSpan ShutdownTimeout { get; init; } = TimeSpan.FromSeconds(3);

    /// <summary>保留的 stderr 行数（诊断用）。</summary>
    public int StderrTailLines { get; init; } = 200;

    /// <summary>握手超时。</summary>
    public TimeSpan HandshakeTimeout { get; init; } = TimeSpan.FromSeconds(20);
}

/// <summary>
/// <c>__handshake</c> 的返回（协议 §3.2）。字段名与协议一致，靠全局 camelCase 策略映射。
/// </summary>
public sealed class BridgeHandshake
{
    /// <summary>协议版本，必须为 1。</summary>
    public int Protocol { get; set; }

    /// <summary>Node 侧启动器版本（用于界面展示与排障）。</summary>
    public string AppVersion { get; set; } = string.Empty;

    /// <summary>Node 侧导出的通道/方法清单。</summary>
    public List<string> Channels { get; set; } = new();

    /// <summary>Node 侧会反向调用的宿主方法清单。</summary>
    public List<string> HostMethods { get; set; } = new();
}

/// <summary>
/// 桥接调用在**传输层**失败的异常（进程未启动/已退出、写入失败、超时、响应非法）。
///
/// 与业务失败的区别：业务失败是 <c>{"ok":false,"error":"实例不存在"}</c>，走
/// <see cref="BridgeResult{T}.Error"/> 正常返回；只有"这条请求根本没走完"才抛本异常，
/// 由 <see cref="CoreBridge.CallAsync{T}(string, object?[])"/> 统一翻译成
/// <c>Ok=false</c> 的中文文案，调用方不需要 try/catch。
/// </summary>
public sealed class BridgeCallException : Exception
{
    public BridgeCallException(string message) : base(message)
    {
    }

    public BridgeCallException(string message, Exception inner) : base(message, inner)
    {
    }
}

/// <summary>
/// 定位可用于拉起侧车进程的 Node.js（mirrors <c>src/core/node-runtime.ts</c> 的解析顺序）。
///
/// 为什么 C# 侧还要有一份：Node 侧那份逻辑跑在**侧车进程里**，而侧车本身就要靠 Node 才能起来
/// （鸡生蛋）。所以启动阶段只能由 C# 自己找 node；找到之后，"当前用哪个 node / 每个候选为何不可用"
/// 仍以 Node 侧 <c>launcher:detectNode</c> 的结论为准（那才是完整版，含 Electron 宿主判定）。
///
/// 判定同样是**实际跑探针**（<c>node -e</c> 打印 <c>process.versions</c>），绝不按路径名猜测。
/// </summary>
public static class NodeRuntimeLocator
{
    /// <summary>dsh 引擎要求的最低 Node.js 主版本（与 <c>src/core/node-runtime.ts:44</c> 一致）。</summary>
    public const int MinNodeMajor = 20;

    /// <summary>环境变量：显式覆盖 node 路径（排障/自动化用）。</summary>
    public const string NodePathEnvVar = "WHALES_NODE_PATH";

    private const string ProbePrefix = "WHALES_NODE_PROBE:";
    private const int ProbeTimeoutMs = 10_000;

    /// <summary>
    /// 探针脚本：只输出一行带前缀的 JSON，避免被 node/npm 的告警污染。
    /// 与 <c>src/core/node-runtime.ts:48</c> 的 PROBE_SOURCE 等价。
    /// </summary>
    private const string ProbeSource =
        "process.stdout.write('" + ProbePrefix + "' + " +
        "JSON.stringify({node: process.versions.node, electron: process.versions.electron ?? null}) + \"\\n\")";

    /// <summary>
    /// 探测全部候选并给出报告（**永不抛错**；失败原因都在报告里）。
    /// 供设置页"检测 Node 运行时"的**本地**诊断路径复用。
    /// </summary>
    /// <param name="configuredPath">全局设置里指定的 node 路径（可选）。</param>
    /// <param name="home">
    /// 启动器根目录。给了才会把**自备运行时**（<c>&lt;home&gt;/runtime/node/node.exe</c>，
    /// 由环境自检下载，见 <see cref="NodeProvisioner"/>）纳入候选。
    /// </param>
    /// <param name="ct">取消令牌。</param>
    public static async Task<NodeRuntimeReport> ResolveAsync(
        string? configuredPath = null,
        string? home = null,
        CancellationToken ct = default)
    {
        var candidates = new List<NodeRuntimeCandidate>();
        foreach (var (file, source) in CollectCandidates(configuredPath, home))
        {
            ct.ThrowIfCancellationRequested();
            var candidate = await ProbeAsync(file, source, ct).ConfigureAwait(false);
            candidates.Add(candidate);
            if (!candidate.Ok) continue;

            return new NodeRuntimeReport
            {
                Ok = true,
                File = candidate.File,
                Version = candidate.Version,
                Source = candidate.Source,
                Candidates = candidates,
                Message = $"使用 {candidate.File}（Node v{candidate.Version}，来源：{SourceLabel(candidate.Source)}）",
            };
        }

        return new NodeRuntimeReport
        {
            Ok = false,
            File = null,
            Version = null,
            Source = null,
            Candidates = candidates,
            Message =
                $"未找到可用的 Node.js 运行时：dsh 引擎必须由真正的 Node.js（>= {MinNodeMajor}）执行。" +
                "请安装 Node.js，或设置环境变量 " + NodePathEnvVar + " 指向 node.exe 后重试。" +
                (candidates.Count == 0 ? "（本次未发现任何候选）" : "各候选的结论见下方列表。"),
        };
    }

    /// <summary>
    /// 取一个**确认可用**的 node 绝对路径；找不到时抛 <see cref="InvalidOperationException"/>，
    /// 消息里带上每个候选的中文失败原因（可直接展示给用户，不需要再翻译）。
    /// </summary>
    /// <param name="configuredPath">全局设置里指定的 node 路径（可选）。</param>
    /// <param name="home">启动器根目录（用于纳入自备运行时；见 <see cref="ResolveAsync"/>）。</param>
    /// <param name="ct">取消令牌。</param>
    public static async Task<string> RequireAsync(
        string? configuredPath = null,
        string? home = null,
        CancellationToken ct = default)
    {
        var report = await ResolveAsync(configuredPath, home, ct).ConfigureAwait(false);
        if (report.Ok && report.File is not null) return report.File;

        var detail = report.Candidates.Count == 0
            ? "（未发现任何候选）"
            : string.Join("\n", report.Candidates.Select(item => item.Ok
                ? $"\u00b7 {item.File} \u2014\u2014 可用（Node v{item.Version}）"
                : $"\u00b7 {item.File} \u2014\u2014 不可用：{item.Reason}"));

        throw new InvalidOperationException(report.Message + "\n" + detail);
    }

    private static string SourceLabel(string source) => source switch
    {
        NodeRuntimeSourceValues.Env => "环境变量 " + NodePathEnvVar,
        NodeRuntimeSourceValues.Config => "显式配置",
        NodeRuntimeSourceValues.Current => "启动器自身进程",
        NodeRuntimeSourceValues.Path => "系统 PATH",
        NodeRuntimeSourceValues.Portable => "启动器自备运行时",
        NodeRuntimeSourceValues.Common => "常见安装位置",
        _ => source,
    };

    /// <summary>
    /// 枚举候选（已去重）；**显式来源（配置/环境变量）即使文件不存在也入列** ——
    /// 用户手填错路径时必须能看到"这个路径不存在"，而不是被静默跳过、让人以为配置没生效。
    /// </summary>
    /// <param name="configuredPath">全局设置里指定的 node 路径。</param>
    /// <param name="home">启动器根目录（null 时不枚举自备运行时）。</param>
    private static List<(string File, string Source)> CollectCandidates(string? configuredPath, string? home)
    {
        var outList = new List<(string, string)>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        void Push(string? file, string source, bool explicitSource)
        {
            if (string.IsNullOrWhiteSpace(file)) return;
            string resolved;
            try
            {
                resolved = Path.GetFullPath(file);
            }
            catch (Exception)
            {
                return;
            }

            if (!seen.Add(resolved)) return;
            if (!explicitSource && !File.Exists(resolved)) return;
            outList.Add((resolved, source));
        }

        Push(configuredPath, NodeRuntimeSourceValues.Config, explicitSource: true);
        Push(Environment.GetEnvironmentVariable(NodePathEnvVar), NodeRuntimeSourceValues.Env, explicitSource: true);
        foreach (var file in FindOnPath()) Push(file, NodeRuntimeSourceValues.Path, explicitSource: false);
        // 自备运行时排在系统 PATH **之后**、常见安装位置**之前**：用户自己装好的 Node 优先沿用，
        // 而"启动器亲手铺设并验证过"的这一份比各种猜测出来的安装位置更确定。
        if (!string.IsNullOrWhiteSpace(home))
        {
            Push(NodeProvisioner.PortableNodeExe(home), NodeRuntimeSourceValues.Portable, explicitSource: false);
        }

        foreach (var file in CommonInstallPaths()) Push(file, NodeRuntimeSourceValues.Common, explicitSource: false);
        return outList;
    }

    /// <summary>在 PATH 上查找 <c>node.exe</c>（只认真正的可执行文件；.cmd/.bat 是 npm 垫片，不能用）。</summary>
    private static IEnumerable<string> FindOnPath()
    {
        var path = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
        foreach (var dir in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            var candidate = Path.Combine(dir.Trim('"'), "node.exe");
            if (File.Exists(candidate)) yield return candidate;
        }
    }

    /// <summary>常见安装位置兜底（与 <c>src/core/node-runtime.ts:229</c> 的 Windows 分支同源）。</summary>
    private static IEnumerable<string> CommonInstallPaths()
    {
        var programFiles = Environment.GetEnvironmentVariable("ProgramFiles") ?? @"C:\Program Files";
        var programFilesX86 = Environment.GetEnvironmentVariable("ProgramFiles(x86)") ?? @"C:\Program Files (x86)";
        var localAppData = Environment.GetEnvironmentVariable("LOCALAPPDATA") ?? string.Empty;
        var appData = Environment.GetEnvironmentVariable("APPDATA") ?? string.Empty;
        var userProfile = Environment.GetEnvironmentVariable("USERPROFILE") ?? string.Empty;
        var nvmSymlink = Environment.GetEnvironmentVariable("NVM_SYMLINK") ?? string.Empty;
        var nodeHome = Environment.GetEnvironmentVariable("WHALES_NODE_HOME") ?? string.Empty;

        var list = new List<string>
        {
            Path.Combine(programFiles, "nodejs", "node.exe"),
            Path.Combine(programFilesX86, "nodejs", "node.exe"),
        };
        if (localAppData.Length > 0)
        {
            list.Add(Path.Combine(localAppData, "Programs", "nodejs", "node.exe"));
            list.Add(Path.Combine(localAppData, "Volta", "bin", "node.exe"));
            list.Add(Path.Combine(localAppData, "fnm", "aliases", "default", "node.exe"));
        }

        if (appData.Length > 0) list.Add(Path.Combine(appData, "nvm", "current", "node.exe"));
        if (nvmSymlink.Length > 0) list.Add(Path.Combine(nvmSymlink, "node.exe"));
        if (userProfile.Length > 0) list.Add(Path.Combine(userProfile, ".volta", "bin", "node.exe"));
        if (nodeHome.Length > 0) list.Add(Path.Combine(nodeHome, "node.exe"));
        return list;
    }

    /// <summary>跑一次探针并给出结论。</summary>
    private static async Task<NodeRuntimeCandidate> ProbeAsync(string file, string source, CancellationToken ct)
    {
        NodeRuntimeCandidate Fail(string reason, string? version = null, string? electron = null) =>
            new() { File = file, Source = source, Ok = false, Version = version, Electron = electron, Reason = reason };

        if (!File.Exists(file)) return Fail("文件不存在或不是可执行文件");

        var psi = new ProcessStartInfo(file)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardOutputEncoding = new UTF8Encoding(false),
            StandardErrorEncoding = new UTF8Encoding(false),
        };
        psi.ArgumentList.Add("-e");
        psi.ArgumentList.Add(ProbeSource);
        // 探针必须看到"裸"的运行时：清掉可能让子进程变成 Electron / 被注入预载的环境变量。
        psi.Environment.Remove("ELECTRON_RUN_AS_NODE");
        psi.Environment.Remove("NODE_OPTIONS");

        try
        {
            using var process = Process.Start(psi) ?? throw new InvalidOperationException("进程未能启动");
            var stdoutTask = process.StandardOutput.ReadToEndAsync(ct);
            var stderrTask = process.StandardError.ReadToEndAsync(ct);

            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeoutCts.CancelAfter(ProbeTimeoutMs);
            try
            {
                await process.WaitForExitAsync(timeoutCts.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                TryKillTree(process);
                if (ct.IsCancellationRequested) throw;
                return Fail($"探针超时（超过 {ProbeTimeoutMs} 毫秒无响应）");
            }

            var stdout = await stdoutTask.ConfigureAwait(false);
            var stderr = await stderrTask.ConfigureAwait(false);
            return Classify(file, source, stdout, stderr, process.ExitCode);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            return Fail($"无法执行：{ex.Message}");
        }
    }

    /// <summary>
    /// 判定：只吃探针的原始输出，produce 结论。
    /// 对应 <c>src/core/node-runtime.ts:273</c> 的 <c>classifyProbe</c>（同样是纯函数，便于排障时逐条核对）。
    /// </summary>
    private static NodeRuntimeCandidate Classify(string file, string source, string stdout, string stderr, int exitCode)
    {
        var line = stdout
            .Split('\n')
            .Select(item => item.TrimEnd('\r'))
            .LastOrDefault(item => item.StartsWith(ProbePrefix, StringComparison.Ordinal));

        if (line is null)
        {
            var detail = Tail(stderr.Length > 0 ? stderr : stdout);
            return new NodeRuntimeCandidate
            {
                File = file,
                Source = source,
                Ok = false,
                Reason = $"探针未返回结果（退出码 {exitCode}）{(detail.Length > 0 ? "：" + detail : string.Empty)}",
            };
        }

        string? version = null;
        string? electron = null;
        try
        {
            using var doc = JsonDocument.Parse(line[ProbePrefix.Length..]);
            if (doc.RootElement.TryGetProperty("node", out var node) && node.ValueKind == JsonValueKind.String)
            {
                version = node.GetString();
            }

            if (doc.RootElement.TryGetProperty("electron", out var el) && el.ValueKind == JsonValueKind.String)
            {
                electron = el.GetString();
            }
        }
        catch (JsonException ex)
        {
            return new NodeRuntimeCandidate
            {
                File = file,
                Source = source,
                Ok = false,
                Reason = $"探针输出无法解析：{ex.Message}",
            };
        }

        if (version is null)
        {
            return new NodeRuntimeCandidate { File = file, Source = source, Ok = false, Electron = electron, Reason = "探针未报告 Node 版本" };
        }

        if (electron is not null)
        {
            return new NodeRuntimeCandidate
            {
                File = file,
                Source = source,
                Ok = false,
                Version = version,
                Electron = electron,
                Reason = $"这是 Electron {electron} 内置的 Node 运行时（Node v{version}），dsh 的原生模块不支持，必须使用独立的 Node.js",
            };
        }

        var majorText = version.Split('.')[0];
        if (!int.TryParse(majorText, NumberStyles.Integer, CultureInfo.InvariantCulture, out var major) || major < MinNodeMajor)
        {
            return new NodeRuntimeCandidate
            {
                File = file,
                Source = source,
                Ok = false,
                Version = version,
                Reason = $"Node.js 版本过低（v{version}），dsh 需要 >= v{MinNodeMajor}",
            };
        }

        return new NodeRuntimeCandidate { File = file, Source = source, Ok = true, Version = version };
    }

    private static string Tail(string text)
    {
        var parts = text
            .Split('\n')
            .Select(item => item.Trim())
            .Where(item => item.Length > 0)
            .ToArray();
        var slice = parts.Length <= 3 ? parts : parts[(parts.Length - 3)..];
        var joined = string.Join(" / ", slice);
        return joined.Length <= 400 ? joined : joined[..400];
    }

    private static void TryKillTree(Process process)
    {
        try
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
        }
        catch (Exception)
        {
            // 进程可能刚好自己退了；探针失败原因已经记录下来，这里不再覆盖。
        }
    }
}

/// <summary>
/// Node 侧车进程的 C# 客户端（协议 v1 的 C# 一侧，见 <c>docs/design/winui3-bridge-protocol.md</c>）。
///
/// 职责：进程生命周期、NDJSON 读写、请求-响应配对、事件分发、宿主方法注册、握手断言、崩溃检测、优雅关闭。
/// 边界：**不含任何业务规则**，也**不持有 UI 引用**；业务在 Node 侧 core，展示在 Views。
///
/// 线程模型：
///  - 可从任意线程调用（内部全部走并发字典 + 写锁）；
///  - stdout 由一条后台读循环独占消费，事件在**该后台线程**上触发 ——
///    订阅方若要碰 UI，必须自己 <c>DispatcherQueue.TryEnqueue</c>（约定 §8）；
///  - 宿主方法处理器**不阻塞读循环**（见 <see cref="HandleHostRequestAsync"/>），
///    否则等待 UI 对话框期间会把其他请求的响应一起堵死。
/// </summary>
public sealed class CoreBridge : IAsyncDisposable
{
    /// <summary>本实现支持的桥接协议版本（协议 §6：变更须两端同时升级）。</summary>
    public const int ProtocolVersion = 1;

    /// <summary>单行载荷上限（协议 §1：8 MiB，更大数据一律传文件路径）。</summary>
    public const int MaxLineBytes = 8 * 1024 * 1024;

    /// <summary>拉取 node 侧进程的日志行前缀（与 Node 侧约定，仅用于排障）。</summary>
    private const string LogPrefix = "[bridge]";

    /// <summary>
    /// 契约 JSON 的规范映射：camelCase 属性名 + 大小写不敏感读取。
    /// 供 Model 在别处（例如读取 instance.json 副本）反序列化时复用，避免各处自建策略而漂移。
    /// </summary>
    public static readonly JsonSerializerOptions ModelJson = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
    };

    /// <summary>
    /// **外发**请求的序列化策略：null 属性一律不写。
    ///
    /// 这是与 TS 语义对齐的关键：契约里 <c>x?: T</c> 表示"未提供"，Node 侧的
    /// <c>parseUpdatePatch</c> 把 <c>undefined</c> 当"不改动"、把显式 <c>null</c> 当非法值报错。
    /// 若把 C# 的 null 原样写出去，<c>instance:update</c> 会因 <c>color: null</c> 之类直接失败。
    ///
    /// 需要**显式传 null**（清空图标 / 把 nodePath 重置为自动探测）时，
    /// 传一个 <see cref="Dictionary{TKey,TValue}"/> 或 <see cref="JsonNode"/> 作为参数 ——
    /// 字典项与 JsonNode 的 null 不受本策略影响，会原样落成 JSON null。
    /// </summary>
    private static readonly JsonSerializerOptions JsonOut = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        // 中文不转义成 \uXXXX：NDJSON 抓包可读，便于按协议逐行核对。
        Encoder = JavaScriptEncoder.Create(UnicodeRanges.All),
    };

    private readonly CoreBridgeOptions _options;
    private readonly ConcurrentDictionary<string, TaskCompletionSource<JsonElement>> _pending = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, Func<JsonElement[], Task<object?>>> _hostMethods = new(StringComparer.Ordinal);
    private readonly Queue<string> _stderrTail = new();
    private readonly object _stderrLock = new();
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private readonly SemaphoreSlim _startLock = new(1, 1);

    private Process? _process;
    private StreamWriter? _stdin;
    private int _nextRequestId;
    private int _exitNotified;
    private volatile bool _shuttingDown;
    private volatile bool _disposed;

    /// <summary>用默认参数构造（exe 同目录 bridge/server.cjs + 自动探测 node）。</summary>
    public CoreBridge() : this(new CoreBridgeOptions())
    {
    }

    /// <summary>覆盖桥接入口脚本路径。</summary>
    public CoreBridge(string bridgeEntry) : this(new CoreBridgeOptions { BridgeEntry = bridgeEntry })
    {
    }

    /// <summary>覆盖入口脚本与启动器根目录（开发期最常用的两个参数）。</summary>
    public CoreBridge(string bridgeEntry, string homeDir)
        : this(new CoreBridgeOptions { BridgeEntry = bridgeEntry, HomeDir = homeDir })
    {
    }

    public CoreBridge(CoreBridgeOptions options)
    {
        _options = options ?? throw new ArgumentNullException(nameof(options));
    }

    /* ------------------------------------------------------------------ *
     * 事件
     * ------------------------------------------------------------------ */

    /// <summary>
    /// <c>log:chunk</c> 事件（协议 §2.4）。**在后台读线程上触发**，订阅方自行切 UI 线程。
    /// 事件名与 <see cref="Models.LogChunk"/> 同名是任务约定的形状（<c>bridge.LogChunk += ...</c>）。
    /// </summary>
    public event EventHandler<Models.LogChunk>? LogChunk;

    /// <summary><c>log:state</c> 事件（协议 §2.4）：实例运行时状态变更，载荷是完整快照。</summary>
    public event EventHandler<Models.InstanceRuntime>? LogStateChanged;

    /// <summary>
    /// 后端桥接进程退出（崩溃检测，协议 §4）。载荷是面向用户的中文原因，含退出码与 stderr 尾部。
    ///
    /// **主动关闭（<see cref="DisposeAsync"/>）不会触发本事件** —— 否则正常退出会被界面报成"后端崩溃"。
    /// </summary>
    public event EventHandler<string>? BackendExited;

    /* ------------------------------------------------------------------ *
     * 状态
     * ------------------------------------------------------------------ */

    /// <summary>子进程是否存活。后端断开后应为 false，此时界面须禁用写操作并提示重启。</summary>
    public bool IsRunning
    {
        get
        {
            var process = _process;
            if (process is null) return false;
            try
            {
                return !process.HasExited;
            }
            catch (InvalidOperationException)
            {
                return false;
            }
        }
    }

    /// <summary>子进程 PID；未启动为 null。</summary>
    public int? ProcessId
    {
        get
        {
            try
            {
                return _process?.Id;
            }
            catch (InvalidOperationException)
            {
                return null;
            }
        }
    }

    /// <summary>实际使用的 node.exe（握手成功后可用，供界面展示"当前用哪个 node"）。</summary>
    public string? NodeExecutable { get; private set; }

    /// <summary>实际传给 Node 的 <c>--home</c>（启动器根目录）。</summary>
    public string Home { get; private set; } = string.Empty;

    /// <summary>实际加载的桥接入口脚本路径。</summary>
    public string BridgeEntry { get; private set; } = string.Empty;

    /// <summary>握手结果；未握手为 null。</summary>
    public BridgeHandshake? Handshake { get; private set; }

    /// <summary>最近 <see cref="CoreBridgeOptions.StderrTailLines"/> 行 stderr（诊断用，最新在末尾）。</summary>
    public IReadOnlyList<string> StderrTail
    {
        get
        {
            lock (_stderrLock)
            {
                return _stderrTail.ToArray();
            }
        }
    }

    /// <summary>已注册的宿主方法名快照。</summary>
    public IReadOnlyCollection<string> RegisteredHostMethods => _hostMethods.Keys.ToArray();

    /// <summary>在途（尚未配对）的请求数，供退出时判断是否有未完成的调用。</summary>
    public int PendingRequestCount => _pending.Count;

    /* ------------------------------------------------------------------ *
     * 启动与握手
     * ------------------------------------------------------------------ */

    /// <summary>
    /// 拉起侧车进程并完成握手。可重复调用（已启动则直接返回）。
    /// </summary>
    /// <exception cref="FileNotFoundException">桥接脚本不存在（尚未构建 <c>dist/bridge/server.cjs</c>）。</exception>
    /// <exception cref="InvalidOperationException">找不到可用 Node，或握手断言失败（协议版本/通道清单不一致）。</exception>
    public async Task StartAsync(CancellationToken ct = default)
    {
        ThrowIfDisposed();
        if (IsRunning) return;

        await _startLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (IsRunning) return;

            BridgeEntry = ResolveBridgeEntry();
            if (!File.Exists(BridgeEntry))
            {
                throw new FileNotFoundException(
                    $"找不到桥接脚本：{BridgeEntry}。" +
                    "请先构建 Node 侧产物（dist/bridge/server.cjs），或用 CoreBridgeOptions.BridgeEntry 指定路径。",
                    BridgeEntry);
            }

            Home = _options.HomeDir is { Length: > 0 } home ? Path.GetFullPath(home) : ResolveDefaultHome();
            NodeExecutable = _options.NodePath is { Length: > 0 } node
                ? node
                : await NodeRuntimeLocator.RequireAsync(null, Home, ct).ConfigureAwait(false);

            var workingDirectory = _options.WorkingDirectory is { Length: > 0 } wd ? wd : Home;
            if (!Directory.Exists(workingDirectory)) Directory.CreateDirectory(workingDirectory);

            var psi = new ProcessStartInfo(NodeExecutable)
            {
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = workingDirectory,
                StandardInputEncoding = new UTF8Encoding(false),
                StandardOutputEncoding = new UTF8Encoding(false),
                StandardErrorEncoding = new UTF8Encoding(false),
            };
            // 位置参数（协议 §1）：node <bridge-entry> --home <dir>
            psi.ArgumentList.Add(BridgeEntry);
            psi.ArgumentList.Add("--home");
            psi.ArgumentList.Add(Home);
            // core 的 defaultRootForCache() 会读它；显式设置可让 Node 侧无论如何都能定位启动器根。
            psi.Environment["WHALES_LAUNCHER_ROOT"] = Home;
            psi.Environment.Remove("ELECTRON_RUN_AS_NODE");
            psi.Environment.Remove("NODE_OPTIONS");

            /*
             * 把所用 Node 的所在目录前置到子进程 PATH。
             *
             * 自备运行时（<home>/runtime/node）不在系统 PATH 上 —— 我们是用绝对路径把它跑起来的，
             * 但 dsh 自己、以及它拉起的 pnpm / 插件安装脚本都会**按名字**找 node / npm。
             * 少了这一行，"引擎装上了却起不来"会变成一个极难定位的问题。
             */
            var nodeDir = Path.GetDirectoryName(NodeExecutable);
            if (!string.IsNullOrEmpty(nodeDir))
            {
                var inherited = psi.Environment.TryGetValue("PATH", out var own) && !string.IsNullOrEmpty(own)
                    ? own
                    : Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
                psi.Environment["PATH"] = inherited.Length > 0
                    ? nodeDir + Path.PathSeparator + inherited
                    : nodeDir;
            }

            var process = new Process { StartInfo = psi, EnableRaisingEvents = true };
            process.Exited += OnProcessExited;
            if (!process.Start())
            {
                throw new InvalidOperationException($"无法启动 Node 桥接进程：{NodeExecutable}");
            }

            _process = process;
            Interlocked.Exchange(ref _exitNotified, 0);
            _shuttingDown = false;

            // AutoFlush 关闭：逐行显式 Flush（每行一个完整 JSON，写完即对端可见）。
            _stdin = new StreamWriter(process.StandardInput.BaseStream, new UTF8Encoding(false))
            {
                AutoFlush = false,
                // 协议 §1 明确用 \n 分帧；StreamWriter 在 Windows 上默认写 \r\n，必须显式改掉。
                NewLine = "\n",
            };

            _ = Task.Run(() => ReadStdoutLoopAsync(process), CancellationToken.None);
            _ = Task.Run(() => ReadStderrLoopAsync(process), CancellationToken.None);

            await HandshakeAsync(ct).ConfigureAwait(false);
            Debug.WriteLine($"{LogPrefix} 已连接：node={NodeExecutable} home={Home} entry={BridgeEntry} pid={process.Id}");
        }
        finally
        {
            _startLock.Release();
        }
    }

    /// <summary>
    /// 握手（协议 §3.2/§5.3）：启动后**首先**调用，并在开发期断言两端通道清单一致，不一致直接失败。
    /// </summary>
    private async Task HandshakeAsync(CancellationToken ct)
    {
        var result = await CallAsync<BridgeHandshake>(Channels.Builtin.Handshake, _options.HandshakeTimeout)
            .ConfigureAwait(false);
        if (!result.Ok || result.Value is null)
        {
            throw new InvalidOperationException($"桥接握手失败：{result.Error}");
        }

        var handshake = result.Value;
        if (handshake.Protocol != ProtocolVersion)
        {
            throw new InvalidOperationException(
                $"桥接协议版本不匹配：Node 侧为 {handshake.Protocol}，C# 侧要求 {ProtocolVersion}。" +
                "两端必须同时升级（docs/design/winui3-bridge-protocol.md §6）。");
        }

        var remote = new HashSet<string>(handshake.Channels, StringComparer.Ordinal);
        var missing = Channels.All.Where(channel => !remote.Contains(channel)).ToArray();
        var extra = remote.Where(channel => Array.IndexOf(Channels.All, channel) < 0).ToArray();

        // 推送通道（log:chunk / log:state）不是"可调用方法"：Node 侧若只导出 invoke 通道，
        // 它们缺席是合理的（协议 §2.4 把两者定义为事件），只告警不失败。
        var missingInvokable = missing.Where(channel => !Channels.PushOnly.Contains(channel)).ToArray();
        if (missingInvokable.Length > 0 || extra.Length > 0)
        {
            throw new InvalidOperationException(
                "桥接通道清单与本地 Channels 常量不一致（协议 §5.3 要求开发期快速失败）：" +
                (missingInvokable.Length > 0 ? $"\n  Node 侧缺少：{string.Join(", ", missingInvokable)}" : string.Empty) +
                (extra.Length > 0 ? $"\n  Node 侧多出：{string.Join(", ", extra)}" : string.Empty) +
                $"\n本地共 {Channels.Count} 条；收到 {remote.Count} 条。");
        }

        if (missing.Length > 0)
        {
            Debug.WriteLine($"{LogPrefix} 握手告警：Node 侧未导出推送通道 {string.Join(", ", missing)}（可接受）。");
        }

        Handshake = handshake;
    }

    /* ------------------------------------------------------------------ *
     * 调用
     * ------------------------------------------------------------------ */

    /// <summary>
    /// 调用一个 Node 侧方法（协议 §2.1）。默认超时见 <see cref="CoreBridgeOptions.DefaultTimeout"/>。
    /// </summary>
    /// <typeparam name="T">返回值类型（契约 DTO 或 <see cref="BridgeVoid"/>）。</typeparam>
    /// <param name="method">通道字面值，见 <see cref="Channels"/>。</param>
    /// <param name="args">位置参数数组，顺序与 <c>src/main/ipc.ts</c> 的 handler 一致。</param>
    public Task<BridgeResult<T>> CallAsync<T>(string method, params object?[] args)
        => CallAsync<T>(method, _options.DefaultTimeout, args);

    /// <summary>
    /// 带超时的调用。<c>engine:install</c> 这类长任务（npm 下载）务必显式放宽，或传
    /// <see cref="Timeout.InfiniteTimeSpan"/> 表示不设超时。
    /// </summary>
    /// <example>
    /// <code>
    /// var result = await bridge.CallAsync&lt;EngineInfo&gt;(Channels.EngineInstall, TimeSpan.FromMinutes(30), version);
    /// var slow = await bridge.CallAsync&lt;EngineInfo&gt;(Channels.EngineInstall, Timeout.InfiniteTimeSpan, version);
    /// </code>
    /// </example>
    public async Task<BridgeResult<T>> CallAsync<T>(string method, TimeSpan timeout, params object?[] args)
    {
        JsonElement value;
        try
        {
            value = await SendAsync(method, args, timeout, CancellationToken.None).ConfigureAwait(false);
        }
        catch (BridgeCallException ex)
        {
            return BridgeResult<T>.Failure(ex.Message);
        }
        catch (OperationCanceledException)
        {
            return BridgeResult<T>.Failure($"{method} 调用被取消。");
        }
        catch (ObjectDisposedException ex)
        {
            return BridgeResult<T>.Failure($"{method} 调用失败：{ex.Message}");
        }

        // value 缺失（void 方法）或显式 null（如 pickArchive 被取消）都返回 Ok=true + default。
        if (value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
        {
            return BridgeResult<T>.Success(default!);
        }

        try
        {
            return BridgeResult<T>.Success(JsonSerializer.Deserialize<T>(value, ModelJson)!);
        }
        catch (JsonException ex)
        {
            return BridgeResult<T>.Failure($"解析 {method} 的返回值失败：{ex.Message}");
        }
        catch (NotSupportedException ex)
        {
            return BridgeResult<T>.Failure($"解析 {method} 的返回值失败（类型不支持）：{ex.Message}");
        }
    }

    /// <summary>调用一个无返回值的方法（契约里的 <c>Result&lt;void&gt;</c>），只看 <c>Ok</c>。</summary>
    public Task<BridgeResult<BridgeVoid>> CallVoidAsync(string method, params object?[] args)
        => CallAsync<BridgeVoid>(method, _options.DefaultTimeout, args);

    /// <summary>带超时的无返回值调用。</summary>
    public Task<BridgeResult<BridgeVoid>> CallVoidAsync(string method, TimeSpan timeout, params object?[] args)
        => CallAsync<BridgeVoid>(method, timeout, args);

    /// <summary>存活探测（协议 §3.2 的 <c>__ping</c>）。</summary>
    public async Task<bool> PingAsync(TimeSpan? timeout = null)
    {
        var result = await CallAsync<JsonElement>(Channels.Builtin.Ping, timeout ?? TimeSpan.FromSeconds(5))
            .ConfigureAwait(false);
        return result.Ok;
    }

    /// <summary>
    /// 发一条请求并等待配对响应。**传输层**失败抛 <see cref="BridgeCallException"/>。
    /// </summary>
    private async Task<JsonElement> SendAsync(string method, object?[] args, TimeSpan timeout, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(method)) throw new ArgumentException("方法名不能为空。", nameof(method));

        var process = _process ?? throw new BridgeCallException(
            $"后端桥接尚未启动，无法调用 {method}。请先 await bridge.StartAsync()。");
        try
        {
            if (process.HasExited)
            {
                throw new BridgeCallException(
                    $"后端桥接进程已退出（退出码 {process.ExitCode}），无法调用 {method}。请重启应用。");
            }
        }
        catch (InvalidOperationException)
        {
            throw new BridgeCallException($"后端桥接进程状态未知，无法调用 {method}。请重启应用。");
        }

        // id 命名空间隔离（协议 §2.1）：C# 发起用 c + 自增；Node 发起用 n + 自增。
        var id = "c" + Interlocked.Increment(ref _nextRequestId).ToString(CultureInfo.InvariantCulture);

        // 先序列化再登记配对：序列化失败属于调用方的参数问题，不该在 _pending 里留下悬空条目。
        string payload;
        try
        {
            // 协议 §2.1 要求 params 必需（可为 []）——调用方误传 null 时补成空数组，
            // 否则 WhenWritingNull 会把整个 params 键省掉，对端会把它当畸形报文。
            payload = JsonSerializer.Serialize(new BridgeRequest(id, method, args ?? Array.Empty<object?>()), JsonOut);
        }
        catch (Exception ex)
        {
            throw new BridgeCallException($"{method} 的位置参数无法序列化为 JSON：{ex.Message}", ex);
        }

        var tcs = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        if (!_pending.TryAdd(id, tcs))
        {
            throw new BridgeCallException($"请求 id 冲突（{id}），这属于实现缺陷，请报告。");
        }

        try
        {
            await WriteLineAsync(payload, ct).ConfigureAwait(false);

            if (timeout == Timeout.InfiniteTimeSpan)
            {
                return await tcs.Task.ConfigureAwait(false);
            }

            return await tcs.Task.WaitAsync(timeout, ct).ConfigureAwait(false);
        }
        catch (TimeoutException)
        {
            throw new BridgeCallException(
                $"{method} 调用超时（{timeout.TotalSeconds.ToString("0.#", CultureInfo.InvariantCulture)} 秒无响应）。" +
                "长任务请传更长的超时或 Timeout.InfiniteTimeSpan。");
        }
        catch (IOException ex)
        {
            throw new BridgeCallException($"写入桥接进程失败（{method}）：{ex.Message}", ex);
        }
        finally
        {
            _pending.TryRemove(id, out _);
        }
    }

    /// <summary>序列化一行并写出（<c>\n</c> 结尾），写完立刻 Flush。</summary>
    private async Task WriteLineAsync(string line, CancellationToken ct)
    {
        var writer = _stdin ?? throw new BridgeCallException("后端桥接进程的 stdin 不可用（进程未启动或已关闭）。");

        var byteCount = Encoding.UTF8.GetByteCount(line);
        if (byteCount > MaxLineBytes)
        {
            throw new BridgeCallException(
                $"请求超过单行上限（{byteCount} 字节 > {MaxLineBytes} 字节，协议 §1）。" +
                "大块数据请改为传文件路径。");
        }

        await _writeLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await writer.WriteLineAsync(line).ConfigureAwait(false);
            await writer.FlushAsync(ct).ConfigureAwait(false);
        }
        finally
        {
            _writeLock.Release();
        }
    }

    /* ------------------------------------------------------------------ *
     * stdout 读循环与分派
     * ------------------------------------------------------------------ */

    /// <summary>
    /// stdout **只读协议行**（协议 §4：严禁在 stdout 打印非协议内容）。
    /// 非 JSON 行不崩溃、只留诊断 —— 那属于对端实现缺陷，但客户端必须活着，否则一个脏行就废掉整个后端。
    /// </summary>
    private async Task ReadStdoutLoopAsync(Process process)
    {
        try
        {
            var reader = process.StandardOutput;
            while (true)
            {
                var line = await reader.ReadLineAsync().ConfigureAwait(false);
                if (line is null) break;
                if (line.Length == 0) continue;
                try
                {
                    HandleLine(line);
                }
                catch (Exception ex)
                {
                    // 单行处理失败绝不允许终结读循环（否则后续所有请求都会超时）。
                    Debug.WriteLine($"{LogPrefix} 处理 stdout 行失败：{ex}");
                }
            }
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"{LogPrefix} stdout 读循环结束：{ex.Message}");
        }
        finally
        {
            // stdout 关闭通常意味着进程已退出（或即将退出）：兜底触发一次退出检测，
            // 避免 Exited 事件与读循环之间的竞态导致漏报"后端已断开"。
            try
            {
                await process.WaitForExitAsync().ConfigureAwait(false);
            }
            catch (Exception)
            {
                // 进程对象可能已释放；下面的 NotifyBackendExited 仍会兜底处理在途请求。
            }

            NotifyBackendExited(process);
        }
    }

    /// <summary>stderr 不是协议（协议 §1）：转 Debug 并保留最近若干行供诊断。</summary>
    private async Task ReadStderrLoopAsync(Process process)
    {
        try
        {
            var reader = process.StandardError;
            while (true)
            {
                var line = await reader.ReadLineAsync().ConfigureAwait(false);
                if (line is null) break;
                Debug.WriteLine($"{LogPrefix} stderr: {line}");
                lock (_stderrLock)
                {
                    _stderrTail.Enqueue(line);
                    while (_stderrTail.Count > Math.Max(1, _options.StderrTailLines)) _stderrTail.Dequeue();
                }
            }
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"{LogPrefix} stderr 读循环结束：{ex.Message}");
        }
    }

    /// <summary>分派一条协议行：事件 / 响应 / 反向请求（协议 §2）。</summary>
    private void HandleLine(string line)
    {
        JsonElement root;
        try
        {
            using var doc = JsonDocument.Parse(line);
            // JsonDocument 用完即弃，元素必须 Clone 后才能离开本方法（否则后续访问抛 ObjectDisposedException）。
            root = doc.RootElement.Clone();
        }
        catch (JsonException ex)
        {
            Debug.WriteLine($"{LogPrefix} 忽略非协议 stdout 行（{ex.Message}）：{Truncate(line, 200)}");
            return;
        }

        if (root.ValueKind != JsonValueKind.Object)
        {
            Debug.WriteLine($"{LogPrefix} 忽略非对象 stdout 行：{Truncate(line, 200)}");
            return;
        }

        // §2.4 事件：无 id、无响应
        if (root.TryGetProperty("event", out var eventName) && eventName.ValueKind == JsonValueKind.String)
        {
            DispatchEvent(eventName.GetString()!, root);
            return;
        }

        if (!root.TryGetProperty("id", out var idElement) || idElement.ValueKind != JsonValueKind.String)
        {
            Debug.WriteLine($"{LogPrefix} 忽略缺少 id 的协议行：{Truncate(line, 200)}");
            return;
        }

        var id = idElement.GetString()!;

        // §2.2/§2.3 响应
        if (root.TryGetProperty("ok", out var okElement))
        {
            CompleteResponse(id, root, okElement);
            return;
        }

        // §3.3 宿主方法（Node → C#）
        if (root.TryGetProperty("method", out var methodElement) && methodElement.ValueKind == JsonValueKind.String)
        {
            // 不 await：宿主方法可能弹对话框（要等用户），绝不能堵住读循环。
            _ = HandleHostRequestAsync(id, methodElement.GetString()!, root);
            return;
        }

        Debug.WriteLine($"{LogPrefix} 无法识别的协议行：{Truncate(line, 200)}");
    }

    private void CompleteResponse(string id, JsonElement root, JsonElement okElement)
    {
        if (!_pending.TryRemove(id, out var tcs))
        {
            Debug.WriteLine($"{LogPrefix} 收到未知或已超时的响应 id={id}（忽略）");
            return;
        }

        if (okElement.ValueKind == JsonValueKind.True)
        {
            tcs.TrySetResult(root.TryGetProperty("value", out var value) ? value.Clone() : default);
            return;
        }

        var error = root.TryGetProperty("error", out var errorElement) && errorElement.ValueKind == JsonValueKind.String
            ? errorElement.GetString()!
            : "后端返回了失败，但没有给出原因。";
        tcs.TrySetException(new BridgeCallException(error));
    }

    private void DispatchEvent(string name, JsonElement root)
    {
        if (!root.TryGetProperty("data", out var data) || data.ValueKind == JsonValueKind.Null)
        {
            Debug.WriteLine($"{LogPrefix} 事件 {name} 缺少 data，已忽略。");
            return;
        }

        try
        {
            switch (name)
            {
                case Channels.LogChunk:
                {
                    var chunk = data.Deserialize<Models.LogChunk>(ModelJson);
                    if (chunk is not null) LogChunk?.Invoke(this, chunk);
                    break;
                }

                case Channels.LogState:
                {
                    var runtime = data.Deserialize<Models.InstanceRuntime>(ModelJson);
                    if (runtime is not null) LogStateChanged?.Invoke(this, runtime);
                    break;
                }

                default:
                    // 协议 §2.4：新增事件必须在文档登记后方可使用；未登记的一律忽略（不崩）。
                    Debug.WriteLine($"{LogPrefix} 未登记的事件 {name}，已忽略。");
                    break;
            }
        }
        catch (JsonException ex)
        {
            Debug.WriteLine($"{LogPrefix} 事件 {name} 载荷解析失败：{ex.Message}");
        }
        catch (Exception ex)
        {
            // 订阅方抛异常不能反噬读循环。
            Debug.WriteLine($"{LogPrefix} 事件 {name} 的订阅方抛出异常：{ex}");
        }
    }

    /* ------------------------------------------------------------------ *
     * 宿主方法（协议 §3.3）
     * ------------------------------------------------------------------ */

    /// <summary>
    /// 注册一个宿主方法（Node 反向请求 C# 的能力，如 <c>host:pickArchive</c>）。
    /// 处理器参数是**位置参数数组**的克隆，可安全长期持有。
    /// </summary>
    /// <param name="name">方法名，必须以 <c>host:</c> 开头（协议 §3.3）。</param>
    /// <param name="handler">处理器；返回 null 表示"用户取消"，会被序列化成 JSON null。</param>
    public void RegisterHostMethod(string name, Func<JsonElement[], Task<object?>> handler)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        ArgumentNullException.ThrowIfNull(handler);
        if (!name.StartsWith("host:", StringComparison.Ordinal))
        {
            throw new ArgumentException($"宿主方法名必须以 host: 开头（协议 §3.3），收到：{name}", nameof(name));
        }

        ThrowIfDisposed();
        _hostMethods[name] = handler;
    }

    /// <summary>同步处理器的便捷重载（内部包成 <see cref="Task.FromResult{TResult}(TResult)"/>）。</summary>
    public void RegisterHostMethod(string name, Func<JsonElement[], object?> handler)
    {
        ArgumentNullException.ThrowIfNull(handler);
        RegisterHostMethod(name, args => Task.FromResult(handler(args)));
    }

    /// <summary>注销宿主方法；返回是否确实注销了。</summary>
    public bool UnregisterHostMethod(string name) => _hostMethods.TryRemove(name, out _);

    /// <summary>
    /// 处理一条 Node → C# 的反向请求。
    ///
    /// **未注册的方法必须回 <c>ok:false</c>**：静默成功会让 Node 侧以为拿到了路径（null 与失败不可分），
    /// 用户看到的是"选完文件什么都没发生"。失败文案里带上方法名，便于直接定位到是哪个能力没接。
    /// </summary>
    private async Task HandleHostRequestAsync(string id, string method, JsonElement root)
    {
        var args = Array.Empty<JsonElement>();
        if (root.TryGetProperty("params", out var paramsElement) && paramsElement.ValueKind == JsonValueKind.Array)
        {
            var list = new List<JsonElement>();
            foreach (var item in paramsElement.EnumerateArray()) list.Add(item.Clone());
            args = list.ToArray();
        }

        var ok = true;
        object? value = null;
        string? error = null;

        if (!_hostMethods.TryGetValue(method, out var handler))
        {
            ok = false;
            error = $"未注册的宿主方法：{method}。Shell 或页面必须先用 CoreBridge.RegisterHostMethod 注册它。";
            Debug.WriteLine($"{LogPrefix} {error}");
        }
        else
        {
            try
            {
                value = await handler(args).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                ok = false;
                error = $"宿主方法 {method} 执行失败：{ex.Message}";
                Debug.WriteLine($"{LogPrefix} {error}");
            }
        }

        try
        {
            // 手写 JsonObject 而不是匿名类型：成功时**必须**带上 value 键（哪怕是 null），
            // 与协议 §2.2 的形状逐字一致，避免 Node 侧把"缺键"读成 undefined。
            var response = new JsonObject { ["id"] = id, ["ok"] = ok };
            if (ok)
            {
                response["value"] = value is null ? null : JsonSerializer.SerializeToNode(value, JsonOut);
            }
            else
            {
                response["error"] = error ?? "宿主方法执行失败。";
            }

            await WriteLineAsync(response.ToJsonString(JsonOut), CancellationToken.None).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"{LogPrefix} 回写宿主方法 {method} 的响应失败：{ex.Message}");
        }
    }

    /// <summary>
    /// 协议 §3.3 的安全硬边界：<c>host:openExternal</c> **只放行 http/https**。
    ///
    /// 为什么要在 C# 侧独立再校验一次：Node 侧的实现可能被绕过或将来放宽，而这里是真正
    /// 调用系统浏览器的地方 —— 不信任对端传来的 scheme 是零成本的纵深防御。
    /// </summary>
    public static bool IsAllowedExternalUrl(string? url, out string? reason)
    {
        if (string.IsNullOrWhiteSpace(url))
        {
            reason = "链接不能为空。";
            return false;
        }

        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri))
        {
            reason = $"链接格式不正确：{url}";
            return false;
        }

        if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
        {
            reason = $"出于安全考虑，只允许打开 http/https 链接（收到 {uri.Scheme}://）。";
            return false;
        }

        reason = null;
        return true;
    }

    /* ------------------------------------------------------------------ *
     * 退出与清理
     * ------------------------------------------------------------------ */

    /// <summary>进程 Exited 回调（可能在任意线程）。</summary>
    private void OnProcessExited(object? sender, EventArgs e)
    {
        if (sender is Process process) NotifyBackendExited(process);
    }

    /// <summary>
    /// 统一的退出处理：失败所有在途请求，并在**非主动关闭**时通知界面"后端已断开"。
    /// 幂等（<see cref="Interlocked.Exchange(ref int, int)"/> 只放行一次）。
    /// </summary>
    private void NotifyBackendExited(Process? process)
    {
        if (Interlocked.Exchange(ref _exitNotified, 1) == 1) return;

        int? exitCode = null;
        try
        {
            if (process is not null && process.HasExited) exitCode = process.ExitCode;
        }
        catch (Exception)
        {
            // 进程对象已释放/句柄失效：退出码未知，如实报告"未知"。
        }

        var reason = BuildExitReason(exitCode);
        FailPendingRequests(reason);

        if (_shuttingDown || _disposed)
        {
            Debug.WriteLine($"{LogPrefix} 侧车进程已按请求退出（退出码 {exitCode?.ToString(CultureInfo.InvariantCulture) ?? "未知"}）。");
            return;
        }

        Debug.WriteLine($"{LogPrefix} 侧车进程异常退出：{reason}");
        try
        {
            BackendExited?.Invoke(this, reason);
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"{LogPrefix} BackendExited 订阅方抛出异常：{ex}");
        }
    }

    private string BuildExitReason(int? exitCode)
    {
        var codeText = exitCode?.ToString(CultureInfo.InvariantCulture) ?? "未知";
        var tail = StderrTail;
        var lastLines = tail.Count == 0
            ? "（stderr 无输出）"
            : string.Join("\n", tail.Skip(Math.Max(0, tail.Count - 5)));

        return $"后端已断开：桥接进程已退出（退出码 {codeText}）。界面已禁用写操作，请重启应用。\n最近 stderr：\n{lastLines}";
    }

    private void FailPendingRequests(string reason)
    {
        foreach (var pair in _pending)
        {
            if (_pending.TryRemove(pair.Key, out var tcs))
            {
                tcs.TrySetException(new BridgeCallException(reason));
            }
        }
    }

    /// <summary>
    /// 优雅关闭（协议 §3.2）：先发 <c>__shutdown</c>，最多等
    /// <see cref="CoreBridgeOptions.ShutdownTimeout"/>（默认 3 秒），仍不退出则强杀**进程树**
    /// （dsh 可能派生了孙进程，只杀直接子进程会留孤儿）。
    ///
    /// 幂等、不抛异常 —— 退出路径上的失败只记 Debug，不能反过来阻断应用退出。
    /// </summary>
    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        _disposed = true;
        _shuttingDown = true;

        var process = _process;
        if (process is not null)
        {
            try
            {
                if (!process.HasExited)
                {
                    // 先给对端机会 flush 并自行退出；这里用 CallAsync 是为了顺带拿到 ok:false 的诊断。
                    var shutdown = await CallAsync<JsonElement>(Channels.Builtin.Shutdown, _options.ShutdownTimeout)
                        .ConfigureAwait(false);
                    if (!shutdown.Ok) Debug.WriteLine($"{LogPrefix} __shutdown 未正常应答：{shutdown.Error}");

                    try
                    {
                        await process.WaitForExitAsync().WaitAsync(_options.ShutdownTimeout).ConfigureAwait(false);
                    }
                    catch (TimeoutException)
                    {
                        Debug.WriteLine($"{LogPrefix} __shutdown 后 {_options.ShutdownTimeout.TotalSeconds:0.#} 秒内未退出，强杀进程树。");
                    }
                }
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"{LogPrefix} 优雅关闭失败（将强杀）：{ex.Message}");
            }

            KillTreeIfAlive(process);

            try
            {
                process.Exited -= OnProcessExited;
            }
            catch (Exception)
            {
                // 忽略：进程对象可能已释放。
            }
        }

        FailPendingRequests("后端桥接已关闭。");
        NotifyBackendExited(process);

        try
        {
            if (_stdin is not null) await _stdin.DisposeAsync().ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"{LogPrefix} 关闭 stdin 失败：{ex.Message}");
        }

        _stdin = null;
        try
        {
            process?.Dispose();
        }
        catch (Exception)
        {
            // 忽略。
        }

        _process = null;
        _writeLock.Dispose();
        _startLock.Dispose();
        Debug.WriteLine($"{LogPrefix} 桥接已释放。");
    }

    private static void KillTreeIfAlive(Process process)
    {
        try
        {
            if (process.HasExited) return;
            process.Kill(entireProcessTree: true);
            // 给内核一点时间回收句柄；失败不影响后续（进程正在退出）。
            process.WaitForExit(2000);
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"{LogPrefix} 强杀进程树失败：{ex.Message}");
        }
    }

    /* ------------------------------------------------------------------ *
     * 路径解析
     * ------------------------------------------------------------------ */

    /// <summary>桥接脚本：默认 &lt;exe 目录&gt;/bridge/server.cjs（csproj 会把 dist/bridge 复制到这里）。</summary>
    private string ResolveBridgeEntry()
    {
        if (_options.BridgeEntry is { Length: > 0 } entry) return Path.GetFullPath(entry);
        return Path.Combine(AppContext.BaseDirectory, "bridge", "server.cjs");
    }

    /// <summary>
    /// 推断启动器根目录（即 <c>--home</c>），优先级：
    /// <list type="number">
    /// <item>环境变量 <c>WHALES_LAUNCHER_ROOT</c>（core 也用这个变量定位缓存目录，两边必须一致）；</item>
    /// <item>从 exe 目录向上找「<c>package.json</c> + <c>src/</c> 同时存在」的目录（开发期 exe 在
    /// <c>desktop/src/.../bin/&lt;cfg&gt;/&lt;tfm&gt;/&lt;rid&gt;/</c> 深处，需要上溯多层；
    /// 要求 <c>src/</c> 是为了跳过仓库里那些"有 package.json 但不是根"的目录，例如 <c>.probe/</c>）；</item>
    /// <item>兜底：exe 目录自身。</item>
    /// </list>
    /// 发布形态下请用 <see cref="CoreBridgeOptions.HomeDir"/> 显式指定，别依赖启发式。
    /// </summary>
    public static string ResolveDefaultHome()
    {
        var fromEnv = Environment.GetEnvironmentVariable("WHALES_LAUNCHER_ROOT");
        if (!string.IsNullOrWhiteSpace(fromEnv))
        {
            try
            {
                return Path.GetFullPath(fromEnv);
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"{LogPrefix} WHALES_LAUNCHER_ROOT 无法解析（{ex.Message}），改用兜底逻辑。");
            }
        }

        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (var depth = 0; depth < 12 && dir is not null; depth++)
        {
            if (File.Exists(Path.Combine(dir.FullName, "package.json"))
                && Directory.Exists(Path.Combine(dir.FullName, "src")))
            {
                return dir.FullName;
            }

            dir = dir.Parent;
        }

        return AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
    }

    private void ThrowIfDisposed()
    {
        if (_disposed) throw new ObjectDisposedException(nameof(CoreBridge));
    }

    private static string Truncate(string text, int max) => text.Length <= max ? text : text[..max] + "…";

    /// <summary>上行请求报文（协议 §2.1）。属性名靠 camelCase 策略映射成 id/method/params。</summary>
    private sealed record BridgeRequest(string Id, string Method, object?[] Params);
}

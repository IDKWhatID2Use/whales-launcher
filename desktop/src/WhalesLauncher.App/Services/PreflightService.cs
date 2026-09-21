using System.Diagnostics;
using WhalesLauncher.Models;

namespace WhalesLauncher.Services;

/// <summary>
/// 环境自检的服务层入口。
///
/// ### 职责边界
/// 这一层**只做逻辑**：什么时候跑自检、用哪组选项、超时给多少、把便携版 Node 铺设到哪。
/// 弹确认框、显示进度、展示报告都在 <c>Shell/PreflightPresenter.cs</c> —— 约定 §4 明确
/// 禁止 Service 直接弹 UI（否则这一层就无法脱离窗口复用与测试）。
///
/// ### 为什么自检要分两次调用
/// 首次启动要同时满足两件互相矛盾的要求：
///  - **快**：用户点开图标后几秒内就该看到界面与结论，不能先等几分钟的下载；
///  - **全自动**：缺引擎时把引擎装上，缺运行时把运行时备好，不需要用户自己动手。
///
/// 因此拆成：
/// <list type="number">
///   <item>轻量自检（<see cref="RunAsync"/>，本地修复 + 联网探测，秒级）—— 拿到"缺什么"；</item>
///   <item>按需深度自检（<c>InstallEngine = true</c>，可能数分钟）—— 把缺的装上。</item>
/// </list>
/// 这样"这台机器本来就齐"的用户只经历第一步，一秒都不多等。
/// </summary>
public static class PreflightService
{
    /// <summary>
    /// 轻量自检的超时。
    ///
    /// 上限的构成：Node 探针（每个候选一次，10s 超时）+ <c>npm -v</c>（90s 上限）+
    /// registry 探测（8s）。给 3 分钟是给"磁盘很慢 / 首次 npm 调用"留余量，
    /// 正常机器上这一步在 1 秒内结束。
    /// </summary>
    public static readonly TimeSpan QuickTimeout = TimeSpan.FromMinutes(3);

    /// <summary>
    /// 带引擎自动安装的自检超时。
    ///
    /// 与 <c>src/core/engine.ts</c> 的 <c>INSTALL_TIMEOUT_MS</c>（30 分钟）对齐后略放宽：
    /// 这一侧必须**比 Node 侧更晚**超时，否则我们会在 core 还在正常下载依赖时单方面掐断，
    /// 留下一个"报告说失败、其实装好了"的错位状态。
    /// </summary>
    public static readonly TimeSpan InstallTimeout = TimeSpan.FromMinutes(40);

    /// <summary>等待外壳挂载 XamlRoot 的上限（后端装配常常早于窗口 Loaded）。</summary>
    public static readonly TimeSpan ShellAttachTimeout = TimeSpan.FromSeconds(20);

    /// <summary>
    /// 最近一次成功的自检报告（进程内缓存）。
    ///
    /// 存在的理由：设置页**不允许**在加载时自动发起请求（规范 §9.9），但用户打开设置页时
    /// 理应看到"刚才启动时那次自检说了什么"。缓存这一份，页面就能零网络代价地展示结论，
    /// 只有用户主动点「运行环境自检」才会重新跑。
    /// </summary>
    public static PreflightReport? LastReport { get; private set; }

    /// <summary>按选项挑选超时：要装引擎就得给长超时。</summary>
    public static TimeSpan TimeoutFor(PreflightOptions? options)
        => options?.InstallEngine == true ? InstallTimeout : QuickTimeout;

    /// <summary>
    /// 调一次 Node 侧自检（成功时顺带刷新 <see cref="LastReport"/>）。
    ///
    /// 刻意**不接受取消令牌**：<see cref="CoreBridge.CallAsync{T}"/> 的签名里没有它，而自检
    /// 在 Node 侧是单飞的、且中途放弃会留下"装了一半"的目录 —— 与其做一个假的取消，
    /// 不如按现状如实告诉用户"这一步不能中断"（见 <c>PreflightPresenter</c> 的安装前确认）。
    /// @param options 自检选项；null 表示"按契约默认"（只做本地修复）。
    /// @returns 桥接调用结果（传输层失败也在这里以 <c>Ok=false</c> 返回，不抛错）。
    /// </summary>
    public static async Task<BridgeResult<PreflightReport>> RunAsync(PreflightOptions? options = null)
    {
        var payload = options ?? new PreflightOptions();
        var result = await AppServices.Bridge
            .CallAsync<PreflightReport>(Channels.LauncherPreflight, TimeoutFor(options), payload)
            .ConfigureAwait(true);

        if (result.Ok && result.Value is not null)
        {
            LastReport = result.Value;
        }

        return result;
    }

    /// <summary>
    /// 确保本机有一份可用的 Node（缺则下载便携版）。
    ///
    /// 调用前应先确认"确实没有可用的 Node"（<see cref="NodeRuntimeLocator.ResolveAsync"/>），
    /// 否则会白下载 30MB —— 本方法自身只判"自备运行时是否已在位"。
    /// @param root 启动器根目录。
    /// @param progress 进度回调（阶段 + 字节数）。
    /// @param ct 取消令牌。
    /// @returns 铺设结果。
    /// </summary>
    public static Task<NodeProvisionResult> EnsurePortableNodeAsync(
        string root,
        IProgress<NodeProvisionProgress>? progress = null,
        CancellationToken ct = default)
    {
        Debug.WriteLine($"[Preflight] 开始获取便携版 Node：root={root}");
        return NodeProvisioner.EnsureAsync(root, progress, ct);
    }

    /// <summary>
    /// 本机是否已有**任何**可用的 Node 运行时（含自备运行时）。
    ///
    /// 与 <see cref="NodeRuntimeLocator.ResolveAsync"/> 的差别：这里把"启动器根"一并带上，
    /// 因此自备运行时也会被探到 —— 判断"要不要下载"必须用这个口径，否则已经下载过的
    /// 机器会被反复提示下载。
    /// @param root 启动器根目录。
    /// @param ct 取消令牌。
    /// @returns 可用的运行时报告。
    /// </summary>
    public static Task<NodeRuntimeReport> DetectRuntimeAsync(string root, CancellationToken ct = default)
        => NodeRuntimeLocator.ResolveAsync(configuredPath: null, home: root, ct: ct);
}

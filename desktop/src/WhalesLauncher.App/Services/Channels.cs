namespace WhalesLauncher.Services;

/// <summary>
/// 桥接通道名 —— 与 <c>src/shared/contracts.ts</c> 的 <c>CH</c>（<c>:552-617</c>）**逐字同源**。
///
/// 协议 §3.1：方法名 = <c>CH</c> 常量的字面值（含冒号），一路到底，不做大小写或分隔符转换。
/// 因此这里的常量既是"方法名"也是"通道名"，两件事不需要各自维护一份。
///
/// 共 <see cref="Count"/> 条：<c>launcher</c> 4 + <c>instance</c> 8 + <c>engine</c> 4 + <c>plugin</c> 9
/// + <c>settings</c> 4 + <c>saves</c> 2 + <c>pack</c> 3 + <c>log</c> 2 + <c>app</c> 4 = 40。
/// <see cref="All"/> 供 <c>__handshake</c> 断言（协议 §5.3：不一致直接失败）。
/// </summary>
public static class Channels
{
    /* ---------------- launcher ---------------- */

    public const string LauncherGetConfig = "launcher:getConfig";
    public const string LauncherSetConfig = "launcher:setConfig";

    /// <summary>探测运行 dsh 所需的 Node 运行时（<c>refresh=true</c> 时忽略缓存）。</summary>
    public const string LauncherDetectNode = "launcher:detectNode";

    /// <summary>
    /// 环境与依赖自检（**本轮新增**；旧 Electron 版没有这个能力）。
    ///
    /// 参数 <c>[options?: PreflightOptions]</c>，返回 <see cref="WhalesLauncher.Models.PreflightReport"/>。
    /// <c>installEngine=true</c> 且本机无引擎时会联网安装 dsh（首次数分钟），
    /// 因此调用方必须用 <see cref="PreflightService.PreflightTimeout"/> 之类的长超时。
    /// </summary>
    public const string LauncherPreflight = "launcher:preflight";

    /* ---------------- instance ---------------- */

    public const string InstanceList = "instance:list";
    public const string InstanceCreate = "instance:create";
    public const string InstanceGet = "instance:get";
    public const string InstanceUpdate = "instance:update";
    public const string InstanceRemove = "instance:remove";
    public const string InstanceLaunch = "instance:launch";
    public const string InstanceStop = "instance:stop";
    public const string InstanceOpenFolder = "instance:openFolder";

    /* ---------------- engine ---------------- */

    public const string EngineList = "engine:list";
    public const string EngineAvailable = "engine:available";
    public const string EngineInstall = "engine:install";
    public const string EngineRemove = "engine:remove";

    /* ---------------- plugin ---------------- */

    public const string PluginInventory = "plugin:inventory";
    public const string PluginAdd = "plugin:add";
    public const string PluginRemove = "plugin:remove";
    public const string PluginSetBundleEnabled = "plugin:setBundleEnabled";

    /// <summary>安装「随实例搬运」的本地插件（zip / GitHub / 文件夹）。</summary>
    public const string PluginInstall = "plugin:install";

    /// <summary>从实例内删除一个本地插件。</summary>
    public const string PluginRemoveLocal = "plugin:removeLocal";

    /// <summary>列出实例内的本地插件（<c>home/plugins</c>）。</summary>
    public const string PluginListLocal = "plugin:listLocal";

    /// <summary>选择插件压缩包（zip）—— 走宿主方法 <c>host:pickArchive</c>。</summary>
    public const string PluginPickArchive = "plugin:pickArchive";

    /// <summary>选择插件文件夹 —— 走宿主方法 <c>host:pickFolder</c>。</summary>
    public const string PluginPickFolder = "plugin:pickFolder";

    /* ---------------- settings ---------------- */

    public const string SettingsRead = "settings:read";
    public const string SettingsWrite = "settings:write";
    public const string SettingsShareConflicts = "settings:shareConflicts";
    public const string SettingsResolveShareConflict = "settings:resolveShareConflict";

    /* ---------------- saves ---------------- */

    public const string SavesList = "saves:list";
    public const string SavesOpenFolder = "saves:openFolder";

    /* ---------------- pack ---------------- */

    public const string PackExport = "pack:export";
    public const string PackImport = "pack:import";
    public const string PackPickFile = "pack:pickFile";

    /* ---------------- log（推送，无 invoke） ---------------- */

    public const string LogChunk = "log:chunk";
    public const string LogState = "log:state";

    /* ---------------- app ---------------- */

    public const string AppVersion = "app:version";
    public const string AppOpenExternal = "app:openExternal";
    public const string AppMenu = "app:menu";
    public const string AppMenuCommand = "app:menuCommand";

    /// <summary>通道总数（握手断言用）。</summary>
    public const int Count = 40;

    /// <summary>全部通道，顺序与契约 <c>CH</c> 的书写顺序一致。</summary>
    public static readonly string[] All =
    {
        LauncherGetConfig, LauncherSetConfig, LauncherDetectNode, LauncherPreflight,
        InstanceList, InstanceCreate, InstanceGet, InstanceUpdate, InstanceRemove,
        InstanceLaunch, InstanceStop, InstanceOpenFolder,
        EngineList, EngineAvailable, EngineInstall, EngineRemove,
        PluginInventory, PluginAdd, PluginRemove, PluginSetBundleEnabled,
        PluginInstall, PluginRemoveLocal, PluginListLocal, PluginPickArchive, PluginPickFolder,
        SettingsRead, SettingsWrite, SettingsShareConflicts, SettingsResolveShareConflict,
        SavesList, SavesOpenFolder,
        PackExport, PackImport, PackPickFile,
        LogChunk, LogState,
        AppVersion, AppOpenExternal, AppMenu, AppMenuCommand,
    };

    /// <summary>
    /// 只出现在 Node → C# 方向、没有 invoke 的推送通道（对应旧 <c>PUSH_ONLY_CHANNELS</c>，<c>src/main/ipc.ts:34</c>）。
    ///
    /// 它们不是"可调用方法"：若 Node 侧的手写列表只导出 37 条 invoke 通道，
    /// 握手只对这两条缺席作告警处理（见 <see cref="CoreBridge"/> 的握手校验）。
    /// </summary>
    public static readonly IReadOnlySet<string> PushOnly =
        new HashSet<string>(StringComparer.Ordinal) { LogChunk, LogState };

    /// <summary>内建方法（协议 §3.2，非业务，<c>__</c> 前缀）。</summary>
    public static class Builtin
    {
        /// <summary>启动后必须首先调用；返回协议版本与两端通道/宿主方法清单。</summary>
        public const string Handshake = "__handshake";

        /// <summary>存活探测。</summary>
        public const string Ping = "__ping";

        /// <summary>优雅退出；Node 侧应在 flush 后自行 <c>process.exit(0)</c>。</summary>
        public const string Shutdown = "__shutdown";
    }

    /// <summary>宿主方法（协议 §3.3，Node → C#，<c>host:</c> 前缀）。</summary>
    public static class Host
    {
        /// <summary>选择插件压缩包（zip）。参数 <c>[{title}]</c>，返回选中路径或 null。</summary>
        public const string PickArchive = "host:pickArchive";

        /// <summary>选择插件文件夹。参数 <c>[{title}]</c>，返回选中路径或 null。</summary>
        public const string PickFolder = "host:pickFolder";

        /// <summary>选择实例包文件。参数 <c>[{title}]</c>，返回选中路径或 null。</summary>
        public const string PickPackFile = "host:pickPackFile";

        /// <summary>另存为。参数 <c>[{title, suggestedName, defaultDir}]</c>，返回目标路径或 null。</summary>
        public const string SaveFile = "host:saveFile";

        /// <summary>系统下载目录。参数 <c>[]</c>，返回路径。</summary>
        public const string DownloadsDir = "host:downloadsDir";

        /// <summary>用资源管理器打开路径。参数 <c>[{path}]</c>，无返回。</summary>
        public const string OpenPath = "host:openPath";

        /// <summary>用系统浏览器打开链接（**仅 http/https**）。参数 <c>[{url}]</c>，无返回。</summary>
        public const string OpenExternal = "host:openExternal";

        /// <summary>同步消息框。参数 <c>[{title, message, detail, buttons}]</c>，返回按钮索引。</summary>
        public const string MessageBox = "host:messageBox";

        /// <summary>全部宿主方法名（握手时与 Node 侧的清单比对）。</summary>
        public static readonly string[] All =
        {
            PickArchive, PickFolder, PickPackFile, SaveFile,
            DownloadsDir, OpenPath, OpenExternal, MessageBox,
        };
    }
}

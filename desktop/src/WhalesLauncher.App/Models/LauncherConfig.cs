namespace WhalesLauncher.Models;

/// <summary>
/// 全局配置（<c>launcher.json</c>，<c>launcher:getConfig</c> / <c>launcher:setConfig</c>）。
/// 来源：<c>src/shared/contracts.ts:410-429</c>。
/// </summary>
public sealed class LauncherConfig
{
    public int SchemaVersion { get; set; }

    /// <summary>用于凭证继承的"主 home"（通常是 <c>~/.dsh</c>）。</summary>
    public string PrimaryHome { get; set; } = string.Empty;

    /// <summary>取值见 <see cref="ThemeValues"/>。</summary>
    public string Theme { get; set; } = ThemeValues.Dark;

    /// <summary>最近一次启动的实例 id，没有为 null。</summary>
    public string? LastInstanceId { get; set; }

    /// <summary>删除前是否二次确认。</summary>
    public bool ConfirmOnDelete { get; set; }

    /// <summary>引擎安装用的 npm registry。</summary>
    public string EngineRegistry { get; set; } = string.Empty;

    /// <summary>
    /// 运行 dsh 引擎所用的 Node.js 可执行文件（绝对路径）。
    ///
    /// null = 自动探测（环境变量 <c>WHALES_NODE_PATH</c> → 启动器自身 → 系统 PATH → 常见安装位置）。
    /// 之所以可配：dsh 依赖的原生模块**拒绝 Electron 内置运行时**，必须用独立的 Node.js；
    /// 当 Node 不在 PATH 上（或装了多个版本）时，用户需要一个显式出口。
    /// </summary>
    public string? NodePath { get; set; }

    /// <summary>启动器根目录（只读，由 Node 侧注入，落盘时会被剥掉）。</summary>
    public string? RootDir { get; set; }
}

/// <summary><c>LauncherConfig.theme</c> 的取值。来源：<c>src/shared/contracts.ts:414</c>。</summary>
public static class ThemeValues
{
    public const string Dark = "dark";
    public const string Light = "light";

    /// <summary>全部取值。</summary>
    public static readonly string[] All = { Dark, Light };
}

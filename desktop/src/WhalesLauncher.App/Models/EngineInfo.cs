namespace WhalesLauncher.Models;

/// <summary>
/// 一个 dsh 引擎版本。来源：<c>src/shared/contracts.ts:155-165</c>。
/// </summary>
public sealed class EngineInfo
{
    public string Version { get; set; } = string.Empty;

    /// <summary>引擎目录绝对路径。</summary>
    public string Dir { get; set; } = string.Empty;

    public bool Installed { get; set; }

    /// <summary>dsh 主入口绝对路径，未安装为 null。</summary>
    public string? BinPath { get; set; }

    /// <summary>占用该引擎的实例 id 列表。</summary>
    public List<string> UsedBy { get; set; } = new();

    /// <summary>目录体积（字节），未知为 null。</summary>
    public long? SizeBytes { get; set; }
}

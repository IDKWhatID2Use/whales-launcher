namespace WhalesLauncher.Services;

/// <summary>
/// 实例 / profile 命名校验。
///
/// 逐行移植自旧实现 <c>src/renderer/util/names.ts</c>，规则必须与 dsh 的 <c>resolveProfileDir</c> 一致：
/// 名称为空、含 `/`、含 `\`、等于 `.`、`..`、`node_modules` 一律拒绝；`desktop` 保留给桌面宿主。
/// 启动器在此之上再补 Windows 文件名字符与长度约束，避免"创建成功但启动失败"。
///
/// ⚠️ 注意：真正的目录名由 core 的 <c>makeDirName</c> 结合去重规则生成，这里的
/// <see cref="PreviewDirName"/> 仅用于界面预览。
/// </summary>
public static class NameValidator
{
    /// <summary>实例名最大长度（兼顾 Windows 路径长度限制）。</summary>
    public const int NameMaxLength = 48;

    /// <summary>dsh 与启动器共同拒绝的保留名。</summary>
    public static readonly string[] ForbiddenNames = { ".", "..", "node_modules", "desktop" };

    /// <summary>校验实例名；返回中文错误消息，合法时返回 <c>null</c>。</summary>
    public static string? ValidateInstanceName(string raw)
    {
        var name = raw;

        if (name.Length == 0) return "实例名不能为空";
        if (name.Trim().Length == 0) return "实例名不能只有空格";
        if (name != name.Trim()) return "实例名首尾不能包含空格";
        if (name.Contains('/') || name.Contains('\\')) return "实例名不能包含 / 或 \\";

        if (Array.IndexOf(ForbiddenNames, name) >= 0)
        {
            if (name == "desktop") return "desktop 已保留给桌面宿主，不能用作实例名";
            return $"实例名不能是 {name}";
        }

        foreach (var ch in name)
        {
            // 对应旧实现的正则 [<>:"|?*\u0000-\u001f]
            if (ch is '<' or '>' or ':' or '"' or '|' or '?' or '*' || ch <= '\u001f')
            {
                return "实例名不能包含 < > : \" | ? * 等字符";
            }
        }

        if (name.EndsWith('.') || name.EndsWith(' ')) return "实例名不能以点或空格结尾";
        if (name.Length > NameMaxLength) return $"实例名最长 {NameMaxLength} 个字符";

        return null;
    }

    /// <summary>
    /// 由显示名推导目录名（**仅用于界面预览**）。
    /// 真实目录名由 core 的 <c>makeDirName</c> 生成，以后端返回为准。
    /// </summary>
    public static string PreviewDirName(string name)
    {
        var cleaned = name.Trim();
        var buffer = new System.Text.StringBuilder(cleaned.Length);

        foreach (var ch in cleaned)
        {
            if (ch is '<' or '>' or ':' or '"' or '|' or '?' or '*' or '\\' or '/' || ch <= '\u001f')
            {
                buffer.Append('-');
            }
            else
            {
                buffer.Append(ch);
            }
        }

        // 空白折叠为单个短横线
        var collapsed = System.Text.RegularExpressions.Regex.Replace(buffer.ToString(), @"\s+", "-");
        // 去掉首尾的点/短横线/空白
        collapsed = System.Text.RegularExpressions.Regex.Replace(collapsed, @"^[.\-\s]+", string.Empty);
        collapsed = System.Text.RegularExpressions.Regex.Replace(collapsed, @"[.\-\s]+$", string.Empty);

        if (collapsed.Length > NameMaxLength) collapsed = collapsed.Substring(0, NameMaxLength);
        return collapsed.Length > 0 ? collapsed : "instance";
    }

    /// <summary>profile 名（默认与目录名一致）。</summary>
    public static string? ValidateProfileName(string raw)
    {
        if (raw.Length == 0) return "profile 名不能为空";
        if (raw != raw.Trim()) return "profile 名首尾不能包含空格";
        return ValidateInstanceName(raw);
    }
}

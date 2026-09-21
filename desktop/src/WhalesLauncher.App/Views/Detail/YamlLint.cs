namespace WhalesLauncher.Views.Detail;

/// <summary>
/// <c>settings.yaml</c> 的**明显问题**提示（不是 YAML 校验器）。
///
/// 规范 §9.4 的原文要求：「前端只标红可判定问题（空内容、行尾空白、明显缩进错误）；
/// **不得**声称"YAML 合法"（真正的校验由后端 <c>profile.validateYaml</c> 给出）」。
///
/// 因此这里只做**无需解析器**就能确定的三件事，并且返回的每条文案都自带"这是提示"的语气。
/// 刻意不引第三方 YAML 解析器：那会让 C# 侧出现第二份校验规则，与后端结果可能不一致，
/// 反而制造"界面说合法、后端说不合法"的新问题。
/// </summary>
public static class YamlLint
{
    /// <summary>单条提示最多报几个行号，避免一条问题刷屏。</summary>
    private const int MaxLinesPerKind = 3;

    /// <summary>检查文档，返回中文提示（空集合 = 未发现明显问题）。</summary>
    public static IReadOnlyList<string> Inspect(string? text)
    {
        var findings = new List<string>();
        if (string.IsNullOrEmpty(text))
        {
            findings.Add("内容为空，保存后将生成一份新的 settings.yaml");
            return findings;
        }

        var lines = text.Split('\n');
        var trailingWhitespace = new List<int>();
        var tabIndent = new List<int>();
        var indentClash = new List<int>();

        var previousIndent = -1;
        var previousWasIndented = false;

        for (var i = 0; i < lines.Length; i++)
        {
            var raw = lines[i];
            var line = raw.EndsWith('\r') ? raw[..^1] : raw;
            var lineNumber = i + 1;

            if (line.Length > 0 && (line[^1] == ' ' || line[^1] == '\t'))
            {
                trailingWhitespace.Add(lineNumber);
            }

            if (line.StartsWith('\t'))
            {
                tabIndent.Add(lineNumber);
            }

            // 「明显缩进错误」的保守判定：缩进量比上一行多，但两者都不是同级列表项或序列项，
            // 这几乎一定是漏了冒号。真正的解析交给后端，这里只挑最典型的一种。
            var indent = CountIndent(line);
            var isStructural = IsStructuralLine(line);
            if (previousWasIndented && previousIndent >= 0 && indent > previousIndent && !isStructural)
            {
                indentClash.Add(lineNumber);
            }

            if (!string.IsNullOrWhiteSpace(line))
            {
                previousIndent = indent;
                previousWasIndented = isStructural;
            }
        }

        Append(findings, trailingWhitespace, "行尾有多余空白");
        Append(findings, tabIndent, "使用了 Tab 缩进（YAML 不允许 Tab 作为缩进）");
        Append(findings, indentClash, "缩进层级可疑（上一行可能缺少冒号）");

        return findings;
    }

    private static void Append(List<string> findings, List<int> lineNumbers, string message)
    {
        if (lineNumbers.Count == 0)
        {
            return;
        }

        var shown = Math.Min(lineNumbers.Count, MaxLinesPerKind);
        var text = string.Join("、", lineNumbers.Take(shown).Select(number => $"第 {number} 行"));
        if (lineNumbers.Count > shown)
        {
            text += $" 等 {lineNumbers.Count} 处";
        }

        findings.Add($"{text}：{message}");
    }

    private static int CountIndent(string line)
    {
        var count = 0;
        foreach (var ch in line)
        {
            if (ch == ' ') count++;
            else if (ch == '\t') count++;
            else break;
        }

        return count;
    }

    /// <summary>是否是一条"结构行"（映射项 / 序列项 / 文档分隔 / 注释）。</summary>
    private static bool IsStructuralLine(string line)
    {
        var trimmed = line.TrimStart();
        if (trimmed.Length == 0) return false;
        if (trimmed.StartsWith('#')) return true;
        if (trimmed.StartsWith('-')) return true;
        if (trimmed.StartsWith("---", StringComparison.Ordinal)) return true;

        // 映射项：必须在**引号外**出现冒号，粗暴用第一个冒号判断足够（误判只会少报，不会误报）
        return trimmed.Contains(':');
    }
}

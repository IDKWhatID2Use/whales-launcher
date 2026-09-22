using System.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Windows.System;

namespace WhalesLauncher.Views.Detail;

/// <summary>
/// YAML 纯文本编辑器（视觉规范 §6.5 的「YAML 编辑降级方案」）。
///
/// <b>这是降级实现</b>：规范首选 WebView2 + Monaco（§6.5 / §11 U04），
/// 本控件走的是规范给出的替代路径 ——「<c>TextBox</c>（<c>AcceptsReturn</c>、
/// <c>TextWrapping=NoWrap</c>、等宽字族）+ 只读行号列」，且降级态下**不做**语法着色。
///
/// <b>已知限制（如实登记，不掩饰）</b>：
/// <list type="bullet">
///   <item><description>行号列与编辑区**各自滚动，不联动**。WinUI 的 <c>TextBox</c> 不公开其内部
///   <c>ScrollViewer</c>，官方也没有"外部行号列"的支持；用只读 <c>TextBox</c> 做行号列后
///   用户在滚动正文时需要自行滚动行号（两者行高一致，滚动量相同即可对齐）。</description></item>
///   <item><description>无语法着色、无折叠、无 diff 高亮 —— 这是降级路径的定义，不伪装。</description></item>
/// </list>
///
/// <b>外露 API</b>：<c>SetDocument(string)</c> / <c>Text</c> / <c>MarkSaved()</c> /
/// <c>IsDirty</c> / <c>IsEditable</c> / <c>ValidationFindings</c> /
/// <c>event EventHandler? DirtyChanged</c> / <c>event EventHandler? SaveRequested</c>（Ctrl+S）。
/// </summary>
public sealed partial class YamlEditorView : UserControl
{
    /// <summary>校验提示最多列出几条（更多会撑高页头，且用户也不会逐条读）。</summary>
    private const int MaxFindings = 3;

    private string _savedText = string.Empty;
    private bool _isDirty;
    private IReadOnlyList<string> _findings = Array.Empty<string>();

    public YamlEditorView()
    {
        InitializeComponent();
        UpdateGutter();
    }

    /// <summary>是否有未保存的更改。</summary>
    public bool IsDirty => _isDirty;

    /// <summary>
    /// 当前文档文本（未 trim，保持用户原样；换行一律归一为 <c>\n</c>）。
    ///
    /// **必须归一**：WinUI 的 <c>TextBox</c> 底层是 RichEdit，它的 <c>Text</c> 用 <c>\r</c>
    /// 作段落分隔符。读入一份 CRLF 的 <c>settings.yaml</c> 再取出 <c>Text</c>，得到的是
    /// **纯 CR** 文本；原样写回磁盘就产出了"只有 \r 没有 \n"的 YAML。
    ///
    /// 实测后果（KREA2 实例）：dsh 的 settings 用 <c>yaml</c> 包解析，它**不把孤立的 \r
    /// 当换行**，于是整份文件被当成一行，报
    /// <c>BLOCK_AS_IMPLICIT_KEY … at line 1, column 15</c>，实例每次启动都崩。
    /// 后端写入前的校验当时用的是 js-yaml（它接受纯 CR），所以这条损坏一路通过校验落了盘。
    /// 归一在这里做，是因为所有 YAML 落盘路径都要经过本类的 <see cref="Text"/>。
    /// </summary>
    public string Text => ToLf(Editor.Text);

    /// <summary>只读/可编辑。读取失败时置 false 并禁用编辑区（规范 §9.4 明确要求不得显示空文档）。</summary>
    public bool IsEditable
    {
        get => Editor.IsReadOnly is false;
        set
        {
            Editor.IsReadOnly = !value;
            Gutter.Opacity = value ? 1.0 : 0.5;
        }
    }

    /// <summary>前端能判定的明显问题（**不是** YAML 合法性结论，见 <see cref="YamlLint"/>）。</summary>
    public IReadOnlyList<string> ValidationFindings => _findings;

    /// <summary>脏标记变化（页头据此显示"有未保存的更改"）。</summary>
    public event EventHandler? DirtyChanged;

    /// <summary>
    /// 用户从编辑器内部发起保存（Ctrl+S）。
    ///
    /// 为什么加速键挂在编辑器上而不是页面上：WinUI 里同一个 <c>KeyboardAccelerator</c> 实例
    /// **不可共享**（规范 §7.2 引用官方原文），页面级再挂一个 Ctrl+S 会与这个冲突。
    /// 焦点在编辑器内——也就是用户实际改 YAML 的时候——由这里触发；
    /// 焦点在别处时，页头「保存」按钮同样可点。
    /// </summary>
    public event EventHandler? SaveRequested;

    /// <summary>载入文档并把它记为"已保存状态"。</summary>
    public void SetDocument(string? text)
    {
        var document = text ?? string.Empty;

        // 直接改 Text 会触发 TextChanged → _isDirty 被置位，因此先写基线再设文本。
        // 基线也归一：TextBox 取回的文本是 CR，若拿原文当基线，装载完成的那一刻就会被判成"有未保存的更改"
        _savedText = ToLf(document);
        Editor.Text = document;
        SetDirty(false);
        UpdateGutter();
        UpdateFindings();
    }

    /// <summary>保存成功后调用：把当前文本记为新的基线。</summary>
    public void MarkSaved()
    {
        _savedText = ToLf(Editor.Text);
        SetDirty(false);
    }

    /// <summary>保存失败时保留脏标记（用户不该以为已经存上了）。</summary>
    public void KeepDirty() => SetDirty(true);

    private void OnEditorTextChanged(object sender, TextChangedEventArgs e)
    {
        SetDirty(!string.Equals(ToLf(Editor.Text), _savedText, StringComparison.Ordinal));

        UpdateGutter();
        UpdateFindings();
    }

    /// <summary>
    /// 换行归一：<c>\r\n</c> 与孤立的 <c>\r</c> 都变成 <c>\n</c>。
    /// 理由见 <see cref="Text"/>（TextBox 用 CR 作段落分隔符，落盘会让 dsh 解析失败）。
    /// </summary>
    private static string ToLf(string? text)
    {
        if (string.IsNullOrEmpty(text))
        {
            return string.Empty;
        }

        return text.IndexOf('\r') < 0 ? text : text.Replace("\r\n", "\n").Replace('\r', '\n');
    }

    private void SetDirty(bool dirty)
    {
        if (_isDirty == dirty)
        {
            return;
        }

        _isDirty = dirty;
        DirtyChanged?.Invoke(this, EventArgs.Empty);
    }

    private void UpdateFindings()
    {
        // 用归一后的文本：CR 文本在 YamlLint 里会被当成一整行，所有行号提示都会错
        _findings = YamlLint.Inspect(ToLf(Editor.Text));

        if (_findings.Count == 0)
        {
            LintText.Visibility = Visibility.Collapsed;
            return;
        }

        var builder = new StringBuilder();
        var shown = Math.Min(_findings.Count, MaxFindings);
        for (var i = 0; i < shown; i++)
        {
            if (i > 0) builder.Append("；");
            builder.Append(_findings[i]);
        }

        if (_findings.Count > shown)
        {
            builder.Append($"；另有 {_findings.Count - shown} 处");
        }

        // 明确声明这不是 YAML 合法性结论（规范 §9.4：不得声称"YAML 合法"）
        builder.Append("（仅为明显问题的提示，真正的校验由后端 profile.validateYaml 给出）");

        LintText.Text = builder.ToString();
        LintText.Visibility = Visibility.Visible;
    }

    /// <summary>
    /// 重建行号列。
    ///
    /// 只在**行数变化**时重写文本：用户连续输入时行数大多不变，跳过可以省掉每次击键一次
    /// 全量字符串构建（长 YAML 下这是可观的成本）。
    /// </summary>
    private void UpdateGutter()
    {
        // 同样要用归一后的文本：TextBox 的 CR 不是 '\n'，不归一会永远只数出 1 行
        var text = ToLf(Editor.Text);
        var lineCount = CountLines(text);
        if (lineCount == _gutterLineCount)
        {
            return;
        }

        _gutterLineCount = lineCount;

        var digits = lineCount.ToString(System.Globalization.CultureInfo.InvariantCulture).Length;
        var builder = new StringBuilder(lineCount * (digits + 1));
        for (var i = 1; i <= lineCount; i++)
        {
            builder.Append(i.ToString(System.Globalization.CultureInfo.InvariantCulture).PadLeft(digits));
            if (i < lineCount) builder.Append('\n');
        }

        Gutter.Text = builder.ToString();
    }

    private int _gutterLineCount = -1;

    /// <summary>行数 = 换行符数 + 1（空文档算 1 行，与编辑器行为一致）。</summary>
    private static int CountLines(string text)
    {
        var count = 1;
        foreach (var ch in text)
        {
            if (ch == '\n') count++;
        }

        return count;
    }

    /// <summary>Tab 插入两个空格（YAML 缩进习惯），而不是把焦点移走。</summary>
    private void OnTabInvoked(KeyboardAccelerator sender, KeyboardAcceleratorInvokedEventArgs args)
    {
        args.Handled = true;

        var start = Editor.SelectionStart;
        Editor.SelectedText = "  ";
        Editor.SelectionStart = start + 2;
        Editor.SelectionLength = 0;
    }

    /// <summary>Ctrl+S：把保存请求交给宿主（页面），由它决定调 <c>settings.write</c> 还是提示。</summary>
    private void OnSaveAccelerator(KeyboardAccelerator sender, KeyboardAcceleratorInvokedEventArgs args)
    {
        args.Handled = true;
        SaveRequested?.Invoke(this, EventArgs.Empty);
    }
}

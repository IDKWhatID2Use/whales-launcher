namespace WhalesLauncher.Services;

/// <summary>轻提示语义。对应视觉规范 §9.10.2 与内置 <c>InfoBarSeverity</c> 的四档。</summary>
public enum ToastKind
{
    Informational,
    Success,
    Warning,
    Error,
}

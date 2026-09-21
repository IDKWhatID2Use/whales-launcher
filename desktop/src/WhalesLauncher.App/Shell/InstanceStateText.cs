using WhalesLauncher.Models;

namespace WhalesLauncher.Shell;

/// <summary>
/// 实例运行状态 → 中文标签与状态点样式键。
///
/// 存在理由：规范 §8.2 要求「状态不能只靠颜色表达」，所以状态文字与状态点是**成对**出现的；
/// 外壳左栏、P1 卡片、页头都需要同一份映射，各写一份必然漂移。
///
/// 归属说明：本文件在外壳写范围内（不在 <c>Services/</c>）。若 W-P1 也要用，
/// 由 Lead 决定是否提升到 <c>Services/</c> —— 这里先公开，避免第三份实现。
/// </summary>
public static class InstanceStateText
{
    /// <summary>
    /// 状态中文标签。未知取值**原样返回**（而不是显示"未知"）：
    /// 后端将来新增状态时应当在界面上立刻暴露出来，而不是被悄悄吞掉。
    /// </summary>
    public static string Label(string? state) => state switch
    {
        InstanceStateValues.Running => "运行中",
        InstanceStateValues.Starting => "启动中",
        InstanceStateValues.Stopping => "停止中",
        InstanceStateValues.Crashed => "已崩溃",
        InstanceStateValues.Stopped => "已停止",
        null or "" => "状态未知",
        _ => state,
    };

    /// <summary>
    /// 状态点样式键。样式定义在 <c>MainWindow.xaml</c> 的 <c>RootGrid.Resources</c>：
    /// 颜色写在 Style 的 Setter 里用 <c>{ThemeResource}</c> 求值 —— 若在 code-behind 里
    /// 直接取画刷对象，切换主题后状态点会停在旧主题的颜色（规范 §1.3 明令禁止）。
    /// </summary>
    public static string DotStyleKey(string? state) => state switch
    {
        InstanceStateValues.Running => "RailDotRunning",
        InstanceStateValues.Starting or InstanceStateValues.Stopping => "RailDotTransitional",
        InstanceStateValues.Crashed => "RailDotCrashed",
        _ => "RailDotStopped",
    };
}

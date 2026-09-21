using WhalesLauncher.Models;

namespace WhalesLauncher.Views.Detail;

/// <summary>
/// 运行态的界面映射（视觉规范 §9.2 的「状态映射」表，详情页页头复用同一套口径）。
///
/// 集中成一处的原因：状态 → 主按钮文案/可用性/忙碌态 是一个 5 分支的映射，
/// 列表页与详情页各写一份必然漂移（旧前端就有"卡片说运行中、详情页说已停止"这类问题）。
/// </summary>
public static class StatePresentation
{
    /// <summary>状态的中文标签。颜色之外必须有文字（规范 §8.2「颜色不是唯一信号」）。</summary>
    public static string Label(string? state) => state switch
    {
        InstanceStateValues.Starting => "启动中",
        InstanceStateValues.Running => "运行中",
        InstanceStateValues.Stopping => "停止中",
        InstanceStateValues.Crashed => "已崩溃",
        _ => "已停止",
    };

    /// <summary>状态 → 主操作呈现。</summary>
    public static StateAction For(string? state) => state switch
    {
        InstanceStateValues.Starting => new("启动中…", ActionEnabled: false, Busy: true),
        InstanceStateValues.Running => new("停止", ActionEnabled: true, Busy: false),
        InstanceStateValues.Stopping => new("停止中…", ActionEnabled: false, Busy: true),
        InstanceStateValues.Crashed => new("重新启动", ActionEnabled: true, Busy: false),
        _ => new("启动", ActionEnabled: true, Busy: false),
    };
}

/// <summary>主操作按钮的呈现（文案 / 是否可点 / 是否显示内联 <c>ProgressRing</c>）。</summary>
/// <param name="ActionText">按钮文字。</param>
/// <param name="ActionEnabled">按钮是否可点。</param>
/// <param name="Busy">是否显示内联忙碌环（规范 §6.6：按钮内联忙碌态）。</param>
public sealed record StateAction(string ActionText, bool ActionEnabled, bool Busy);

using System.ComponentModel;
using WhalesLauncher.Models;
using WhalesLauncher.Services;

namespace WhalesLauncher.Views.Detail;

/// <summary>
/// 存档列表的一行。
///
/// 为什么要包一层而不是直接绑 <see cref="SessionInfo"/>：规范 §9.5 要求「最近修改」按相对时间显示，
/// 且用**单一 1 秒定时器批量刷新可见行**。相对时间是「相对现在」算出来的字符串，
/// 模型里没有这个字段，也不能在 XAML 里调用带参函数（<c>x:Bind</c> 只支持属性路径与函数绑定到属性），
/// 因此在这里预计算成可通知的属性。
/// </summary>
public sealed class SessionRow : INotifyPropertyChanged
{
    private string _relativeText;

    public SessionRow(SessionInfo session)
    {
        Session = session;
        _relativeText = Formatters.FormatRelative(session.UpdatedAt);
    }

    public SessionInfo Session { get; }

    public string Id => Session.Id;

    public string WorkspaceKey => Session.WorkspaceKey;

    /// <summary>会话目录全文（ToolTip 用）。</summary>
    public string Dir => Session.Dir;

    /// <summary>
    /// 体积文本。<c>null</c> 显示 <c>—</c> 而不是 <c>0 B</c>：
    /// 规范 §9.5 明确要求区分「未知」与「空」（core 的 <c>dirSize</c> 不跟随 junction，会返回 0）。
    /// </summary>
    public string SizeText => Formatters.FormatBytes(Session.SizeBytes);

    /// <summary>最近修改（相对时间）。由 1 秒定时器批量刷新。</summary>
    public string RelativeText
    {
        get => _relativeText;
        private set
        {
            if (_relativeText == value) return;
            _relativeText = value;
            PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(RelativeText)));
        }
    }

    /// <summary>刷新为当前时刻的相对时间。</summary>
    public void Refresh(DateTimeOffset now) => RelativeText = Formatters.FormatRelative(Session.UpdatedAt, now);

    public event PropertyChangedEventHandler? PropertyChanged;
}

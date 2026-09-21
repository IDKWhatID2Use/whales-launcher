namespace WhalesLauncher.Models;

/// <summary>
/// dsh 随附模板 → 组合包列表（契约 <c>BUNDLE_TEMPLATES</c>，<c>src/shared/contracts.ts:705-711</c>）。
///
/// 建实例向导（Wizard）用它展示"这个模板会装上哪些组合包"，
/// 避免界面自己维护一份会与 core 漂移的清单。
/// </summary>
public static class BundleTemplates
{
    /// <summary>模板名 → 组合包名列表。</summary>
    public static readonly IReadOnlyDictionary<string, string[]> All =
        new Dictionary<string, string[]>(StringComparer.Ordinal)
        {
            ["web"] = new[] { "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app" },
            ["headless"] = new[] { "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless" },
            ["sdk"] = new[] { "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-sdk-app" },
            ["sdk-minimal"] = new[] { "@deepseek-ai/dsh-sdk-minimal" },
            ["acp"] = new[] { "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-acp-app" },
        };

    /// <summary>
    /// 模板名列表（顺序与契约声明一致，供下拉框直接绑定）。
    ///
    /// 单独列一份而不是取 <see cref="All"/>.Keys：字典的枚举顺序是实现细节，
    /// 而界面上的模板顺序应当稳定。
    /// </summary>
    public static readonly string[] Names = { "web", "headless", "sdk", "sdk-minimal", "acp" };

    /// <summary>取某模板的组合包列表；未知模板返回空数组（不抛错，界面照常渲染）。</summary>
    public static string[] BundlesOf(string? template) =>
        template is not null && All.TryGetValue(template, out var bundles) ? bundles : Array.Empty<string>();
}

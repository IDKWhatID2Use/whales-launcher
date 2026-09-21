namespace WhalesLauncher.Models;

/// <summary>
/// 契约里的 <c>SCHEMA_VERSION</c>（<c>src/shared/contracts.ts:13</c>）。
///
/// 出现在 <c>instance.json</c> / <c>launcher.json</c> / <c>ports.json</c> / 实例包的 schemaVersion 字段里。
/// 界面不做版本迁移（迁移是 Node 侧 core 的职责），这里只用于展示与断言。
/// </summary>
public static class SchemaVersion
{
    /// <summary>当前契约 schema 版本。</summary>
    public const int Current = 1;
}
